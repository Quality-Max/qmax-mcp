const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, mkdir, readFile, rm, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { generatePlaywrightRepro } = require('../dist/tools/generate-playwright-repro.js');
const { createLocalServer } = require('../dist/server.js');
const { createChildEnvironment, redactSensitiveText, runCommand, safeRunnerStream } = require('../dist/tools/run-playwright-test.js');
const { browserContextOptions, enforceBrowserNetworkPolicy } = require('../dist/tools/common.js');
const { assertSafeNetworkUrl, safeFetch } = require('../dist/tools/network-policy.js');
const { renderClients } = require('../dist/clients.js');

test('generated repros stay inside the controlled workspace output directory', async () => {
  const originalDirectory = process.cwd();
  const workspace = await mkdtemp(path.join(tmpdir(), 'qmax-output-test-'));
  process.chdir(workspace);

  try {
    const generated = await generatePlaywrightRepro({ url: 'https://example.com', outputPath: 'nested/repro.spec.ts' });
    assert.equal(generated.filePath, '.qmax-mcp/repros/nested/repro.spec.ts');
    assert.match(await readFile(path.join(workspace, generated.filePath), 'utf8'), /https:\/\/example\.com/);
    assert.equal(path.isAbsolute(generated.filePath), false);

    await assert.rejects(
      () => generatePlaywrightRepro({ url: 'https://example.com', outputPath: '../outside.spec.ts' }),
      /escapes the approved output directory/
    );
    await assert.rejects(
      () => generatePlaywrightRepro({ url: 'https://example.com', outputPath: path.join(tmpdir(), 'outside.spec.ts') }),
      /must be relative/
    );

    const existing = path.join(workspace, '.qmax-mcp', 'repros', 'existing.spec.ts');
    await writeFile(existing, 'original', 'utf8');
    await assert.rejects(
      () => generatePlaywrightRepro({ url: 'https://example.com', outputPath: 'existing.spec.ts' }),
      /Refusing to overwrite/
    );
    await generatePlaywrightRepro({ url: 'https://example.com', outputPath: 'existing.spec.ts', overwrite: true });
    assert.notEqual(await readFile(existing, 'utf8'), 'original');

    const outside = await mkdtemp(path.join(tmpdir(), 'qmax-output-escape-'));
    await mkdir(path.join(workspace, '.qmax-mcp', 'repros', 'linked'), { recursive: true });
    await rm(path.join(workspace, '.qmax-mcp', 'repros', 'linked'), { recursive: true });
    await symlink(outside, path.join(workspace, '.qmax-mcp', 'repros', 'linked'));
    await assert.rejects(
      () => generatePlaywrightRepro({ url: 'https://example.com', outputPath: 'linked/escape.spec.ts' }),
      /symlink outside/
    );
    await rm(outside, { recursive: true, force: true });
  } finally {
    process.chdir(originalDirectory);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('two MCP client fixtures receive the locked safety annotations and descriptions', async () => {
  const expected = {
    scan_url: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inspect_page: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    generate_playwright_repro: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run_playwright_test: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };

  for (const clientName of ['codex-approval-fixture', 'cursor-approval-fixture']) {
    const server = createLocalServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: clientName, version: 'test' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    const received = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    assert.deepEqual(received, expected);

    const generated = tools.find((tool) => tool.name === 'generate_playwright_repro');
    const run = tools.find((tool) => tool.name === 'run_playwright_test');
    assert.match(generated.description, /approved workspace directory/);
    assert.equal(generated.inputSchema.properties.overwrite.type, 'boolean');
    assert.match(run.description, /code-execution and artifact-writing boundary/);
    assert.equal(run.inputSchema.properties.executionAcknowledged.const, true);
    await client.close();
  }
});

test('client setup rendering never reads or displays an environment-sourced credential', () => {
  const key = 'QUALITYMAX_API_KEY';
  const previous = process.env[key];
  process.env[key] = 'test-only-client-config-canary';
  try {
    const rendered = renderClients();
    assert.equal(rendered.includes('test-only-client-config-canary'), false);
    assert.match(rendered, /QUALITYMAX_API_KEY": "<your-api-key>"/);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test('the test runner excludes parent credentials, supports explicit values, redacts output, and kills timed-out process groups', async () => {
  const key = 'QMAX_PARENT_CREDENTIAL_CANARY';
  process.env[key] = 'test-only-parent-canary';
  try {
    const emptyEnvironment = createChildEnvironment({});
    const parentResult = await runCommand(
      process.execPath,
      ['-e', `process.stdout.write(process.env.${key} || 'not-present')`],
      emptyEnvironment,
      { timeoutMs: 2_000 }
    );
    assert.equal(parentResult.stdout, 'not-present');

    const allowedResult = await runCommand(
      process.execPath,
      ['-e', "process.stdout.write(process.env.QMAX_TEST_VISIBLE || 'missing')"],
      createChildEnvironment({ allowedEnv: { QMAX_TEST_VISIBLE: 'visible' } }),
      { timeoutMs: 2_000 }
    );
    assert.equal(allowedResult.stdout, 'visible');
    assert.throws(() => createChildEnvironment({ allowedEnv: { PATH: 'invalid' } }), /reserved/);

    const redacted = redactSensitiveText('Authorization: Bearer test-redaction-sentinel?api_key=test-redaction-sentinel');
    assert.equal(redacted.includes('test-redaction-sentinel'), false);
    const withheld = safeRunnerStream('unstructured-output-test-redaction-sentinel', 'stderr');
    assert.equal(withheld.includes('test-redaction-sentinel'), false);
    assert.match(withheld, /withheld/);

    const timeoutResult = await runCommand(
      process.execPath,
      [
        '-e',
        "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); console.log(child.pid); setInterval(()=>{},1000);",
      ],
      emptyEnvironment,
      { timeoutMs: 200 }
    );
    assert.equal(timeoutResult.timedOut, true);
    const childPid = Number(timeoutResult.stdout.trim());
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);

    const controller = new AbortController();
    const cancelled = runCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      emptyEnvironment,
      { timeoutMs: 2_000, signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 50);
    assert.equal((await cancelled).aborted, true);
  } finally {
    delete process.env[key];
  }
});

test('one network policy blocks private destinations across DNS, redirects, and browser subrequests', async () => {
  const resolve = async (hostname) => {
    const addresses = {
      'public.example': [{ address: '93.184.216.34', family: 4 }],
      'private.example': [{ address: '10.0.0.8', family: 4 }],
      'rebind.example': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
      'v6.example': [{ address: '::1', family: 6 }],
      'expanded-loopback.example': [{ address: '0:0:0:0:0:0:0:1', family: 6 }],
      'expanded-mapped-private.example': [{ address: '0:0:0:0:0:ffff:a00:8', family: 6 }],
      localhost: [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }],
    };
    return addresses[hostname] || [];
  };

  await assertSafeNetworkUrl('https://public.example/path', { lookup: resolve });
  await assert.rejects(() => assertSafeNetworkUrl('http://127.1/', { lookup: resolve }), /not permitted/);
  await assert.rejects(() => assertSafeNetworkUrl('http://169.254.169.254/latest', { allowPrivateNetwork: true, lookup: resolve }), /not permitted/);
  await assert.rejects(() => assertSafeNetworkUrl('https://private.example/', { lookup: resolve }), /not permitted/);
  await assert.rejects(() => assertSafeNetworkUrl('https://rebind.example/', { lookup: resolve }), /not permitted/);
  await assert.rejects(() => assertSafeNetworkUrl('https://v6.example/', { lookup: resolve }), /not permitted/);
  await assert.rejects(() => assertSafeNetworkUrl('https://expanded-loopback.example/', { lookup: resolve }), /not permitted/);
  await assert.rejects(() => assertSafeNetworkUrl('https://expanded-mapped-private.example/', { lookup: resolve }), /not permitted/);
  await assert.rejects(() => assertSafeNetworkUrl('http://[::ffff:7f00:1]/', { lookup: resolve }), /not permitted/);
  for (const expandedAlias of ['0:0:0:0:0:0:0:0', '0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:ffff:a00:8', '64:ff9b:0:0:0:0:a00:8', '2002:a00:8::', '2002:7f00:1::']) {
    await assert.rejects(() => assertSafeNetworkUrl(`http://[${expandedAlias}]/`, { lookup: resolve }), /not permitted/);
  }
  for (const linkLocal of ['fe80::1', 'fe90::1', 'fea0::1', 'febf::1', 'fec0::1', 'fedf::1', 'feff::1']) {
    await assert.rejects(() => assertSafeNetworkUrl(`http://[${linkLocal}]/`, { lookup: resolve }), /not permitted/);
  }
  await assert.rejects(() => assertSafeNetworkUrl('https://private.example/', { allowPrivateNetwork: true, lookup: resolve }), /not permitted/);
  await assert.rejects(() => assertSafeNetworkUrl('https://v6.example/', { allowPrivateNetwork: true, lookup: resolve }), /not permitted/);
  for (const reservedAddress of ['0.0.0.0', '10.0.0.8', '100.64.0.1', '172.16.0.1', '192.168.0.1', '224.0.0.1', '::', 'fc00::1', 'fd00::1', 'fec0::1']) {
    const target = reservedAddress.includes(':') ? `http://[${reservedAddress}]/` : `http://${reservedAddress}/`;
    await assert.rejects(
      () => assertSafeNetworkUrl(target, { allowPrivateNetwork: true, lookup: resolve }),
      /not permitted/
    );
  }
  await assertSafeNetworkUrl('http://127.0.0.1:3000/', { allowPrivateNetwork: true, lookup: resolve });
  await assertSafeNetworkUrl('http://[::1]:3000/', { allowPrivateNetwork: true, lookup: resolve });
  await assertSafeNetworkUrl('http://[::ffff:7f00:1]:3000/', { allowPrivateNetwork: true, lookup: resolve });
  await assertSafeNetworkUrl('http://[0:0:0:0:0:ffff:7f00:1]:3000/', { allowPrivateNetwork: true, lookup: resolve });
  await assertSafeNetworkUrl('http://localhost:3000/', { allowPrivateNetwork: true, lookup: resolve });
  await assert.rejects(() => assertSafeNetworkUrl('https://name:password@public.example/', { lookup: resolve }), /credentials/);

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  };
  try {
    await assert.rejects(() => safeFetch('https://public.example/', {}, { lookup: resolve }), /not permitted/);
    assert.equal(fetchCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }

  fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:3001/private' } });
  };
  try {
    await assert.rejects(
      () => safeFetch('http://127.0.0.1:3000/', {}, { allowPrivateNetwork: true, lookup: resolve }),
      /not permitted/
    );
    assert.equal(fetchCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }

  global.fetch = async () => new Response('x'.repeat(64), { status: 200 });
  try {
    const response = await safeFetch('https://public.example/', {}, { lookup: resolve, maxResponseBytes: 16 });
    await assert.rejects(() => response.text(), /safety size limit/);
  } finally {
    global.fetch = originalFetch;
  }

  let handler;
  let webSocketHandler;
  await enforceBrowserNetworkPolicy(
    {
      route: async (_pattern, registeredHandler) => { handler = registeredHandler; },
      routeWebSocket: async (_pattern, registeredHandler) => { webSocketHandler = registeredHandler; },
    },
    { lookup: resolve }
  );
  const publicRequest = { continued: false, aborted: false, request: () => ({ url: () => 'https://public.example/app.js' }), continue: async () => { publicRequest.continued = true; }, abort: async () => { publicRequest.aborted = true; } };
  const privateRequest = { continued: false, aborted: false, request: () => ({ url: () => 'https://private.example/app.js' }), continue: async () => { privateRequest.continued = true; }, abort: async () => { privateRequest.aborted = true; } };
  await handler(publicRequest);
  await handler(privateRequest);
  assert.deepEqual([publicRequest.continued, publicRequest.aborted], [true, false]);
  assert.deepEqual([privateRequest.continued, privateRequest.aborted], [false, true]);

  const privateSocket = { closed: false, url: () => 'ws://private.example/socket', connectToServer: () => { throw new Error('must not connect'); }, close: async () => { privateSocket.closed = true; } };
  await webSocketHandler(privateSocket);
  assert.equal(privateSocket.closed, true);

  let loopbackHandler;
  await enforceBrowserNetworkPolicy(
    {
      route: async (_pattern, registeredHandler) => { loopbackHandler = registeredHandler; },
      routeWebSocket: async () => {},
    },
    { allowPrivateNetwork: true, privateNetworkOrigin: 'http://127.0.0.1:3000', lookup: resolve }
  );
  const approvedLoopbackRequest = { continued: false, aborted: false, request: () => ({ url: () => 'http://127.0.0.1:3000/app.js' }), continue: async () => { approvedLoopbackRequest.continued = true; }, abort: async () => { approvedLoopbackRequest.aborted = true; } };
  const otherPortRequest = { continued: false, aborted: false, request: () => ({ url: () => 'http://127.0.0.1:3001/app.js' }), continue: async () => { otherPortRequest.continued = true; }, abort: async () => { otherPortRequest.aborted = true; } };
  const loopbackAliasRequest = { continued: false, aborted: false, request: () => ({ url: () => 'http://localhost:3000/app.js' }), continue: async () => { loopbackAliasRequest.continued = true; }, abort: async () => { loopbackAliasRequest.aborted = true; } };
  await loopbackHandler(approvedLoopbackRequest);
  await loopbackHandler(otherPortRequest);
  await loopbackHandler(loopbackAliasRequest);
  assert.deepEqual([approvedLoopbackRequest.continued, approvedLoopbackRequest.aborted], [true, false]);
  assert.deepEqual([otherPortRequest.continued, otherPortRequest.aborted], [false, true]);
  assert.deepEqual([loopbackAliasRequest.continued, loopbackAliasRequest.aborted], [false, true]);
  assert.equal(browserContextOptions().serviceWorkers, 'block');
});
