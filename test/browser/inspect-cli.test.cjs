/**
 * Exercises the `inspect` CLI subcommand end to end: real argument parsing,
 * real browser, real fixture. The unit tests cover the renderer; this covers
 * the wiring — that a shell caller (a spec author, or a tool like 9lives
 * healing a spec) gets the ranked locators as JSON without an MCP client.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const cli = path.join(__dirname, '..', '..', 'dist', 'index.js');

async function withFixture(body, fn) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><head><title>fixture</title></head><body>${body}</body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('inspect --format json returns ranked locators to a shell caller', { timeout: 60_000 }, async () => {
  await withFixture(
    '<h1>Login</h1><form><input id="email" type="email" placeholder="you@example.com"><button data-testid="submit">Sign in</button></form>',
    async (url) => {
      const { stdout } = await run(process.execPath, [cli, 'inspect', url, '--format', 'json', '--allow-private-network']);
      const result = JSON.parse(stdout);

      const email = result.interactive.find((item) => item.type === 'email');
      assert.equal(email.stability, 'stable');
      assert.equal(email.recommendedLocator, "page.locator('#email')");

      const submit = result.interactive.find((item) => item.testId === 'submit');
      assert.equal(submit.recommendedLocator, 'page.getByTestId("submit")');

      assert.equal(result.testability.controls, 2);
      assert.equal(result.testability.score, 100);
    }
  );
});

test('inspect renders the Markdown locator table by default', { timeout: 60_000 }, async () => {
  await withFixture(
    '<form><input type="text" placeholder="Search orders"></form>',
    async (url) => {
      const { stdout } = await run(process.execPath, [cli, 'inspect', url, '--allow-private-network']);

      assert.match(stdout, /# Page Inspection — 127\.0\.0\.1:\d+/);
      assert.match(stdout, /\| Control \| Stability \| Locator \|/);
      assert.match(stdout, /🟠 fragile/);
      assert.match(stdout, /page\.getByPlaceholder\("Search orders"\)/);
      // The caveat that makes the fragile verdict actionable.
      assert.match(stdout, /breaks on a copy edit and on any translation/);
    }
  );
});
