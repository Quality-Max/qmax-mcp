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
  assert.equal(receipt.scan.findingCount, 1);
  assert.equal(receipt.scan.findings[0].category, 'console');
  assert.match(receipt.scan.findings[0].message, /Demo checkout calculation failed/);
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
  assert.match(stdout, /## Generated repro and execution evidence/);
  assert.match(stdout, /Executed on Chromium: expected \*\*failed\*\* result/);
  assert.match(stdout, /Execution digest: `[a-f0-9]{64}`/);
  assert.match(stdout, /not independently verifiable human approval/);
});
