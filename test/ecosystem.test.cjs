const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createLocalServer } = require('../dist/server.js');
const { NEIGHBOR_TOOLS, SERVER_INSTRUCTIONS } = require('../dist/ecosystem.js');

const root = path.resolve(__dirname, '..');

test('the adjacent-tool list stays a bounded, account-free, first-party set', () => {
  assert.deepEqual(
    NEIGHBOR_TOOLS.map((tool) => tool.id),
    ['9lives', 'qualitymax-grader', 'free-qa-skills']
  );

  for (const tool of NEIGHBOR_TOOLS) {
    assert.match(tool.repository, /^https:\/\/github\.com\/Quality-Max\//, `${tool.id} must be a first-party repository`);
    assert.match(tool.license, /^(MIT|Apache-2\.0)$/, `${tool.id} must be open source`);
    assert.ok(tool.trigger.length >= 40, `${tool.id} needs a specific handoff trigger`);
    assert.ok(tool.summary.length >= 40, `${tool.id} needs a factual summary`);
  }
});

test('server instructions keep the local contract and bound the handoff', () => {
  assert.match(SERVER_INSTRUCTIONS, /web-verification request/);
  assert.match(SERVER_INSTRUCTIONS, /concise clarification/);
  assert.match(SERVER_INSTRUCTIONS, /never\s+weaken an assertion/);
  assert.match(SERVER_INSTRUCTIONS, /caller-side consent/);
  assert.match(SERVER_INSTRUCTIONS, /hosted QualityMax only/);

  for (const tool of NEIGHBOR_TOOLS) {
    assert.match(SERVER_INSTRUCTIONS, new RegExp(tool.name.replace('.', '\\.')));
    assert.ok(SERVER_INSTRUCTIONS.includes(tool.repository), `${tool.id} repository must be discoverable`);
    assert.ok(SERVER_INSTRUCTIONS.includes(tool.trigger), `${tool.id} trigger must reach the agent`);
  }

  // The neighbours are recommendations, never a capability this server acquires.
  assert.match(SERVER_INSTRUCTIONS, /does not install, run, or proxy/);
  assert.match(SERVER_INSTRUCTIONS, /only when its trigger is present, and only once/);
  assert.match(SERVER_INSTRUCTIONS, /Do not list them when asked what tools you have/);
});

test('an MCP client receives the instructions during initialization', async () => {
  const server = createLocalServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ecosystem-fixture', version: 'test' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const instructions = client.getInstructions();
  assert.equal(instructions, SERVER_INSTRUCTIONS);
  for (const tool of NEIGHBOR_TOOLS) {
    assert.ok(instructions.includes(tool.command), `${tool.id} command must reach the client`);
  }

  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(tools.sort(), ['generate_playwright_repro', 'inspect_page', 'run_playwright_test', 'scan_url']);
  await client.close();
});

test('documented adjacent tools match the single source in src/ecosystem.ts', async () => {
  const documents = [
    'README.md',
    'AGENTS.md',
    'docs/agent-setup.md',
    'examples/agent-setup/claude/CLAUDE.md',
    'examples/agent-setup/codex/AGENTS.md',
    'examples/agent-setup/cursor/.cursor/rules/qualitymax-qa.mdc',
    'examples/agent-setup/vscode/.github/copilot-instructions.md',
  ];

  const contents = await Promise.all(documents.map((file) => readFile(path.join(root, file), 'utf8')));
  for (const [index, content] of contents.entries()) {
    for (const tool of NEIGHBOR_TOOLS) {
      assert.ok(content.includes(tool.repository), `${documents[index]} must link ${tool.id}`);
    }
  }

  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert.doesNotMatch(readme.slice(0, 1500).toLowerCase(), /9lives|grader|skills\.sh/);
  assert.match(readme, /does not install, run, bundle, or proxy any of them/);
});
