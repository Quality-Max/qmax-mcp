import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generatePlaywrightRepro } from '../dist/tools/generate-playwright-repro.js';
import { renderReport } from '../dist/report.js';
import { describeExecutionApproval, runPlaywrightTest } from '../dist/tools/run-playwright-test.js';
import { scanUrl } from '../dist/tools/scan-url.js';

const format = process.argv.includes('--format') ? process.argv[process.argv.indexOf('--format') + 1] : 'markdown';
if (!['json', 'markdown'].includes(format)) {
  throw new Error('Use --format json or --format markdown.');
}

const root = path.dirname(fileURLToPath(import.meta.url));
const app = await readFile(path.join(root, 'app', 'index.html'));
const server = createServer((request, response) => {
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(app);
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Local demo server did not expose a TCP port.');
const url = `http://127.0.0.1:${address.port}/`;

try {
  const scan = await scanUrl({ url, checks: ['console'], allowPrivateNetwork: true });
  const finding = scan.findings.find((item) => item.category === 'console');
  if (!finding) throw new Error('The intentional console finding was not observed.');

  const generated = await generatePlaywrightRepro({
    url,
    finding,
    testName: 'Demo checkout calculation error remains reproducible',
  });
  // The runner only executes a digest it has already seen approved. A real client obtains that
  // digest from an MCP form elicitation a human accepts; this script computes it for itself, which
  // is why the receipt below records it as a self-assertion rather than as human approval.
  const executionArgs = { testPath: generated.filePath, browser: 'chromium' };
  const approval = await describeExecutionApproval(executionArgs);
  const execution = await runPlaywrightTest(executionArgs, { approvalDigest: approval.digest });
  if (execution.status !== 'failed') {
    throw new Error(`Expected the intentional repro to fail, received ${execution.status}.`);
  }

  const receipt = {
    receiptVersion: 1,
    kind: 'qualitymax-reproducible-demo',
    target: 'dependency-free local fixture on 127.0.0.1',
    scan: {
      checks: scan.checks,
      findingCount: scan.findingCount,
      findings: scan.findings,
    },
    repro: {
      generatedPath: generated.filePath,
      deterministic: true,
    },
    execution: {
      status: execution.status,
      expectedStatus: 'failed',
      summary: execution.summary,
      approvalMechanism: 'demo-self-asserted-digest',
      approvalDigest: approval.digest,
      approvalEvidence:
        'The demo computed and supplied its own execution digest. This is a visible caller assertion, not independent proof of human approval; a real client obtains the digest from an MCP form elicitation a human accepts.',
    },
    limitation:
      'This intentionally failing fixture proves the scan-to-repro path. It does not resolve QUA-1730’s client-verifiable human-approval requirement.',
  };

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(scan)}\n`);
    process.stdout.write('## Generated repro and execution evidence\n\n');
    process.stdout.write(`- Generated: \`${generated.filePath}\`\n`);
    process.stdout.write(`- Executed on Chromium: expected **${execution.status}** result\n`);
    process.stdout.write(`- Execution digest: \`${approval.digest}\`\n`);
    process.stdout.write(
      '- Approval limit: the demo self-asserted this digest. That is not independently verifiable human approval.\n'
    );
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
