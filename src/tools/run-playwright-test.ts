import { spawn } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

export type RunPlaywrightTestArgs = {
  testPath?: string;
  code?: string;
  baseUrl?: string;
  browser?: 'chromium' | 'firefox' | 'webkit';
  headed?: boolean;
  timeoutMs?: number;
  wallClockTimeoutMs?: number;
  allowedEnv?: Record<string, string>;
  /** Explicit acknowledgement required before supplied code is executed. */
  executionAcknowledged?: boolean;
};

export type RunPlaywrightTestOptions = {
  signal?: AbortSignal;
};

const RESERVED_ENVIRONMENT_KEYS = new Set(['BASE_URL', 'NODE_PATH', 'PATH', 'TMP', 'TEMP', 'TMPDIR']);
const MAX_CAPTURED_OUTPUT = 200_000;

export async function runPlaywrightTest(args: RunPlaywrightTestArgs, options: RunPlaywrightTestOptions = {}) {
  if (!args.testPath && !args.code) {
    throw new Error('Provide either testPath or code');
  }
  if (args.executionAcknowledged !== true) {
    throw new Error('run_playwright_test requires explicit executionAcknowledged: true.');
  }

  const workspaceRoot = await realpath(process.cwd());
  const outputDir = await createRunDirectory(workspaceRoot);
  const testPath = args.testPath
    ? await resolveWorkspaceTestPath(workspaceRoot, args.testPath)
    : await writeInlineTest(outputDir, args.code || '');
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
    testPath: toWorkspaceRelative(workspaceRoot, testPath),
    outputDir: toWorkspaceRelative(workspaceRoot, outputDir),
    summary: summarizeReporter(parsed),
    stdout: safeRunnerStream(result.stdout, 'stdout'),
    stderr: safeRunnerStream(result.stderr, 'stderr'),
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

async function writeInlineTest(outputDir: string, code: string): Promise<string> {
  const testPath = path.join(outputDir, 'inline.spec.ts');
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
