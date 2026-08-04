/**
 * Executes the real demo end to end. It needs the Playwright browser, so it is not part of
 * `npm test`; run it with `npm run test:demo`.
 *
 * The demo previously broke silently on main: the approval hardening removed the flag it passed,
 * and nothing in CI ever ran the script. Asserting on the generated receipt, rather than on the
 * committed example files, is what makes that class of drift visible.
 */
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');

function runDemo(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(root, 'demo', 'run.mjs'), ...args], { cwd: root }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

test('the demo runs scan to executed evidence and returns a digest-bound receipt', { timeout: 180_000 }, async () => {
  const { stdout } = await runDemo(['--format', 'json']);
  const receipt = JSON.parse(stdout);

  assert.equal(receipt.kind, 'qualitymax-reproducible-demo');
  assert.deepEqual(receipt.tools, [
    'scan_url',
    'inspect_page',
    'generate_playwright_repro',
    'run_playwright_test',
  ]);

  // The fixture carries one defect per check, so a run that stops reporting a category means the
  // check regressed, not that the fixture got better.
  assert.deepEqual(receipt.scan.categoriesReported, [
    'accessibility',
    'console',
    'cookies',
    'links',
    'mixed_content',
    'security_headers',
    'seo',
    'weight',
  ]);
  assert.ok(receipt.scan.findingCount >= 9);
  assert.ok(receipt.scan.findings.some((finding) => /Demo checkout calculation failed/.test(finding.message)));
  assert.equal(typeof receipt.scan.metrics.vitals.lcpMs, 'number');
  assert.equal(receipt.scan.metrics.vitals.inpMs, null);
  assert.ok(receipt.scan.metrics.weight.totalBytes > 0);

  assert.ok(receipt.inspect.interactiveCount > 0);
  assert.equal(receipt.inspect.formCount, 1);
  assert.ok(receipt.inspect.locatorCandidates.some((locator) => /getByRole\('button'/.test(locator)));

  assert.match(receipt.repro.generatedPath, /^\.qmax-mcp\/repros\/.+\.spec\.ts$/);

  // The fixture keeps its intentional error, so a passing run would mean the repro proved nothing.
  assert.equal(receipt.execution.status, 'failed');
  assert.equal(receipt.execution.expectedStatus, 'failed');
  assert.equal(receipt.execution.summary.stats.unexpected, 1);

  assert.equal(receipt.execution.approvalMechanism, 'demo-self-asserted-digest');
  assert.match(receipt.execution.approvalDigest, /^[a-f0-9]{64}$/);
  assert.match(receipt.execution.approvalEvidence, /not independent proof of human approval/);
  assert.equal(
    JSON.stringify(receipt).includes('executionAcknowledged'),
    false,
    'the removed caller-asserted flag must not come back'
  );
});

test('the demo Markdown mode reports the executed result and its approval limit', { timeout: 180_000 }, async () => {
  const { stdout } = await runDemo(['--format', 'markdown']);

  assert.match(stdout, /# QA Scan/);
  assert.match(stdout, /Demo checkout calculation failed/);
  assert.match(stdout, /\| 1 \| `scan_url` \|/);
  assert.match(stdout, /\| 4 \| `run_playwright_test` \|/);
  assert.match(stdout, /`[█░]{24}` \d+ \/ 100/, 'the score meter is rendered');
  assert.match(stdout, /Where the bytes went:/, 'the byte breakdown bars are rendered');
  assert.match(stdout, /## Page structure — `inspect_page`/);
  assert.match(stdout, /- `page\.getByRole\(/);
  assert.match(stdout, /## Repro and executed evidence/);
  assert.match(stdout, /Executed on Chromium: expected \*\*failed\*\* result/);
  assert.match(stdout, /Execution digest: `[a-f0-9]{64}`/);
  assert.match(stdout, /not independently verifiable human approval/);
});
