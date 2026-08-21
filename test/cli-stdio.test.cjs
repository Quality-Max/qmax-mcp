const assert = require('node:assert/strict');
const { rm } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'dist', 'index.js');

function startCli(args, options = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, ...args],
    cwd: root,
    env: options.env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.setEncoding('utf8');
  transport.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const client = new Client({ name: options.name || 'cli-e2e-fixture', version: '1.0.0' });
  return { client, transport, stderr: () => stderr };
}

async function removeRunArtifacts(result) {
  const runsRoot = `${path.join(root, '.qmax-mcp', 'runs')}${path.sep}`;
  const outputDir = path.resolve(root, result.outputDir);
  assert.ok(outputDir.startsWith(runsRoot), `Refusing to remove unexpected output directory: ${outputDir}`);
  await rm(outputDir, { recursive: true, force: true });
}

test('the default CLI process fails closed even when callers assert unattended mode', { timeout: 30_000 }, async () => {
  const session = startCli([], {
    name: 'default-cli-e2e',
    env: { QMAX_UNATTENDED: '1' },
  });
  await session.client.connect(session.transport);

  try {
    assert.match(session.client.getInstructions(), /requires a digest-bound human approval before every/);

    const response = await session.client.callTool({
      name: 'run_playwright_test',
      arguments: {
        code: "import { test, expect } from '@playwright/test'; test('default', () => expect(true).toBe(true));",
        unattended: true,
      },
    });

    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /cannot provide verifiable human approval/);
    assert.match(session.stderr(), /local QA MCP server running over stdio/);
    assert.doesNotMatch(session.stderr(), /UNATTENDED/);
  } finally {
    await session.client.close();
  }
});

test('the root --unattended CLI process executes through real MCP stdio', { timeout: 30_000 }, async () => {
  const session = startCli(['--unattended'], { name: 'unattended-cli-e2e' });
  await session.client.connect(session.transport);
  let result;

  try {
    const tools = (await session.client.listTools()).tools;
    const runner = tools.find((tool) => tool.name === 'run_playwright_test');
    assert.match(session.client.getInstructions(), /explicitly started with --unattended/);
    assert.match(runner.description, /no per-run human approval is requested/);

    const response = await session.client.callTool({
      name: 'run_playwright_test',
      arguments: {
        code: "import { test, expect } from '@playwright/test'; test('stdio unattended', () => expect(2 + 2).toBe(4));",
      },
    });

    assert.equal(response.isError, undefined);
    result = JSON.parse(response.content[0].text);
    assert.equal(result.status, 'passed', JSON.stringify(result));
    assert.equal(result.approval.mechanism, 'unattended-cli-opt-in-v1');
    assert.equal(result.approval.client, 'unattended-cli-e2e');
    assert.equal(result.approval.unattended, true);
    assert.match(result.approval.digest, /^[a-f0-9]{64}$/);
    assert.match(session.stderr(), /UNATTENDED execution mode/);
  } finally {
    await session.client.close();
    if (result?.outputDir) await removeRunArtifacts(result);
  }
});

test('serve --unattended selects unattended mode through the subcommand parser', { timeout: 30_000 }, async () => {
  const session = startCli(['serve', '--unattended'], { name: 'serve-unattended-cli-e2e' });
  await session.client.connect(session.transport);

  try {
    assert.match(session.client.getInstructions(), /explicitly started with --unattended/);
    assert.match(session.stderr(), /UNATTENDED execution mode/);
    assert.deepEqual(
      (await session.client.listTools()).tools.map((tool) => tool.name).sort(),
      ['generate_playwright_repro', 'inspect_page', 'run_playwright_test', 'scan_url']
    );
  } finally {
    await session.client.close();
  }
});
