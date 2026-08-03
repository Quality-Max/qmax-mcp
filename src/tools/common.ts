import { mkdir, writeFile } from 'node:fs/promises';
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

export async function withPage<T>(
  options: {
    url: string;
    viewport?: Viewport;
    browser?: 'chromium' | 'firefox' | 'webkit';
    headed?: boolean;
    allowPrivateNetwork?: boolean;
  },
  fn: (page: Page, browser: Browser) => Promise<T>
): Promise<T> {
  const initialUrl = await assertSafeNetworkUrl(options.url, { allowPrivateNetwork: options.allowPrivateNetwork });
  const browser = await browserType(options.browser).launch({ headless: !options.headed });
  try {
    const context = await browser.newContext({ viewport: options.viewport ?? DEFAULT_VIEWPORT });
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
