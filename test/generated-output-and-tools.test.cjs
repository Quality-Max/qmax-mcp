const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { ElicitRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { generatePlaywrightRepro } = require('../dist/tools/generate-playwright-repro.js');
const { createLocalServer } = require('../dist/server.js');
const {
  createChildEnvironment,
  describeExecutionApproval,
  redactSensitiveText,
  runCommand,
  runPlaywrightTest,
  safeRunnerStream,
} = require('../dist/tools/run-playwright-test.js');
const {
  browserContextOptions,
  enforceBrowserNetworkPolicy,
  resolveWorkspaceStorageStatePath,
} = require('../dist/tools/common.js');
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
    const inspect = tools.find((tool) => tool.name === 'inspect_page');
    const run = tools.find((tool) => tool.name === 'run_playwright_test');
    assert.match(generated.description, /approved workspace directory/);
    assert.equal(generated.inputSchema.properties.overwrite.type, 'boolean');
    assert.match(inspect.description, /storage-state file for authenticated pages/);
    assert.equal(inspect.inputSchema.properties.storageStatePath.type, 'string');
    assert.match(run.description, /code-execution and artifact-writing boundary/);
    assert.equal(run.inputSchema.properties.executionAcknowledged, undefined);
    assert.equal(run.inputSchema.properties.unattended, undefined);
    assert.match(run.description, /human-approval elicitation/i);
    await client.close();
  }
});

test('inspect_page storage-state paths stay within the workspace and are bounded regular files', async () => {
  const originalDirectory = process.cwd();
  const workspace = await mkdtemp(path.join(tmpdir(), 'qmax-inspect-state-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'qmax-inspect-state-outside-'));
  const authDirectory = path.join(workspace, 'playwright', '.auth');
  const statePath = path.join(authDirectory, 'user.json');
  const outsideStatePath = path.join(outside, 'user.json');
  const oversizedStatePath = path.join(authDirectory, 'oversized.json');

  await mkdir(authDirectory, { recursive: true });
  const storageState = JSON.stringify({ cookies: [], origins: [] });
  await writeFile(statePath, storageState, 'utf8');
  await writeFile(outsideStatePath, storageState, 'utf8');
  await writeFile(oversizedStatePath, Buffer.alloc(10 * 1024 * 1024 + 1));
  process.chdir(workspace);

  try {
    assert.equal(await resolveWorkspaceStorageStatePath('playwright/.auth/user.json'), await realpath(statePath));
    await assert.rejects(() => resolveWorkspaceStorageStatePath(outsideStatePath), /must be relative/);
    await assert.rejects(
      () => resolveWorkspaceStorageStatePath(path.relative(workspace, outsideStatePath)),
      /escapes the active workspace/
    );
    await symlink(outsideStatePath, path.join(authDirectory, 'linked.json'));
    await assert.rejects(
      () => resolveWorkspaceStorageStatePath('playwright/.auth/linked.json'),
      /escapes the active workspace/
    );
    await assert.rejects(() => resolveWorkspaceStorageStatePath('playwright/.auth'), /regular file/);
    await assert.rejects(() => resolveWorkspaceStorageStatePath('playwright/.auth/oversized.json'), /10 MB safety limit/);
    await assert.rejects(
      () => resolveWorkspaceStorageStatePath('playwright/.auth/missing.json'),
      (error) => {
        assert.equal(error.message, 'storageStatePath must name an existing workspace file.');
        assert.equal(error.message.includes(workspace), false);
        return true;
      }
    );
  } finally {
    process.chdir(originalDirectory);
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('run_playwright_test paths reject lexical traversal and symlink escapes', async () => {
  const originalDirectory = process.cwd();
  const workspace = await mkdtemp(path.join(tmpdir(), 'qmax-test-path-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'qmax-test-path-outside-'));
  const insidePath = path.join(workspace, 'inside.spec.ts');
  const outsidePath = path.join(outside, 'outside.spec.ts');
  const source = "test('self-contained', async () => {});";

  await writeFile(insidePath, source, 'utf8');
  await writeFile(outsidePath, source, 'utf8');
  process.chdir(workspace);

  try {
    assert.equal((await describeExecutionApproval({ testPath: 'inside.spec.ts' })).target, 'inside.spec.ts');
    await assert.rejects(() => describeExecutionApproval({ testPath: outsidePath }), /must be relative/);
    await assert.rejects(
      () => describeExecutionApproval({ testPath: path.relative(workspace, outsidePath) }),
      /escapes the active workspace/
    );
    await symlink(outsidePath, path.join(workspace, 'linked.spec.ts'));
    await assert.rejects(
      () => describeExecutionApproval({ testPath: 'linked.spec.ts' }),
      /escapes the active workspace/
    );
  } finally {
    process.chdir(originalDirectory);
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('code execution requires a client-visible human approval elicitation bound to the exact test', async () => {
  const source = "import { test, expect } from '@playwright/test'; test('approval', () => expect(true).toBe(true));";
  const makeClient = async (approval) => {
    const server = createLocalServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'approval-fixture', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } } }
    );
    let elicitation;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitation = request.params;
      return approval;
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, elicitation: () => elicitation };
  };

  const declined = await makeClient({ action: 'decline' });
  try {
    const response = await declined.client.callTool({ name: 'run_playwright_test', arguments: { code: source } });
    assert.equal(response.isError, true);
    // The message names the specific outcome (a decline, not a cancel or an
    // unsupported client), the active mode, and the way out — see #64.
    assert.match(response.content[0].text, /declined by the human reviewer/);
    assert.match(response.content[0].text, /gated mode/);
    assert.match(response.content[0].text, /--unattended/);
    assert.match(declined.elicitation().message, /SHA-256/);
    assert.match(declined.elicitation().message, /inline Playwright test/);
  } finally {
    await declined.client.close();
  }

  const approved = await makeClient({ action: 'accept', content: { approved: true } });
  try {
    const response = await approved.client.callTool({ name: 'run_playwright_test', arguments: { code: source } });
    assert.equal(response.isError, undefined);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.status, 'passed');
    assert.equal(result.approval.mechanism, 'mcp-form-elicitation-v1');
    assert.equal(result.approval.client, 'approval-fixture');
    assert.match(result.approval.digest, /^[a-f0-9]{64}$/);
  } finally {
    await approved.client.close();
  }
});

test('explicit unattended mode executes without elicitation and returns a visible authorization record', async () => {
  const server = createLocalServer({ unattended: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'unattended-fixture', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  let outputDir;

  try {
    const tools = (await client.listTools()).tools;
    const run = tools.find((tool) => tool.name === 'run_playwright_test');
    assert.match(run.description, /explicitly started with --unattended/i);
    assert.match(client.getInstructions(), /Do not pause to\s+request one/);

    const source =
      "import { test, expect } from '@playwright/test'; test('unattended', () => expect(true).toBe(true));";
    const response = await client.callTool({ name: 'run_playwright_test', arguments: { code: source } });
    assert.equal(response.isError, undefined);
    const result = JSON.parse(response.content[0].text);
    outputDir = result.outputDir;
    assert.equal(result.status, 'passed', JSON.stringify(result));
    assert.equal(result.approval.mechanism, 'unattended-cli-opt-in-v1');
    assert.equal(result.approval.client, 'unattended-fixture');
    assert.equal(result.approval.unattended, true);
    assert.match(result.approval.digest, /^[a-f0-9]{64}$/);
  } finally {
    await client.close();
    if (outputDir) await rm(outputDir, { recursive: true, force: true });
  }
});

test('code execution fails closed without elicitation support and rejects a changed approved file', async () => {
  const source = "import { test, expect } from '@playwright/test'; test('approval', () => expect(true).toBe(true));";
  const server = createLocalServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'no-elicitation-fixture', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: 'run_playwright_test', arguments: { code: source } });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /cannot provide verifiable human approval/i);
  } finally {
    await client.close();
  }

  const originalDirectory = process.cwd();
  const workspace = await mkdtemp(path.join(tmpdir(), 'qmax-approval-digest-'));
  process.chdir(workspace);
  try {
    await writeFile('approved.spec.ts', source, 'utf8');
    const approval = await describeExecutionApproval({ testPath: 'approved.spec.ts' });
    await writeFile('approved.spec.ts', `${source}\n// changed after approval`, 'utf8');
    await assert.rejects(
      () => runPlaywrightTest({ testPath: 'approved.spec.ts' }, { approvalDigest: approval.digest }),
      /changed after execution authorization/
    );
  } finally {
    process.chdir(originalDirectory);
    await rm(workspace, { recursive: true, force: true });
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
    assert.match(rendered, /--unattended/);
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
