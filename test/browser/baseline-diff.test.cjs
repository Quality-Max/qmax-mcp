/**
 * Exercises the scan → change → rescan → decide loop against a real page.
 *
 * The unit tests pin the diff algebra. What they cannot show is the round trip:
 * that a result written to disk is a valid baseline for the next run, and that
 * fingerprints actually survive a second browser session. In the session that
 * motivated this the comparison was done by eyeballing two JSON blobs — 17
 * findings before, 2 after — and confirming by hand that the survivors were
 * pre-existing rather than regressions.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const path = require('node:path');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { scanUrl } = require('../../dist/tools/scan-url.js');

/** A page whose defects can be toggled between runs. */
function fixtureServer(state) {
  return http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<!doctype html><html lang="en"><head><title>${state.title}</title></head><body>` +
        `<h1>Fixture</h1>` +
        (state.brokenImage ? '<img src="/missing.png">' : '') +
        (state.extraUnlabelled ? '<form><input type="text"></form>' : '') +
        `</body></html>`
    );
  });
}

test('a baseline separates a regression from a pre-existing finding', async (t) => {
  const state = { title: 'Fixture page', brokenImage: true, extraUnlabelled: false };
  const server = fixtureServer(state);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const workspaceRoot = path.resolve(__dirname, '..', '..');
  const directory = await mkdtemp(path.join(workspaceRoot, '.baseline-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baselinePath = path.join(directory, 'baseline.json');

  const before = await scanUrl({ url, allowPrivateNetwork: true, checks: ['accessibility'] });
  assert.ok(before.findingCount > 0, 'the fixture should start with a finding to carry forward');
  assert.ok(
    before.findings.every((finding) => /^[0-9a-f]{12}$/.test(finding.id)),
    'every finding should carry a fingerprint'
  );
  // A baseline is just a previous result: no new storage concept.
  await writeFile(baselinePath, JSON.stringify(before, null, 2), 'utf8');
  const relativeBaseline = path.relative(workspaceRoot, baselinePath);

  // Rescan unchanged: nothing new, and the identical finding is recognised
  // across two separate browser sessions rather than re-reported as new.
  const unchanged = await scanUrl({
    url,
    allowPrivateNetwork: true,
    checks: ['accessibility'],
    baseline: relativeBaseline,
  });
  assert.equal(unchanged.delta.new.length, 0, JSON.stringify(unchanged.delta, null, 2));
  assert.equal(unchanged.delta.fixed.length, 0);
  assert.equal(unchanged.delta.unchanged.length, before.findingCount);
  assert.equal(unchanged.delta.verdict, 'No new findings since baseline.');

  // Introduce a regression: the pre-existing finding must stay `unchanged`, and
  // only the new one may be reported as new. This is the question the tool is
  // positioned to answer and previously depended on the reader's diligence.
  state.extraUnlabelled = true;
  const regressed = await scanUrl({
    url,
    allowPrivateNetwork: true,
    checks: ['accessibility'],
    baseline: relativeBaseline,
  });
  assert.equal(regressed.delta.new.length, 1, JSON.stringify(regressed.delta, null, 2));
  assert.match(regressed.delta.new[0].message, /no accessible label/);
  assert.equal(regressed.delta.unchanged.length, before.findingCount);
  assert.equal(regressed.delta.verdict, '1 new finding since baseline.');

  // Fix the original defect: it moves to `fixed`, and the verdict stays quiet
  // about regressions because there are none.
  state.brokenImage = false;
  state.extraUnlabelled = false;
  const fixed = await scanUrl({
    url,
    allowPrivateNetwork: true,
    checks: ['accessibility'],
    baseline: relativeBaseline,
  });
  assert.equal(fixed.delta.new.length, 0);
  assert.ok(fixed.delta.fixed.length > 0);
  assert.match(fixed.delta.verdict, /^No new findings since baseline; \d+ finding/);

  // An inline baseline is equivalent to the file, for a caller that still holds
  // the previous result.
  const inline = await scanUrl({ url, allowPrivateNetwork: true, checks: ['accessibility'], baseline: before });
  assert.deepEqual(
    inline.delta.new.map((f) => f.id),
    fixed.delta.new.map((f) => f.id)
  );

  // The persisted baseline is untouched by being read.
  assert.deepEqual(JSON.parse(await readFile(baselinePath, 'utf8')).findings.length, before.findings.length);
});
