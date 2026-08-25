/**
 * Exercises authenticated inspection with a real browser. This stays in the demo suite because
 * the normal Node matrix intentionally does not install Playwright browsers.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { createServer: createHttpServer } = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { inspectPage } = require('../../dist/tools/inspect-page.js');
const { scanUrl } = require('../../dist/tools/scan-url.js');

test('inspection and scans use authenticated storage state without returning it', async () => {
  const originalDirectory = process.cwd();
  const workspace = await mkdtemp(path.join(tmpdir(), 'qmax-inspect-auth-'));
  const authDirectory = path.join(workspace, 'playwright', '.auth');
  const statePath = path.join(authDirectory, 'user.json');
  const invalidStatePath = path.join(authDirectory, 'invalid.json');
  const stateCanary = 'fixture-auth-state-canary';
  const authFlag = `fixture-authorized=${stateCanary}`;
  const server = createHttpServer((request, response) => {
    if (request.url === '/link-page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<title>Link page</title><main><h1>Links</h1><a href="/private-link">Private link</a>' +
          '<div id="aria-action" role="button">ARIA action</div></main>'
      );
      return;
    }
    if (request.url === '/private-link' && request.headers.cookie?.includes(authFlag)) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<title>Private link</title><main><h1>Private link</h1></main>');
      return;
    }
    if (request.url === '/private-link') {
      response.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<title>Unauthorized</title><main><h1>Unauthorized</h1></main>');
      return;
    }
    if (request.url === '/protected' && request.headers.cookie?.includes(authFlag)) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<title>Private area</title><main><h1>Protected dashboard</h1><button>Sign out</button></main>');
      return;
    }
    if (request.url === '/protected') {
      response.writeHead(302, { location: '/login' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<title>Login</title><main><h1>Login required</h1></main>');
  });

  await mkdir(authDirectory, { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify({
      cookies: [
        {
          name: 'fixture-authorized',
          value: stateCanary,
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    }),
    'utf8'
  );
  await writeFile(invalidStatePath, '{fixture-malformed-state-canary', 'utf8');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const url = `http://127.0.0.1:${address.port}/protected`;
  const linkPageUrl = `http://127.0.0.1:${address.port}/link-page`;
  process.chdir(workspace);

  try {
    const anonymous = await inspectPage({ url, allowPrivateNetwork: true });
    assert.equal(anonymous.title, 'Login');
    assert.equal(anonymous.headings[0].text, 'Login required');

    const authenticated = await inspectPage({
      url,
      allowPrivateNetwork: true,
      storageStatePath: 'playwright/.auth/user.json',
    });
    assert.equal(authenticated.title, 'Private area');
    assert.equal(authenticated.headings[0].text, 'Protected dashboard');
    assert.equal(authenticated.interactive[0].name, 'Sign out');
    assert.equal(JSON.stringify(authenticated).includes(stateCanary), false);

    const anonymousLinks = await scanUrl({
      url: linkPageUrl,
      checks: ['links'],
      allowPrivateNetwork: true,
    });
    assert.equal(
      anonymousLinks.findings.some((finding) => finding.message === 'Link returned HTTP 401.'),
      true
    );

    const authenticatedLinks = await scanUrl({
      url: linkPageUrl,
      checks: ['links'],
      allowPrivateNetwork: true,
      storageStatePath: 'playwright/.auth/user.json',
    });
    assert.equal(authenticatedLinks.findings.length, 0);
    assert.equal(JSON.stringify(authenticatedLinks).includes(stateCanary), false);

    const accessibility = await scanUrl({
      url: linkPageUrl,
      checks: ['accessibility'],
      allowPrivateNetwork: true,
    });
    assert.equal(
      accessibility.findings.some(
        (finding) =>
          finding.message === 'Element appears clickable but cannot be focused or activated from a keyboard.' &&
          finding.selector === '#aria-action'
      ),
      true
    );

    await assert.rejects(
      () =>
        inspectPage({
          url,
          allowPrivateNetwork: true,
          storageStatePath: 'playwright/.auth/invalid.json',
        }),
      (error) => {
        assert.equal(error.message, 'storageStatePath must contain valid Playwright storage-state JSON.');
        assert.equal(error.message.includes('fixture-malformed-state-canary'), false);
        assert.equal(error.message.includes(invalidStatePath), false);
        return true;
      }
    );
  } finally {
    process.chdir(originalDirectory);
    await new Promise((resolve) => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
