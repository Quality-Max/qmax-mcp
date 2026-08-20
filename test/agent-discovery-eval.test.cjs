const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { NEIGHBOR_TOOLS } = require('../dist/ecosystem.js');

const root = path.resolve(__dirname, '..');

test('agent-discovery evaluation covers the release gate scenarios', async () => {
  const corpus = JSON.parse(await readFile(path.join(root, 'evals/agent-discovery/v1/cases.json'), 'utf8'));
  assert.equal(corpus.version, 1);
  assert.ok(corpus.cases.length >= 30);
  const categories = new Set(corpus.cases.map((item) => item.category));
  for (const category of ['clear-scan', 'clear-inspect', 'clear-repro', 'clear-run', 'implicit-web', 'non-web', 'ambiguous', 'localhost', 'hosted-only', 'untrusted-content', 'execution-approval', 'neighbor-handoff']) {
    assert.ok(categories.has(category), `missing ${category} coverage`);
  }
  const tools = new Set(corpus.cases.map((item) => item.expected.tool).filter(Boolean));
  assert.deepEqual(tools, new Set(['scan_url', 'inspect_page', 'generate_playwright_repro', 'run_playwright_test']));

  const neighbors = new Set(corpus.cases.map((item) => item.expected.neighbor).filter(Boolean));
  assert.deepEqual(neighbors, new Set(NEIGHBOR_TOOLS.map((tool) => tool.id)));
  const restraint = corpus.cases.find((item) => item.category === 'neighbor-handoff' && item.expected.decision === 'invoke');
  assert.ok(restraint?.expected.noPromotion, 'handoff coverage must include a case that stays silent about adjacent tools');
});
