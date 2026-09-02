const assert = require('node:assert/strict');
const { access, readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('README leads with the agent-first local QA promise and canonical command', async () => {
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  const opening = readme.slice(0, 1500).toLowerCase();

  assert.match(readme, /npx -y @qualitymax\/qmax-mcp/);
  assert.match(opening, /independent qa evidence before it declares a web change done/);
  assert.match(opening, /require no qualitymax account/);
  assert.doesNotMatch(opening, /9lives/);
  for (const tool of ['scan_url', 'inspect_page', 'generate_playwright_repro', 'run_playwright_test']) {
    assert.match(readme, new RegExp(`\\\`${tool}\\\``));
  }
});

test('launch kit keeps reproducible proof, safety, comparison, and disclosure assets linked', async () => {
  const assets = [
    'demo/app/index.html',
    'demo/flow.svg',
    'demo/run.mjs',
    'demo/record.mjs',
    'demo/scan-to-repro.cast',
    'demo/quality-receipt.example.json',
    'demo/quality-receipt.example.md',
    'demo/README.md',
    'docs/launch/architecture.svg',
    'docs/launch/competitor-comparison.md',
    'docs/launch/launch-checklist.md',
  ];
  await Promise.all(assets.map((asset) => access(path.join(root, asset))));

  const [demo, comparison, checklist, jsonReceipt, markdownReceipt] = await Promise.all([
    readFile(path.join(root, 'demo/README.md'), 'utf8'),
    readFile(path.join(root, 'docs/launch/competitor-comparison.md'), 'utf8'),
    readFile(path.join(root, 'docs/launch/launch-checklist.md'), 'utf8'),
    readFile(path.join(root, 'demo/quality-receipt.example.json'), 'utf8'),
    readFile(path.join(root, 'demo/quality-receipt.example.md'), 'utf8'),
  ]);
  assert.match(demo, /dependency-free local fixture/i);
  assert.match(demo, /not a verifiable record of a human client approval/i);
  assert.equal(JSON.parse(jsonReceipt).execution.expectedStatus, 'failed');
  assert.match(markdownReceipt, /Demo checkout calculation failed/);
  assert.match(comparison, /Last verified: \*\*2026-08-03\*\*/);
  for (const competitor of ['TestSprite', 'BrowserStack', 'mabl', 'Momentic']) {
    assert.match(comparison, new RegExp(competitor));
  }
  assert.match(checklist, /GitHub Issues/);
  assert.match(checklist, /SECURITY\.md/);
});

test('the qmax.run site is deployable and points back to the canonical package', async () => {
  await Promise.all([
    access(path.join(root, 'site', 'favicon.svg')),
    access(path.join(root, 'site', 'social-card.png')),
  ]);

  const [site, installer, vercelConfig, packageJson, manifest, smithery] = await Promise.all([
    readFile(path.join(root, 'site', 'index.html'), 'utf8'),
    readFile(path.join(root, 'site', 'install.sh'), 'utf8'),
    readFile(path.join(root, 'site', 'vercel.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'server.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'smithery.yaml'), 'utf8'),
  ]);

  assert.equal(packageJson.homepage, 'https://qmax.run');
  assert.equal(manifest.websiteUrl, 'https://qmax.run');
  assert.match(smithery, /^homepage: https:\/\/qmax\.run$/m);
  assert.match(site, /<link rel="canonical" href="https:\/\/qmax\.run\/"/);
  assert.match(site, /<meta property="og:image" content="https:\/\/qmax\.run\/social-card\.png"/);
  assert.match(site, /<meta property="og:image:width" content="1200"/);
  assert.match(site, /<meta property="og:image:height" content="630"/);
  assert.match(site, /<meta property="og:image:alt" content="qmax by QualityMax/);
  assert.match(site, /<meta name="twitter:image" content="https:\/\/qmax\.run\/social-card\.png"/);
  assert.match(site, /npx -y @qualitymax\/qmax-mcp/);
  assert.match(site, /https:\/\/github\.com\/Quality-Max\/qmax-mcp/);
  assert.match(site, /https:\/\/9lives\.run/);
  assert.match(site, /https:\/\/github\.com\/Quality-Max\/qmax-code/);
  assert.match(site, /https:\/\/github\.com\/Quality-Max\/qualitymax-grader/);
  assert.match(site, /https:\/\/github\.com\/Quality-Max\/free-qa-skills/);
  assert.match(site, /https:\/\/qualitymax\.io/);
  assert.equal((site.match(/class="brand" href="https:\/\/qualitymax\.io"/g) ?? []).length, 2);
  assert.match(site, /curl -sL qmax\.run \| sh/);
  assert.match(installer, /package='@qualitymax\/qmax-mcp'/);
  assert.match(installer, /npm install --global "\$\{package\}"/);
  assert.equal(vercelConfig.cleanUrls, true);
  assert.deepEqual(vercelConfig.redirects, [
    {
      source: '/',
      destination: '/install.sh',
      permanent: false,
      missing: [{ type: 'header', key: 'accept', value: '.*text/html.*' }],
    },
  ]);
  assert.match(JSON.stringify(vercelConfig), /Content-Security-Policy/);
  assert.match(JSON.stringify(vercelConfig), /Strict-Transport-Security/);
});

test('the site console demo replays the recording the demo actually produced', async () => {
  const [siteCast, demoCast, site, siteJs] = await Promise.all([
    readFile(path.join(root, 'site', 'demo.cast'), 'utf8'),
    readFile(path.join(root, 'demo', 'scan-to-repro.cast'), 'utf8'),
    readFile(path.join(root, 'site', 'index.html'), 'utf8'),
    readFile(path.join(root, 'site', 'site.js'), 'utf8'),
  ]);

  // Byte-identical by construction: record.mjs writes both. If they diverge,
  // the site is showing a run the repository cannot vouch for.
  assert.equal(siteCast, demoCast);

  const [header, ...events] = siteCast.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(header.version, 2);
  // Paced, not pasted: one giant frame is what this recording used to be.
  assert.ok(events.length > 50, `expected a line-paced recording, got ${events.length} events`);
  const transcript = events.map(([, , data]) => data).join('');
  for (const tool of ['scan_url', 'inspect_page', 'generate_playwright_repro', 'run_playwright_test']) {
    assert.match(transcript, new RegExp(tool));
  }

  assert.match(site, /data-demo-screen/);
  assert.match(site, /data-demo-play/);
  // The player fetches the same-origin cast; the CSP only allows 'self'.
  assert.match(siteJs, /fetch\('demo\.cast'\)/);
  assert.match(siteJs, /prefers-reduced-motion/);
});
