/**
 * Exercises telemetry-SDK recognition against a real browser and a real server.
 *
 * The two surfaces a stubbed SDK reaches the scan through behave differently and
 * neither is reachable from a unit test:
 *
 * - A served 404 (PostHog fetching its remote config) is not a request failure
 *   at all. It arrives only as a console error whose *location* carries the URL,
 *   so recognition depends on Playwright populating that location.
 * - A request the network policy refuses (a Sentry envelope addressed to another
 *   loopback origin, exactly as in the session that motivated this) arrives as a
 *   `requestfailed` with no console counterpart guaranteed.
 *
 * Asserting on the shape of the finding is not enough here — the point is that
 * both paths reach it at all.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { scanUrl } = require('../../dist/tools/scan-url.js');

async function scanFixture(body) {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html lang="en"><head></head><body>${body}</body></html>`);
      return;
    }
    // Everything else is missing, which is what a stubbed telemetry endpoint is.
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await scanUrl({
      url: `http://127.0.0.1:${port}/`,
      allowPrivateNetwork: true,
      checks: ['console'],
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a PostHog remote-config 404 is named through the console surface', async () => {
  // A served 404 never reaches `requestfailed`, so if console locations were not
  // inspected this SDK would stay anonymous.
  const result = await scanFixture(
    '<script src="/ingest/array/stub_posthog_token_disabled_for_e2e_0000/config.js"></script>'
  );
  const telemetry = result.findings.filter((finding) => finding.category === 'telemetry');
  assert.equal(telemetry.length, 1, `expected one telemetry finding, got ${JSON.stringify(result.findings, null, 2)}`);
  assert.match(telemetry[0].message, /^PostHog is initialized with a placeholder credential/);
  assert.match(telemetry[0].suggestion, /prefer an empty DSN\/token/);
  // The generic "fix runtime errors" console finding must not also be emitted
  // for the same event: one root cause, one finding.
  assert.equal(
    result.findings.some((finding) => /Fix runtime errors/.test(finding.suggestion || '')),
    false
  );
});

test('a Sentry envelope refused by the network policy is named through the failure surface', async () => {
  // Addressed to a different loopback origin than the approved one, which is how
  // this appeared originally: the scanner's own policy aborts it.
  const result = await scanFixture(
    '<script src="https://localhost/api/0/envelope/?sentry_version=7&sentry_key=stub"></script>'
  );
  const telemetry = result.findings.filter((finding) => finding.category === 'telemetry');
  assert.ok(telemetry.length >= 1, `expected a telemetry finding, got ${JSON.stringify(result.findings, null, 2)}`);
  assert.match(telemetry[0].message, /^Sentry is initialized with a placeholder credential/);
  assert.match(telemetry[0].suggestion, /sentry_key=stub/);
  // Whichever surfaces reported it, they collapse to one finding.
  assert.equal(telemetry.length, 1);
});

test('an ordinary broken asset keeps the generic console finding', async () => {
  // The signature table must not swallow failures it does not recognise.
  const result = await scanFixture('<script src="/static/app.js"></script>');
  assert.equal(
    result.findings.some((finding) => finding.category === 'telemetry'),
    false
  );
  assert.ok(result.findings.some((finding) => /Fix runtime errors/.test(finding.suggestion || '')));
});
