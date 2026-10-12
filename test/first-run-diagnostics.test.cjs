/**
 * The two first-run failures reported on #119: a missing-browser hint that
 * installed the wrong build, and a loopback refusal that read the same with
 * and without consent.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { assertSafeNetworkUrl } = require('../dist/tools/network-policy.js');
const { missingBrowserError, resolvedPlaywrightVersion } = require('../dist/tools/common.js');

const run = promisify(execFile);
const cli = path.join(__dirname, '..', 'dist', 'index.js');

const resolve = async (hostname) => {
  const addresses = {
    hub: [{ address: '172.18.0.3', family: 4 }],
    'loopback-alias.example': [{ address: '127.0.0.1', family: 4 }],
    localhost: [{ address: '127.0.0.1', family: 4 }],
  };
  if (!addresses[hostname]) throw new Error('ENOTFOUND');
  return addresses[hostname];
};

async function refusal(url, options) {
  try {
    await assertSafeNetworkUrl(url, { lookup: resolve, ...options });
  } catch (error) {
    return error.message;
  }
  assert.fail(`${url} was permitted`);
}

test('with consent, a compose service name is refused with the rule and the workaround', async () => {
  const message = await refusal('http://hub:3000/login', { allowPrivateNetwork: true });
  assert.match(message, /not permitted by the local safety policy/);
  assert.match(message, /only to localhost, 127\.0\.0\.0\/8 and ::1/);
  assert.match(message, /Docker Compose service name/);
  assert.match(message, /http:\/\/localhost:<port>/);
  assert.doesNotMatch(message, /172\.18/, 'the resolved address is never disclosed');
});

test('with consent, a private answer and a failed lookup read the same', async () => {
  // Otherwise the message is an oracle for which internal names resolve.
  const privateAnswer = await refusal('http://hub:3000/', { allowPrivateNetwork: true });
  const noAnswer = await refusal('http://does-not-resolve:3000/', { allowPrivateNetwork: true });
  const loopbackAlias = await refusal('http://loopback-alias.example:3000/', { allowPrivateNetwork: true });
  assert.equal(privateAnswer, noAnswer);
  assert.equal(privateAnswer, loopbackAlias);
});

test('without consent, only an explicit loopback target is told about the opt-in', async () => {
  assert.match(await refusal('http://localhost:3000/', {}), /allowPrivateNetwork: true \(CLI: --allow-private-network\)/);
  assert.match(await refusal('http://127.0.0.1:3000/', {}), /allowPrivateNetwork: true/);
  // A name that merely resolves privately keeps the bare refusal: suggesting
  // the opt-in would confirm what it resolved to.
  assert.equal(await refusal('http://hub:3000/', {}), 'The requested network destination is not permitted by the local safety policy.');
});

test('with consent, a second loopback origin is refused by naming the approved one', async () => {
  const message = await refusal('http://localhost:4000/', {
    allowPrivateNetwork: true,
    privateNetworkOrigin: 'http://localhost:3000',
  });
  assert.match(message, /only the loopback origin it was given, http:\/\/localhost:3000/);
});

test('the missing-browser error names the install command for the resolved Playwright', () => {
  const banner = new Error(
    "browserType.launch: Executable doesn't exist at /x/chromium_headless_shell-1248/chrome-headless-shell\n║     npx playwright install     ║"
  );
  const error = missingBrowserError(banner, 'chromium', '1.64.0');
  assert.match(error.message, /Install it with: npx -y playwright@1\.64\.0 install chromium\./);
  assert.match(error.message, /project's own Playwright version/);
  assert.equal(missingBrowserError(new Error('net::ERR_CONNECTION_REFUSED'), 'chromium', '1.64.0'), undefined);

  assert.equal(resolvedPlaywrightVersion(), require('playwright/package.json').version);
});

test('the CLI prints the pinned install command when the browser is missing', { timeout: 60_000 }, async (t) => {
  const empty = await mkdtemp(path.join(tmpdir(), 'qmax-no-browsers-'));
  t.after(() => rm(empty, { recursive: true, force: true }));

  const failure = await run(process.execPath, [cli, 'inspect', '--allow-private-network', 'http://localhost:9/'], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty },
  }).then(
    () => assert.fail('inspect succeeded without a browser'),
    (error) => error
  );

  const version = require('playwright/package.json').version.replace(/\./g, '\\.');
  assert.match(failure.stderr, new RegExp(`Fatal: .*npx -y playwright@${version} install chromium\\.`));
  assert.doesNotMatch(failure.stderr, /╔/, 'Playwright\'s banner is replaced, not appended');
});
