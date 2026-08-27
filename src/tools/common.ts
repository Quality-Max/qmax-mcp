import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
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
  /** How many times this exact finding was observed. Absent means once. */
  occurrences?: number;
  /** Stable identity for this problem across runs. See `findingFingerprint`. */
  id?: string;
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

/**
 * Resolve a caller-selected workspace file without allowing reads outside the
 * workspace.
 *
 * Every caller-supplied path the server reads goes through here: the auth state,
 * and the scan baseline. A second path input reaching the filesystem on its own
 * terms is how traversal and symlink escapes get reintroduced one feature at a
 * time, so the guard takes the label rather than the check being copied.
 */
async function resolveWorkspaceFile(requestedPath: string, label: string, maxBytes: number): Promise<string> {
  if (path.isAbsolute(requestedPath)) {
    throw new Error(`${label} must be relative to the active workspace.`);
  }

  const workspaceRoot = await realpath(process.cwd());
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(workspaceRoot, requestedPath));
  } catch {
    throw new Error(`${label} must name an existing workspace file.`);
  }
  assertWithin(workspaceRoot, resolved, `${label} escapes the active workspace.`);
  let metadata;
  try {
    metadata = await stat(resolved);
  } catch {
    throw new Error(`${label} must name an existing workspace file.`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${label} must name a regular file.`);
  }
  if (metadata.size > maxBytes) {
    throw new Error(`${label} exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB safety limit.`);
  }
  return resolved;
}

/** Resolve a caller-selected Playwright auth state without allowing reads outside the workspace. */
export async function resolveWorkspaceStorageStatePath(requestedPath: string): Promise<string> {
  return await resolveWorkspaceFile(requestedPath, 'storageStatePath', MAX_STORAGE_STATE_BYTES);
}

const MAX_BASELINE_BYTES = 10 * 1024 * 1024;

/**
 * Load a previous scan result to compare against.
 *
 * A baseline is just an earlier result, so it can be handed over inline by a
 * caller that still holds one or named as a workspace file by a pipeline that
 * persisted one. The file path is confined exactly as the auth state is.
 */
export async function loadBaselineFindings(baseline: string | { findings?: unknown }): Promise<Finding[]> {
  let parsed: unknown = baseline;
  if (typeof baseline === 'string') {
    const resolved = await resolveWorkspaceFile(baseline, 'baseline', MAX_BASELINE_BYTES);
    try {
      parsed = JSON.parse(await readFile(resolved, 'utf8'));
    } catch {
      throw new Error('baseline must contain the JSON result of a previous scan.');
    }
  }

  const findings = (parsed as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(findings)) {
    throw new Error('baseline must contain the JSON result of a previous scan, including its findings array.');
  }
  return findings as Finding[];
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

/**
 * Collapse repeated observations of the same problem into one finding.
 *
 * A page that fires the same doomed request three times used to produce three
 * byte-identical findings — and, because the score charges a penalty per
 * finding, one misconfigured SDK firing on every render cost 3× the identical
 * misconfiguration firing once. Findings that agree on severity, category,
 * message, URL, and selector describe one problem, so they become one finding
 * whose `occurrences` says how often it was seen. The first observation keeps
 * its evidence and repro; the count is the only thing repetition adds.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const finding of findings) {
    const key = JSON.stringify([finding.severity, finding.category, finding.message, finding.url, finding.selector]);
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrences = (existing.occurrences ?? 1) + 1;
    } else {
      byKey.set(key, { ...finding });
    }
  }
  return Array.from(byKey.values());
}

/**
 * A stable identity for a problem, so the same problem hashes the same across
 * runs and two scans can be compared by machine.
 *
 * Severity is deliberately excluded. A finding whose severity is reclassified —
 * as prefetch aborts were, from medium to info — is still the same problem, and
 * a diff that reported it as one finding fixed and another appearing would be
 * describing a change nobody made. `occurrences` is excluded for the same
 * reason: seeing a problem four times instead of three is not a different
 * problem.
 *
 * The message is compared verbatim apart from whitespace and case, which means
 * a finding that embeds a count ("6 render-blocking resources") gets a new
 * identity when that count moves. That is the conservative direction: it shows
 * up as one fixed and one new rather than silently reporting "unchanged" for a
 * finding whose text no longer matches.
 */
export function findingFingerprint(finding: Pick<Finding, 'category' | 'message' | 'url' | 'selector'>): string {
  const normalize = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const material = JSON.stringify([
    normalize(finding.category),
    normalize(finding.message),
    normalize(finding.url),
    normalize(finding.selector),
  ]);
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

/** Attach a fingerprint to every finding that does not already carry one. */
export function withFingerprints(findings: Finding[]): Finding[] {
  return findings.map((finding) => ({ ...finding, id: finding.id ?? findingFingerprint(finding) }));
}

export type FindingDelta = {
  fixed: Finding[];
  new: Finding[];
  unchanged: Finding[];
  /** One line a human or a CI log can read without opening the arrays. */
  verdict: string;
};

/**
 * Compare a scan against a baseline scan of the same URL.
 *
 * The workflow `scan_url` is documented for — scan, change something, scan
 * again, decide — is a comparison, and doing it by eye across two JSON blobs
 * makes "did my change introduce anything new?" depend on the reader's
 * diligence. It also blocks CI: a pipeline can gate on "new findings since
 * baseline" but not on "findingCount > 0" once known-benign findings exist.
 */
export function diffFindings(current: Finding[], baseline: Finding[]): FindingDelta {
  const currentById = new Map(withFingerprints(current).map((finding) => [finding.id as string, finding]));
  const baselineById = new Map(withFingerprints(baseline).map((finding) => [finding.id as string, finding]));

  const fresh = [...currentById].filter(([id]) => !baselineById.has(id)).map(([, finding]) => finding);
  const unchanged = [...currentById].filter(([id]) => baselineById.has(id)).map(([, finding]) => finding);
  const fixed = [...baselineById].filter(([id]) => !currentById.has(id)).map(([, finding]) => finding);

  const count = (items: Finding[], noun: string) => `${items.length} ${noun}${items.length === 1 ? '' : 's'}`;
  const verdict =
    fresh.length === 0
      ? `No new findings since baseline${fixed.length > 0 ? `; ${count(fixed, 'finding')} fixed` : ''}.`
      : `${count(fresh, 'new finding')} since baseline${fixed.length > 0 ? `, ${count(fixed, 'finding')} fixed` : ''}.`;

  return { fixed, new: fresh, unchanged, verdict };
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
