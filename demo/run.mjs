import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generatePlaywrightRepro } from '../dist/tools/generate-playwright-repro.js';
import { renderReport } from '../dist/report.js';
import { inspectPage } from '../dist/tools/inspect-page.js';
import { describeExecutionApproval, runPlaywrightTest } from '../dist/tools/run-playwright-test.js';
import { scanUrl } from '../dist/tools/scan-url.js';

const format = process.argv.includes('--format') ? process.argv[process.argv.indexOf('--format') + 1] : 'markdown';
if (!['json', 'markdown'].includes(format)) {
  throw new Error('Use --format json or --format markdown.');
}

const root = path.dirname(fileURLToPath(import.meta.url));
const app = await readFile(path.join(root, 'app', 'index.html'), 'utf8');

// Generated rather than committed so the repository does not carry a padding file. The content is
// deterministic, and it is over the 10 kB floor at which the weight check reports missing
// compression.
const heavyScript = `// Demo bundle standing in for an oversized, uncompressed application script.\n${'globalThis.__qmaxDemoPadding = globalThis.__qmaxDemoPadding || [];\n'.repeat(260)}`;
const styles = `:root{--ink:#14213d;--line:#dfe4ee;--brand:#217a45}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);margin:0;background:#f6f8fb}
.bar{display:flex;align-items:center;gap:.75rem;padding:.9rem 1.5rem;background:#fff;border-bottom:1px solid var(--line)}
.bar nav{margin-left:auto;display:flex;gap:1rem}
.bar a{color:#3159a7;text-decoration:none}
main{max-width:42rem;margin:0 auto;padding:2rem 1.5rem 3rem}
h1{margin:0 0 .4rem;font-size:1.7rem}
.lede{margin:0 0 1.5rem;color:#52596b;line-height:1.5}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:1.1rem 1.25rem;margin-bottom:1rem}
.card h2{margin:0 0 .8rem;font-size:1rem;text-transform:uppercase;letter-spacing:.04em;color:#52596b}
.lines{width:100%;border-collapse:collapse}
.lines td{padding:.45rem 0;border-bottom:1px solid var(--line)}
.lines .num{text-align:right;font-variant-numeric:tabular-nums}
.lines .total td{font-weight:700;border-bottom:none}
form{display:flex;gap:.5rem;margin-bottom:.75rem}
input{flex:1;padding:.6rem .7rem;border:1px solid var(--line);border-radius:8px;font:inherit}
button{font:inherit;border-radius:8px;border:1px solid var(--line);background:#fff;padding:.6rem .8rem;cursor:pointer}
button.icon{width:2.6rem}
button.primary{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600;width:100%}
`;
const logo = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="20" fill="#217a45"/></svg>\n';

// The fixture sets cookies that are missing the flags the cookie check looks for.
const cookies = ['demo_session=fixture-session-value; Path=/', 'demo_theme=dark; Path=/; SameSite=Lax'];

const routes = {
  '/styles.css': { type: 'text/css; charset=utf-8', body: styles },
  '/heavy.js': { type: 'application/javascript; charset=utf-8', body: heavyScript },
  '/logo.svg': { type: 'image/svg+xml; charset=utf-8', body: logo },
  '/pricing': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>Pricing</title><h1>Pricing</h1>' },
};

const server = createServer((request, response) => {
  const route = (request.url ?? '').split('?')[0];

  if (route === '/' || route === '/index.html') {
    // No compression and no security headers, both of which the scan reports.
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': cookies });
    response.end(app);
    return;
  }
  const asset = routes[route];
  if (asset) {
    response.writeHead(200, { 'content-type': asset.type });
    response.end(asset.body);
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Local demo server did not expose a TCP port.');
const url = `http://127.0.0.1:${address.port}/`;

/** Budget deliberately set below the fixture's size so the weight check has something to report. */
const weightBudget = { totalBytes: 15_000, renderBlocking: 1, scriptBytes: 15_000 };

try {
  // 1. scan_url — every check, in one page load.
  const scan = await scanUrl({ url, allowPrivateNetwork: true, weightBudget, screenshot: true });
  const finding = scan.findings.find((item) => item.category === 'console');
  if (!finding) throw new Error('The intentional console finding was not observed.');

  // 2. inspect_page — the structure an agent needs to write a locator.
  const inspected = await inspectPage({ url, allowPrivateNetwork: true, includeForms: true });
  const locatorCandidates = inspected.interactive.filter((item) => item.recommendedLocator).slice(0, 5);

  // 3. generate_playwright_repro — a deterministic repro for one finding.
  const generated = await generatePlaywrightRepro({
    url,
    finding,
    testName: 'Demo checkout calculation error remains reproducible',
  });

  // 4. run_playwright_test — the runner only executes a digest it has already seen approved. A real
  // client obtains that digest from an MCP form elicitation a human accepts; this script computes it
  // for itself, which is why the receipt records it as a self-assertion rather than human approval.
  const executionArgs = { testPath: generated.filePath, browser: 'chromium' };
  const approval = await describeExecutionApproval(executionArgs);
  const execution = await runPlaywrightTest(executionArgs, { approvalDigest: approval.digest });
  if (execution.status !== 'failed') {
    throw new Error(`Expected the intentional repro to fail, received ${execution.status}.`);
  }

  const categories = [...new Set(scan.findings.map((item) => item.category))].sort();
  const receipt = {
    receiptVersion: 2,
    kind: 'qualitymax-reproducible-demo',
    target: 'dependency-free local fixture on 127.0.0.1',
    tools: ['scan_url', 'inspect_page', 'generate_playwright_repro', 'run_playwright_test'],
    scan: {
      checks: scan.checks,
      weightBudget,
      score: scan.score,
      findingCount: scan.findingCount,
      categoriesReported: categories,
      metrics: scan.metrics,
      screenshotPath: scan.screenshotPath,
      findings: scan.findings,
    },
    inspect: {
      title: inspected.title,
      headingCount: inspected.headings.length,
      interactiveCount: inspected.interactive.length,
      formCount: inspected.forms.length,
      locatorCandidates: locatorCandidates.map((item) => item.recommendedLocator),
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
    limitations: [
      'The fixture is served over HTTP on loopback, so the mixed_content check correctly reports itself as not applicable and no third-party trackers or cookies can appear.',
      'Core Web Vitals are measured against a local fixture on this machine, so they are fast by construction and are shown as measurements rather than as a passing grade.',
      'The weight budget is deliberately set below the fixture size to demonstrate the check. It is not a recommended budget.',
      'The intentionally failing repro proves the scan-to-repro path. It does not resolve QUA-1730’s client-verifiable human-approval requirement.',
    ],
  };

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    process.stdout.write('# QualityMax MCP demo — all four tools, one run\n\n');
    process.stdout.write('| # | Tool | What it produced here |\n');
    process.stdout.write('|:-:|------|------------------------|\n');
    process.stdout.write(
      `| 1 | \`scan_url\` | ${scan.findingCount} findings across ${categories.length} categories, graded, with measurements |\n`
    );
    process.stdout.write(
      `| 2 | \`inspect_page\` | ${inspected.interactive.length} interactive elements, ${inspected.forms.length} form, role/name locators |\n`
    );
    process.stdout.write(`| 3 | \`generate_playwright_repro\` | \`${generated.filePath}\` |\n`);
    process.stdout.write(`| 4 | \`run_playwright_test\` | expected **${execution.status}** on Chromium |\n\n`);

    const count = (value, noun) => `${value} ${noun}${value === 1 ? '' : 's'}`;

    process.stdout.write('---\n\n');
    process.stdout.write(`${renderReport(scan)}\n`);

    process.stdout.write('---\n\n## Page structure — `inspect_page`\n\n');
    process.stdout.write(`Title: **${inspected.title}** · ${count(inspected.headings.length, 'heading')} · `);
    process.stdout.write(`${count(inspected.forms.length, 'form')} · ${count(inspected.interactive.length, 'interactive element')}\n\n`);
    process.stdout.write('Suggested locators, preferring role and accessible name:\n\n');
    for (const candidate of locatorCandidates) {
      process.stdout.write(`- \`${candidate.recommendedLocator}\`\n`);
    }

    process.stdout.write('\n---\n\n## Repro and executed evidence\n\n');
    process.stdout.write(`- Generated: \`${generated.filePath}\`\n`);
    process.stdout.write(`- Executed on Chromium: expected **${execution.status}** result\n`);
    process.stdout.write(`- Execution digest: \`${approval.digest}\`\n`);
    process.stdout.write(
      '- Approval limit: the demo self-asserted this digest. That is not independently verifiable human approval.\n\n'
    );

    process.stdout.write('---\n\n## What this run does not show\n\n');
    for (const limitation of receipt.limitations) {
      process.stdout.write(`- ${limitation}\n`);
    }
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
