const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

test('proxy forwards hosted tool discovery and calls unchanged', async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    request.setEncoding('utf8');
    for await (const chunk of request) body += chunk;

    requests.push({
      authorization: request.headers.authorization,
      body: JSON.parse(body),
    });

    if (requests.length === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { tools: [{ name: 'bugsink_summary' }] },
        })}\n\n`
      );
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: 'bounded summary' }] },
      })
    );
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.ok(address);

  const child = spawn(
    process.execPath,
    [
      path.resolve(__dirname, '../dist/index.js'),
      'proxy',
      '--api-key',
      'test-api-key',
      '--url',
      `http://127.0.0.1:${address.port}/api/mcp`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const listRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const callRequest = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'bugsink_summary', arguments: { project: 'qmax-code' } },
  };
  child.stdin.end(`${JSON.stringify(listRequest)}\n${JSON.stringify(callRequest)}\n`);

  const [exitCode] = await once(child, 'close');
  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(
    requests.map(({ body }) => body),
    [listRequest, callRequest]
  );
  assert.deepEqual(
    requests.map(({ authorization }) => authorization),
    ['Bearer test-api-key', 'Bearer test-api-key']
  );

  const responses = stdout.trim().split('\n').map(JSON.parse);
  assert.equal(responses[0].result.tools[0].name, 'bugsink_summary');
  assert.equal(responses[1].result.content[0].text, 'bounded summary');
});
