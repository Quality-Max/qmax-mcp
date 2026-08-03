const assert = require('node:assert/strict');
const { access, readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('README leads with the agent-first local QA promise and canonical command', async () => {
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  const opening = readme.slice(0, 900).toLowerCase();

  assert.match(readme, /npx -y @qualitymax\/qmax-mcp/);
  assert.match(opening, /independent qa evidence before it declares a web change done/);
  assert.match(opening, /require no qualitymax account/);
  assert.doesNotMatch(opening, /9lives/);
  for (const tool of ['scan_url', 'inspect_page', 'generate_playwright_repro', 'run_playwright_test']) {
    assert.match(readme, new RegExp(`\\\`${tool}\\\``));
  }
});

test('launch kit keeps reproducible proof, safety, comparison, and disclosure assets linked', async () => {
  const assets = [
    'demo/app/index.html',
    'demo/run.mjs',
    'demo/record.mjs',
    'demo/scan-to-repro.cast',
    'demo/quality-receipt.example.json',
    'demo/quality-receipt.example.md',
    'demo/README.md',
    'docs/launch/architecture.svg',
    'docs/launch/competitor-comparison.md',
    'docs/launch/launch-checklist.md',
  ];
  await Promise.all(assets.map((asset) => access(path.join(root, asset))));

  const [demo, comparison, checklist, jsonReceipt, markdownReceipt] = await Promise.all([
    readFile(path.join(root, 'demo/README.md'), 'utf8'),
    readFile(path.join(root, 'docs/launch/competitor-comparison.md'), 'utf8'),
    readFile(path.join(root, 'docs/launch/launch-checklist.md'), 'utf8'),
    readFile(path.join(root, 'demo/quality-receipt.example.json'), 'utf8'),
    readFile(path.join(root, 'demo/quality-receipt.example.md'), 'utf8'),
  ]);
  assert.match(demo, /dependency-free local fixture/i);
  assert.match(demo, /not a verifiable record of a human client approval/i);
  assert.equal(JSON.parse(jsonReceipt).execution.expectedStatus, 'failed');
  assert.match(markdownReceipt, /Demo checkout calculation failed/);
  assert.match(comparison, /Last verified: \*\*2026-08-03\*\*/);
  for (const competitor of ['TestSprite', 'BrowserStack', 'mabl', 'Momentic']) {
    assert.match(comparison, new RegExp(competitor));
  }
  assert.match(checklist, /GitHub Issues/);
  assert.match(checklist, /SECURITY\.md/);
});
