import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';

export type RunPlaywrightTestArgs = {
  testPath?: string;
  code?: string;
  baseUrl?: string;
  browser?: 'chromium' | 'firefox' | 'webkit';
  headed?: boolean;
  timeoutMs?: number;
  wallClockTimeoutMs?: number;
  allowedEnv?: Record<string, string>;
};

export type RunPlaywrightTestOptions = {
  signal?: AbortSignal;
  /** Digest returned by the server's selected execution-authorization mode. */
  approvalDigest?: string;
};

export type ExecutionApprovalSummary = {
  digest: string;
  target: string;
  source: 'inline code' | 'local test file';
};

const RESERVED_ENVIRONMENT_KEYS = new Set(['BASE_URL', 'NODE_PATH', 'PATH', 'TMP', 'TEMP', 'TMPDIR']);
const MAX_CAPTURED_OUTPUT = 200_000;

export async function runPlaywrightTest(args: RunPlaywrightTestArgs, options: RunPlaywrightTestOptions = {}) {
  if (!args.testPath && !args.code) {
    throw new Error('Provide either testPath or code');
  }
  if (!options.approvalDigest) {
    throw new Error('run_playwright_test requires a server-issued execution authorization record.');
  }

  const workspaceRoot = await realpath(process.cwd());
  const approval = await describeExecutionApproval(args, workspaceRoot);
  if (approval.digest !== options.approvalDigest) {
    throw new Error('The test changed after execution authorization; authorize the changed test again.');
  }

  const outputDir = await createRunDirectory(workspaceRoot);
  const testPath = await writeApprovedTest(outputDir, approval.sourceCode);
  const configPath = path.join(outputDir, 'playwright.config.cjs');
  const testTimeout = Math.min(Math.max(args.timeoutMs ?? 60_000, 1_000), 300_000);

  await writeFile(
    configPath,
    `module.exports = {
  testDir: ${JSON.stringify(path.dirname(testPath))},
  timeout: ${testTimeout},
  use: {
    baseURL: process.env.BASE_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  reporter: [['json']],
  outputDir: ${JSON.stringify(path.join(outputDir, 'artifacts'))},
};
`,
    'utf8'
  );

  const result = await runCommand(
    'npx',
    [
      'playwright',
      'test',
      testPath,
      '--config',
      configPath,
      '--project',
      args.browser ?? 'chromium',
      ...(args.headed ? ['--headed'] : []),
    ],
    createChildEnvironment(args),
    {
      timeoutMs: Math.min(Math.max(args.wallClockTimeoutMs ?? testTimeout + 30_000, 1_000), 330_000),
      signal: options.signal,
    }
  );

  const parsed = parseJsonReporter(result.stdout);
  return {
    status: result.exitCode === 0 ? 'passed' : result.timedOut ? 'timed_out' : result.aborted ? 'cancelled' : 'failed',
    exitCode: result.exitCode,
    testPath: approval.target,
    executedSnapshot: toWorkspaceRelative(workspaceRoot, testPath),
    outputDir: toWorkspaceRelative(workspaceRoot, outputDir),
    summary: summarizeReporter(parsed),
    stdout: safeRunnerStream(result.stdout, 'stdout'),
    stderr: safeRunnerStream(result.stderr, 'stderr'),
  };
}


/**
 * Reject a test that imports from a relative path, before anything is executed.
 *
 * The runner snapshots the *source* into an isolated directory and runs it under
 * a generated config, so `./helpers` no longer resolves — the test fails to load
 * rather than failing an assertion, and the error names a temp path that means
 * nothing to the caller. The tool description says it can execute "a local test
 * file", which reads as "a spec from my project", so this is a very easy mistake
 * to make; failing here says why, once, instead of leaving a module-not-found to
 * be decoded.
 */
export function assertSelfContainedTest(sourceCode: string): void {
  const relativeImports = new Set<string>();
  const patterns = [
    /\bfrom\s+['"](\.[^'"]*)['"]/g,
    /\bimport\s+['"](\.[^'"]*)['"]/g,
    /\brequire\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of sourceCode.matchAll(pattern)) relativeImports.add(match[1]);
  }
  if (relativeImports.size === 0) return;

  throw new Error(
    `This test imports from a relative path (${Array.from(relativeImports).join(', ')}), ` +
      'which will not resolve: the runner executes a snapshot of the source in an isolated ' +
      'directory under a generated Playwright config, so the workspace\'s own modules and ' +
      'playwright.config are not available. Inline what the test needs, or run it directly ' +
      'with your project config.'
  );
}

/**
 * Create an authorization subject from every execution-affecting input. The
 * server authorizes this digest using its startup-selected mode, then the
 * runner recomputes it before launching a child. This prevents a caller from
 * substituting another payload after authorization.
 */
export async function describeExecutionApproval(
  args: RunPlaywrightTestArgs,
  workspaceRoot?: string
): Promise<ExecutionApprovalSummary & { sourceCode: string }> {
  if (!args.testPath && !args.code) {
    throw new Error('Provide either testPath or code');
  }

  const resolvedWorkspaceRoot = workspaceRoot ?? (await realpath(process.cwd()));
  const sourcePath = args.testPath ? await resolveWorkspaceTestPath(resolvedWorkspaceRoot, args.testPath) : undefined;
  const sourceCode = sourcePath ? await readFile(sourcePath, 'utf8') : args.code || '';
  assertSelfContainedTest(sourceCode);
  const target = sourcePath ? toWorkspaceRelative(resolvedWorkspaceRoot, sourcePath) : 'inline Playwright test';
  const input = {
    target,
    sourceCode,
    baseUrl: args.baseUrl || '',
    browser: args.browser || 'chromium',
    headed: args.headed === true,
    timeoutMs: args.timeoutMs ?? 60_000,
    wallClockTimeoutMs: args.wallClockTimeoutMs ?? (args.timeoutMs ?? 60_000) + 30_000,
    allowedEnv: args.allowedEnv || {},
  };
  const digest = createHash('sha256').update(stableStringify(input)).digest('hex');
  return {
    digest,
    target,
    source: sourcePath ? 'local test file' : 'inline code',
    sourceCode,
  };
}

export function createChildEnvironment(args: RunPlaywrightTestArgs): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: process.env.PATH || '',
    NODE_PATH: dependencyNodePath(),
    BASE_URL: args.baseUrl || '',
    TMPDIR: tmpdir(),
    QMAX_MCP_RUNNER: '1',
  };

  if (process.platform === 'win32') {
    environment.SYSTEMROOT = process.env.SYSTEMROOT || 'C:\\Windows';
    environment.ComSpec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  }

  for (const [key, value] of Object.entries(args.allowedEnv || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || RESERVED_ENVIRONMENT_KEYS.has(key)) {
      throw new Error(`allowedEnv contains an invalid or reserved variable name: ${key}`);
    }
    environment[key] = value;
  }
  return environment;
}

async function createRunDirectory(workspaceRoot: string): Promise<string> {
  const root = path.join(workspaceRoot, '.qmax-mcp', 'runs');
  await mkdir(root, { recursive: true });
  const resolvedRoot = await realpath(root);
  assertWithin(workspaceRoot, resolvedRoot, 'The controlled run directory resolves outside the workspace.', true);
  const directory = path.join(resolvedRoot, `run-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory);
  return directory;
}

async function resolveWorkspaceTestPath(workspaceRoot: string, requestedPath: string): Promise<string> {
  if (path.isAbsolute(requestedPath)) {
    throw new Error('testPath must be relative to the active workspace.');
  }
  const resolved = await realpath(path.resolve(workspaceRoot, requestedPath));
  assertWithin(workspaceRoot, resolved, 'testPath escapes the active workspace.');
  return resolved;
}

async function writeApprovedTest(outputDir: string, code: string): Promise<string> {
  const testPath = path.join(outputDir, 'approved.spec.ts');
  await writeFile(testPath, code, 'utf8');
  return testPath;
}

function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  assertWithin(workspaceRoot, absolutePath, 'A runner path escaped the active workspace.', true);
  return path.relative(workspaceRoot, absolutePath).split(path.sep).join('/');
}

function dependencyNodePath(): string {
  const require = createRequire(__filename);
  const packageJson = require.resolve('@playwright/test/package.json');
  return path.dirname(path.dirname(path.dirname(packageJson)));
}

export function runCommand(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const child = spawn(cmd, args, {
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (exitCode: number, extraStderr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ exitCode, stdout, stderr: `${stderr}${extraStderr}`, timedOut, aborted });
    };
    const terminate = (reason: 'timed_out' | 'aborted') => {
      if (settled) return;
      timedOut = reason === 'timed_out';
      aborted = reason === 'aborted';
      void terminateProcessTree(child.pid);
      const label = timedOut ? 'Child process exceeded the wall-clock timeout.' : 'Child process cancelled.';
      setTimeout(() => finish(timedOut ? 124 : 130, `\n${label}\n`), 250).unref();
    };
    const abort = () => terminate('aborted');
    const timer = setTimeout(() => terminate('timed_out'), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString());
    });
    child.once('error', (error) => finish(1, `\n${error.message}\n`));
    child.once('close', (code) => finish(code ?? (timedOut ? 124 : aborted ? 130 : 1)));
  });
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('close', () => resolve());
      killer.once('error', () => resolve());
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The complete process group exited after SIGTERM.
    }
  }, 1_000).unref();
}

function appendBounded(previous: string, next: string): string {
  const combined = previous + next;
  return combined.length > MAX_CAPTURED_OUTPUT ? combined.slice(-MAX_CAPTURED_OUTPUT) : combined;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:access[_-]?token|api[_-]?key|auth(?:orization)?|client[_-]?secret|password|secret|token)=[^&#\s]*)/gi, (match) => {
      const separator = match.indexOf('=');
      return `${match.slice(0, separator + 1)}[REDACTED]`;
    })
    .replace(/\b((?:access[_-]?token|api[_-]?key|auth(?:orization)?|client[_-]?secret|password|secret|token)[A-Za-z0-9_-]*)=([^\s&]+)/gi, '$1=[REDACTED]')
    .replace(/\b(Bearer)\s+[^\s"']+/gi, '$1 [REDACTED]');
}

/**
 * Runner code is user supplied, so arbitrary stdout/stderr cannot be proven
 * secret-free by recognizing a few credential patterns. Keep the artifacts
 * local and return only an explicit, content-free indicator over MCP.
 */
export function safeRunnerStream(value: string, stream: 'stdout' | 'stderr'): string {
  return value ? `[${stream} captured locally and withheld from the MCP response.]` : '';
}

/** Recursively redact returned page/test data without changing its shape. */
export function redactSensitiveData(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactSensitiveData);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSensitiveData(item)]));
  }
  return value;
}

function parseJsonReporter(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function summarizeReporter(report: unknown) {
  if (!report || typeof report !== 'object') return undefined;
  const stats = (report as { stats?: Record<string, unknown> }).stats;
  if (!stats || typeof stats !== 'object') return undefined;
  const safeStats: Record<string, number> = {};
  for (const key of ['expected', 'unexpected', 'skipped', 'flaky']) {
    const value = stats[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      safeStats[key] = value;
    }
  }
  return { stats: safeStats };
}

function assertWithin(root: string, candidate: string, message: string, allowRoot = false): void {
  const relative = path.relative(root, candidate);
  if ((!allowRoot && !relative) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
