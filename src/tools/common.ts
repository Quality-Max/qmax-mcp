import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright';
import { assertSafeNetworkUrl, type NetworkPolicyOptions } from './network-policy';

export type Viewport = {
  width: number;
  height: number;
};

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type Finding = {
  severity: Severity;
  category: string;
  message: string;
  evidence?: unknown;
  url?: string;
  selector?: string;
  suggestion?: string;
  /** Copy-paste, verifiable reproduction step (curl one-liner or DevTools steps). */
  repro?: string;
};

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export function gradeFromScore(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export const DEFAULT_VIEWPORT: Viewport = { width: 1366, height: 900 };

export function validateHttpUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must use http or https');
  }
  return parsed.toString();
}

export function browserType(name = 'chromium'): BrowserType {
  if (name === 'firefox') return firefox;
  if (name === 'webkit') return webkit;
  return chromium;
}

export function browserContextOptions(viewport?: Viewport) {
  return { viewport: viewport ?? DEFAULT_VIEWPORT, serviceWorkers: 'block' as const };
}

export async function withPage<T>(
  options: {
    url: string;
    viewport?: Viewport;
    browser?: 'chromium' | 'firefox' | 'webkit';
    headed?: boolean;
    allowPrivateNetwork?: boolean;
    storageStatePath?: string;
    acknowledgePrivateContent?: boolean;
  },
  fn: (page: Page, browser: Browser) => Promise<T>
): Promise<T> {
  const initialUrl = await assertSafeNetworkUrl(options.url, { allowPrivateNetwork: options.allowPrivateNetwork });
  if (options.storageStatePath && options.acknowledgePrivateContent !== true) {
    throw new Error(
      'Authenticated inspection requires acknowledgePrivateContent:true because the result may contain private page content.'
    );
  }
  const storageStatePath = options.storageStatePath
    ? await resolveWorkspaceStorageStatePath(options.storageStatePath)
    : undefined;
  const browser = await browserType(options.browser).launch({ headless: !options.headed });
  try {
    let context: BrowserContext;
    try {
      context = await browser.newContext({
        ...browserContextOptions(options.viewport),
        ...(storageStatePath ? { storageState: storageStatePath } : {}),
      });
    } catch (error) {
      if (storageStatePath) {
        throw new Error('storageStatePath must contain valid Playwright storage-state JSON.');
      }
      throw error;
    }
    await enforceBrowserNetworkPolicy(context, {
      allowPrivateNetwork: options.allowPrivateNetwork,
      privateNetworkOrigin: initialUrl.origin,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(validateHttpUrl(options.url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return await fn(page, browser);
  } finally {
    await browser.close();
  }
}

const MAX_STORAGE_STATE_BYTES = 10 * 1024 * 1024;

/** Resolve a caller-selected Playwright auth state without allowing reads outside the workspace. */
export async function resolveWorkspaceStorageStatePath(requestedPath: string): Promise<string> {
  if (path.isAbsolute(requestedPath)) {
    throw new Error('storageStatePath must be relative to the active workspace.');
  }

  const workspaceRoot = await realpath(process.cwd());
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(workspaceRoot, requestedPath));
  } catch {
    throw new Error('storageStatePath must name an existing workspace file.');
  }
  assertWithin(workspaceRoot, resolved, 'storageStatePath escapes the active workspace.');
  let metadata;
  try {
    metadata = await stat(resolved);
  } catch {
    throw new Error('storageStatePath must name an existing workspace file.');
  }
  if (!metadata.isFile()) {
    throw new Error('storageStatePath must name a regular file.');
  }
  if (metadata.size > MAX_STORAGE_STATE_BYTES) {
    throw new Error('storageStatePath exceeds the 10 MB safety limit.');
  }
  return resolved;
}

export async function enforceBrowserNetworkPolicy(
  context: Pick<BrowserContext, 'route' | 'routeWebSocket'>,
  options: NetworkPolicyOptions
): Promise<void> {
  await context.route('**/*', async (route) => {
    try {
      await assertSafeNetworkUrl(route.request().url(), options);
      await route.continue();
    } catch {
      await route.abort('blockedbyclient');
    }
  });
  await context.routeWebSocket('**/*', async (webSocket) => {
    try {
      await assertSafeNetworkUrl(webSocket.url(), options);
      webSocket.connectToServer();
    } catch {
      await webSocket.close({ code: 1008, reason: 'Blocked by local safety policy.' });
    }
  });
}

export async function writeTempFile(prefix: string, extension: string, content: string): Promise<string> {
  const dir = path.join(tmpdir(), 'qmax-mcp');
  await mkdir(dir, { recursive: true });
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'artifact';
  const file = path.join(dir, `${safePrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`);
  await writeFile(file, content, 'utf8');
  return file;
}

export function scoreFromFindings(findings: Finding[]): number {
  const weights: Record<Severity, number> = {
    critical: 35,
    high: 20,
    medium: 10,
    low: 4,
    info: 0,
  };
  const penalty = findings.reduce((sum, finding) => sum + weights[finding.severity], 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

export function cssEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function assertWithin(root: string, candidate: string, message: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}
