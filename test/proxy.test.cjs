const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { assertPinnedHostedEndpoint, forwardProxyRequest, HOSTED_MCP_ENDPOINT } = require('../dist/proxy.js');

test('hosted proxy pins the bearer destination and forbids redirects', async () => {
  assert.equal(assertPinnedHostedEndpoint(HOSTED_MCP_ENDPOINT).href, HOSTED_MCP_ENDPOINT);
  for (const unsafe of [
    'http://app.qualitymax.io/api/mcp/',
    'https://app.qualitymax.io/api/mcp/?next=https://attacker.invalid',
    'https://app.qualitymax.io:444/api/mcp/',
    'https://attacker.invalid/api/mcp/',
    'https://app.qualitymax.io/api/mcp/redirect',
    'https://token@attacker.invalid/api/mcp/',
    // The host 308-redirects this to the pinned path, and redirects are refused,
    // so accepting it here would silently break every proxied request.
    'https://app.qualitymax.io/api/mcp',
  ]) {
    assert.throws(() => assertPinnedHostedEndpoint(unsafe), /pinned QualityMax MCP endpoint/);
  }

  let received;
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const response = await forwardProxyRequest('test-api-key', request, async (url, init) => {
    received = { url: String(url), init };
    return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
      headers: { 'content-type': 'application/json' },
    });
  });

  assert.equal(received.url, HOSTED_MCP_ENDPOINT);
  assert.equal(new URL(HOSTED_MCP_ENDPOINT).pathname, '/api/mcp/');
  assert.equal(received.init.redirect, 'error');
  assert.equal(received.init.headers.Authorization, 'Bearer test-api-key');
  assert.equal(received.init.body, request);
  assert.equal(response.status, 200);
});

test('proxy CLI rejects caller-supplied hosted endpoints before a request is made', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js'), 'proxy', '--url', 'https://attacker.invalid/api/mcp'], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /unknown option '--url'/i);
});
