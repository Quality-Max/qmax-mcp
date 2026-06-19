import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { writeTempFile } from './common';

export type RunPlaywrightTestArgs = {
  testPath?: string;
  code?: string;
  baseUrl?: string;
  browser?: 'chromium' | 'firefox' | 'webkit';
  headed?: boolean;
  timeoutMs?: number;
};

export async function runPlaywrightTest(args: RunPlaywrightTestArgs) {
  if (!args.testPath && !args.code) {
    throw new Error('Provide either testPath or code');
  }

  const testPath = path.resolve(args.testPath ?? (await writeTempFile('qmax-inline-test', 'spec.ts', args.code || '')));
  const outputDir = await mkdtemp(path.join(tmpdir(), 'qmax-playwright-'));
  const configPath = path.join(outputDir, 'playwright.config.cjs');

  await writeFile(
    configPath,
    `module.exports = {
  testDir: ${JSON.stringify(path.dirname(testPath))},
  timeout: ${Math.min(Math.max(args.timeoutMs ?? 60_000, 1_000), 300_000)},
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

  const result = await runCommand('npx', [
    'playwright',
    'test',
    testPath,
    '--config',
    configPath,
    '--project',
    args.browser ?? 'chromium',
    ...(args.headed ? ['--headed'] : []),
  ], {
    BASE_URL: args.baseUrl ?? '',
    NODE_PATH: dependencyNodePath(),
  });

  const parsed = parseJsonReporter(result.stdout);
  return {
    status: result.exitCode === 0 ? 'passed' : 'failed',
    exitCode: result.exitCode,
    testPath,
    outputDir,
    summary: summarizeReporter(parsed),
    stdout: result.stdout.slice(-20_000),
    stderr: result.stderr.slice(-20_000),
  };
}

function dependencyNodePath(): string {
  const require = createRequire(__filename);
  const packageJson = require.resolve('@playwright/test/package.json');
  return path.dirname(path.dirname(path.dirname(packageJson)));
}

function runCommand(cmd: string, args: string[], env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
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
  const root = report as {
    stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number };
    suites?: Array<{ specs?: Array<{ title?: string; ok?: boolean; tests?: Array<{ results?: Array<{ status?: string; error?: unknown }> }> }> }>;
  };
  const failures: unknown[] = [];
  for (const suite of root.suites || []) {
    for (const spec of suite.specs || []) {
      if (spec.ok) continue;
      failures.push({
        title: spec.title,
        results: spec.tests?.flatMap((test) => test.results || []).map((item) => ({ status: item.status, error: item.error })),
      });
    }
  }
  return {
    stats: root.stats,
    failures,
  };
}
