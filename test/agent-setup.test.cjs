const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const packageCommand = ['-y', '@qualitymax/qmax-mcp'];

async function readJson(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8').then(JSON.parse);
}

function assertLocalServer(server) {
  assert.deepEqual(server, {
    command: 'npx',
    args: packageCommand,
  });
}

test('agent setup JSON fixtures use the canonical local-first package command', async () => {
  const [claude, cursor, generic, vscode] = await Promise.all([
    readJson('examples/agent-setup/claude/.mcp.json'),
    readJson('examples/agent-setup/cursor/.cursor/mcp.json'),
    readJson('examples/agent-setup/generic/mcp.json'),
    readJson('examples/agent-setup/vscode/.vscode/mcp.json'),
  ]);

  assertLocalServer(claude.mcpServers.qmax);
  assertLocalServer(cursor.mcpServers.qmax);
  assertLocalServer(generic.mcpServers.qmax);
  assert.deepEqual(vscode.servers.qmax, {
    type: 'stdio',
    command: 'npx',
    args: packageCommand,
  });
});

test('agent instructions require evidence and preserve the approval boundary', async () => {
  const files = [
    'AGENTS.md',
    'examples/agent-setup/claude/CLAUDE.md',
    'examples/agent-setup/cursor/.cursor/rules/qualitymax-qa.mdc',
    'examples/agent-setup/codex/AGENTS.md',
    'examples/agent-setup/vscode/.github/copilot-instructions.md',
  ];
  const instructions = await Promise.all(files.map((file) => readFile(path.join(root, file), 'utf8')));

  for (const instruction of instructions) {
    assert.match(instruction, /scan_url|inspect_page/);
    assert.match(instruction, /evidence/i);
    assert.match(instruction, /failure/i);
    assert.match(instruction, /approval/i);
    assert.match(instruction, /assertion/i);
    assert.match(instruction, /allowPrivateNetwork: true/);
    assert.match(instruction, /caller-side consent/i);
    assert.match(instruction, /hosted\s+QualityMax/i);
    assert.match(instruction, /web-verification request/i);
    assert.match(instruction, /concise clarification/i);
    assert.match(instruction, /unrelated work/i);
  }
});

test('Codex fixture has the supported stdio MCP configuration shape', async () => {
  const config = await readFile(path.join(root, 'examples/agent-setup/codex/.codex/config.toml'), 'utf8');

  assert.match(config, /^\[mcp_servers\.qmax\]$/m);
  assert.match(config, /^command = "npx"$/m);
  assert.match(config, /^args = \["-y", "@qualitymax\/qmax-mcp"\]$/m);
  assert.doesNotMatch(config, /env\s*=/);
});
