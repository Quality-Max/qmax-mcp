/**
 * Proves the storage-state recipe in the README end to end.
 *
 * storageStatePath has existed since 0.5.0, but every scan in the session that
 * motivated this stayed on the three public pages because no state file existed
 * and minting one meant inventing the procedure. The README now documents that
 * procedure, so this holds it honest: run the documented steps, hand the result
 * to inspect_page, and confirm it sees the page only a signed-in user gets.
 *
 * The value is in the round trip. A recipe that produces a file the tools reject
 * is worse than no recipe.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const path = require('node:path');
const { mkdtemp, rm } = require('node:fs/promises');
const { chromium } = require('playwright');
const { inspectPage } = require('../../dist/tools/inspect-page.js');

const SESSION = 'fixture_session';

/** A site that renders different markup for a signed-in visitor. */
function loginWalledServer() {
  return http.createServer((req, res) => {
    const signedIn = (req.headers.cookie || '').includes(`${SESSION}=granted`);
    if (req.url === '/login') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `${SESSION}=granted; Path=/` });
      res.end('<!doctype html><html lang="en"><head><title>Sign in</title></head><body><h1>Sign in</h1></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      signedIn
        ? '<!doctype html><html lang="en"><head><title>Account</title></head><body><h1>Your account</h1><button data-testid="sign-out">Sign out</button></body></html>'
        : '<!doctype html><html lang="en"><head><title>Sign in</title></head><body><h1>Sign in</h1></body></html>'
    );
  });
}

test('the documented recipe produces a state file the tools accept', async (t) => {
  const server = loginWalledServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  // storageStatePath is resolved against the workspace, so the file has to live
  // inside it — the same constraint a real caller works under.
  const workspaceRoot = path.resolve(__dirname, '..', '..');
  const directory = await mkdtemp(path.join(workspaceRoot, '.storage-state-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'user.json');

  // The README's second recipe, condensed: drive the login, then persist.
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${origin}/login`);
  await page.context().storageState({ path: statePath });
  await browser.close();

  const relativeStatePath = path.relative(workspaceRoot, statePath);

  // Without the state, the wall is up.
  const anonymous = await inspectPage({ url: `${origin}/account`, allowPrivateNetwork: true });
  assert.equal(anonymous.title, 'Sign in');

  // With it, the tool sees what a signed-in user sees.
  const authenticated = await inspectPage({
    url: `${origin}/account`,
    allowPrivateNetwork: true,
    storageStatePath: relativeStatePath,
    acknowledgePrivateContent: true,
  });
  assert.equal(authenticated.title, 'Account');
  assert.ok(
    authenticated.interactive.some((item) => item.testId === 'sign-out'),
    'the authenticated snapshot should contain the signed-in control'
  );

  // The consent flag is not optional, and the failure says why.
  await assert.rejects(
    () => inspectPage({ url: `${origin}/account`, allowPrivateNetwork: true, storageStatePath: relativeStatePath }),
    /acknowledgePrivateContent/
  );
});
