const assert = require('node:assert/strict');
const test = require('node:test');

const { analyzeCookies, observedTrackers, toCookieSignal } = require('../dist/tools/checks/cookies.js');
const { analyzeMixedContent } = require('../dist/tools/checks/mixed-content.js');
const { DEFAULT_WEIGHT_BUDGET, analyzeWeight } = require('../dist/tools/checks/weight.js');
const { analyzeVitals } = require('../dist/tools/checks/vitals.js');
const { formatBytes, mergeResourceSignals, transferBytes } = require('../dist/tools/checks/signals.js');
const { identifyTracker, isThirdParty, registrableDomain } = require('../dist/tools/checks/trackers.js');
const { renderReport } = require('../dist/report.js');
const { emptySnapshotWarnings } = require('../dist/tools/inspect-page.js');
const { SUPPORTED_CHECKS, resolveChecks } = require('../dist/tools/scan-url.js');

const messages = (findings) => findings.map((finding) => finding.message);
const bySeverity = (findings, severity) => findings.filter((finding) => finding.severity === severity);

function cookie(overrides = {}) {
  return {
    name: 'prefs',
    domain: 'example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    ...overrides,
  };
}

test('cookie values never reach scan output', () => {
  const raw = { ...cookie({ name: 'session', httpOnly: false }), value: 'super-secret-session-token' };

  const signal = toCookieSignal(raw);
  assert.equal('value' in signal, false);

  const findings = analyzeCookies({
    pageUrl: 'https://example.com/',
    cookies: [signal],
    requestUrls: [],
  });
  assert.equal(JSON.stringify(findings).includes('super-secret-session-token'), false);
  assert.match(JSON.stringify(findings), /session/);
});

test('cookie flags are graded by the risk they carry', () => {
  const findings = analyzeCookies({
    pageUrl: 'https://example.com/',
    cookies: [
      cookie({ name: 'cross', sameSite: 'None', secure: false }),
      cookie({ name: 'session_id', httpOnly: false }),
      cookie({ name: 'theme', httpOnly: false }),
      cookie({ name: 'legacy', sameSite: undefined }),
      cookie({ name: 'insecure', secure: false }),
    ],
    requestUrls: [],
  });

  assert.match(messages(findings).join('\n'), /SameSite=None without Secure/);
  assert.equal(bySeverity(findings, 'high').length, 1);

  const mediums = messages(bySeverity(findings, 'medium')).join('\n');
  assert.match(mediums, /session or authentication cookie is readable from JavaScript/);
  assert.match(mediums, /missing the Secure flag/);

  const lows = messages(bySeverity(findings, 'low')).join('\n');
  assert.match(lows, /1 cookie is missing HttpOnly/);
  assert.match(lows, /no explicit SameSite/);
});

test('Secure is only required on HTTPS pages', () => {
  const overHttp = analyzeCookies({
    pageUrl: 'http://localhost:3000/',
    cookies: [cookie({ secure: false })],
    requestUrls: [],
  });
  assert.equal(
    messages(overHttp).some((message) => /Secure flag/.test(message)),
    false
  );
});

test('third-party cookies are detected across subdomains and leading dots', () => {
  const findings = analyzeCookies({
    pageUrl: 'https://shop.example.co.uk/cart',
    cookies: [cookie({ domain: '.example.co.uk' }), cookie({ name: 'ad', domain: '.doubleclick.net' })],
    requestUrls: [],
  });

  const thirdParty = findings.find((finding) => /third-party cookie/.test(finding.message));
  assert.ok(thirdParty);
  assert.equal(thirdParty.message, '1 third-party cookie is set on this page.');
  assert.deepEqual(thirdParty.evidence, ['ad (.doubleclick.net/)']);
});

test('known trackers are inventoried and pre-consent loading is reported', () => {
  const requestUrls = [
    'https://example.com/app.js',
    'https://www.googletagmanager.com/gtm.js',
    'https://www.google-analytics.com/collect',
    'https://www.googletagmanager.com/gtm.js?id=2',
  ];

  assert.deepEqual(
    observedTrackers(requestUrls).map((tracker) => tracker.host),
    ['www.google-analytics.com', 'www.googletagmanager.com']
  );

  const withoutBanner = analyzeCookies({ pageUrl: 'https://example.com/', cookies: [], requestUrls });
  assert.equal(withoutBanner.length, 1);
  assert.equal(withoutBanner[0].severity, 'info');

  const withBanner = analyzeCookies({
    pageUrl: 'https://example.com/',
    cookies: [],
    requestUrls,
    consentBanner: { present: true, selector: '#cookie-bar', excerpt: 'We use cookies. Accept or Reject' },
  });
  const preConsent = withBanner.find((finding) => finding.severity === 'high');
  assert.match(preConsent.message, /Trackers loaded before the consent banner was answered/);
  assert.equal(preConsent.evidence.consentBannerSelector, '#cookie-bar');
  assert.deepEqual(preConsent.evidence.trackersBeforeConsent, ['www.google-analytics.com', 'www.googletagmanager.com']);
});

test('a page with no trackers reports nothing about consent', () => {
  const findings = analyzeCookies({
    pageUrl: 'https://example.com/',
    cookies: [],
    requestUrls: ['https://example.com/app.js'],
    consentBanner: { present: true, selector: '#cookie-bar' },
  });
  assert.deepEqual(findings, []);
});

test('registrable domains tolerate multi-label public suffixes', () => {
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(isThirdParty('cdn.example.com', 'www.example.com'), false);
  assert.equal(isThirdParty('example.org', 'www.example.com'), true);
  assert.equal(identifyTracker('ssl.google-analytics.com').name, 'Google Analytics');
  assert.equal(identifyTracker('notgoogle-analytics.com'), null);
});

test('mixed content separates browser-blocked active resources from passive ones', () => {
  const findings = analyzeMixedContent({
    pageUrl: 'https://example.com/',
    markup: [
      { kind: 'script', url: 'http://cdn.example.net/a.js' },
      { kind: 'stylesheet', url: 'http://cdn.example.net/a.css' },
      { kind: 'iframe', url: 'http://legacy.example.net/frame' },
      { kind: 'image', url: 'http://cdn.example.net/hero.png' },
      { kind: 'media', url: 'http://cdn.example.net/clip.mp4' },
      { kind: 'form-action', url: 'http://forms.example.net/submit' },
      { kind: 'script', url: 'https://cdn.example.net/secure.js' },
    ],
    resources: [{ url: 'ws://live.example.net/socket', resourceType: 'websocket', timingAvailable: false }],
  });

  const active = findings.find((finding) => /active mixed-content/.test(finding.message));
  assert.equal(active.severity, 'high');
  assert.equal(active.evidence.length, 4);
  assert.ok(active.evidence.includes('ws://live.example.net/socket'));

  const passive = findings.find((finding) => /passive mixed-content/.test(finding.message));
  assert.equal(passive.severity, 'medium');
  assert.equal(passive.evidence.length, 2);

  const form = findings.find((finding) => /insecure HTTP endpoint/.test(finding.message));
  assert.equal(form.severity, 'high');
});

test('mixed content is reported as not applicable on an HTTP page', () => {
  const findings = analyzeMixedContent({
    pageUrl: 'http://example.com/',
    markup: [{ kind: 'script', url: 'http://cdn.example.net/a.js' }],
    resources: [],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'info');
  assert.match(findings[0].message, /does not apply/);
});

test('page weight measures the budget, third parties, and the slowest requests', () => {
  const resources = [
    { url: 'https://example.com/', resourceType: 'document', transferSize: 20_000, timingAvailable: true, durationMs: 120 },
    {
      url: 'https://example.com/app.js',
      resourceType: 'script',
      transferSize: 300_000,
      contentType: 'application/javascript',
      contentEncoding: 'br',
      timingAvailable: true,
      durationMs: 90,
    },
    { url: 'https://cdn.other.com/hero.png', resourceType: 'image', transferSize: 700_000, timingAvailable: true, durationMs: 400 },
    {
      url: 'https://example.com/style.css',
      resourceType: 'stylesheet',
      transferSize: 40_000,
      contentType: 'text/css',
      timingAvailable: true,
      durationMs: 30,
    },
  ];

  const { findings, metrics } = analyzeWeight({
    pageUrl: 'https://example.com/',
    resources,
    renderBlocking: [],
    budget: { totalBytes: 500_000 },
  });

  assert.equal(metrics.totalBytes, 1_060_000);
  assert.equal(metrics.requestCount, 4);
  assert.equal(metrics.totalBytesComplete, true);
  assert.equal(metrics.bytesByResourceType.script, 300_000);
  assert.deepEqual(metrics.thirdPartyOrigins, [{ host: 'cdn.other.com', bytes: 700_000, requests: 1, tracker: undefined }]);
  assert.equal(metrics.slowestRequests[0].url, 'https://cdn.other.com/hero.png');
  assert.equal(metrics.budget.requestCount, DEFAULT_WEIGHT_BUDGET.requestCount);

  const text = messages(findings).join('\n');
  assert.match(text, /over the 500 kB budget/);
  assert.match(text, /1 image exceeds 500 kB/);
  assert.match(text, /1 script exceeds 250 kB/);
  assert.match(text, /1 text resource is served without compression/);
  assert.match(text, /cdn\.other\.com accounts for 700 kB/);
  // The Brotli-encoded script must not be reported as uncompressed.
  assert.equal(findings.find((finding) => /without compression/.test(finding.message)).evidence.length, 1);
});

test('page weight flags render-blocking head resources over budget', () => {
  const { findings } = analyzeWeight({
    pageUrl: 'https://example.com/',
    resources: [],
    renderBlocking: Array.from({ length: 6 }, (_, index) => ({ kind: 'script', url: `https://example.com/${index}.js` })),
  });
  const blocking = findings.find((finding) => /render-blocking/.test(finding.message));
  assert.equal(blocking.severity, 'medium');
  assert.match(blocking.message, /6 render-blocking resources in <head>, over the 5 budget/);
});

test('withheld cross-origin sizes are reported as a lower bound, not silently dropped', () => {
  const { metrics } = analyzeWeight({
    pageUrl: 'https://example.com/',
    resources: [
      { url: 'https://cdn.other.com/a.js', resourceType: 'script', timingAvailable: false },
      { url: 'https://example.com/b.js', resourceType: 'script', transferSize: 1_000, timingAvailable: true },
    ],
    renderBlocking: [],
  });
  assert.equal(metrics.totalBytes, 1_000);
  assert.equal(metrics.totalBytesComplete, false);
});

test('transfer size falls back to content-length when resource timing is withheld', () => {
  assert.equal(transferBytes({ url: 'x', resourceType: 'script', contentLength: 900, timingAvailable: false }), 900);
  assert.equal(transferBytes({ url: 'x', resourceType: 'script', transferSize: 50, timingAvailable: true }), 50);
  assert.equal(transferBytes({ url: 'x', resourceType: 'script', timingAvailable: false }), 0);
  assert.equal(formatBytes(1_500_000), '1.5 MB');
  assert.equal(formatBytes(2_048), '2 kB');
  assert.equal(formatBytes(512), '512 B');
});

test('response events and resource timings merge into one inventory', () => {
  const merged = mergeResourceSignals(
    [
      {
        url: 'https://example.com/app.js?token=abc123',
        resourceType: 'script',
        status: 200,
        contentType: 'application/javascript',
        contentLength: 400,
      },
      { url: 'https://cdn.other.com/tao-less.js', resourceType: 'script', status: 200 },
    ],
    [
      { url: 'https://example.com/app.js?token=abc123', transferSize: 512, encodedBodySize: 480, durationMs: 12 },
      { url: 'https://cdn.other.com/tao-less.js', transferSize: 0, encodedBodySize: 0 },
      { url: 'https://example.com/late.png', initiatorType: 'img', transferSize: 90 },
    ],
    (url) => url.split('?')[0]
  );

  assert.equal(merged.length, 3);

  const app = merged.find((resource) => resource.url.endsWith('app.js'));
  assert.equal(app.url, 'https://example.com/app.js', 'display URL must be used, not the raw one');
  assert.equal(app.timingAvailable, true);
  assert.equal(app.transferSize, 512);
  assert.equal(app.contentType, 'application/javascript');

  const withheld = merged.find((resource) => resource.url.endsWith('tao-less.js'));
  assert.equal(withheld.timingAvailable, false);

  const timingOnly = merged.find((resource) => resource.url.endsWith('late.png'));
  assert.equal(timingOnly.resourceType, 'image', 'initiator type must map onto a resource type');
});

test('Core Web Vitals are graded against Google thresholds', () => {
  const good = analyzeVitals({ lcpMs: 1200, clsScore: 0.02, fcpMs: 900, ttfbMs: 300, domContentLoadedMs: 1000, loadMs: 1500 }, 'https://example.com/');
  assert.deepEqual(good.findings, []);
  assert.equal(good.metrics.inpMs, null);
  assert.match(good.metrics.notes.join(' '), /INP is not measured/);

  const mixed = analyzeVitals(
    { lcpMs: 3000, clsScore: 0.4, fcpMs: 2000, ttfbMs: 9000, domContentLoadedMs: 5000, loadMs: 9000 },
    'https://example.com/'
  );
  const byLabel = Object.fromEntries(mixed.findings.map((finding) => [finding.message.split(' is ')[0], finding]));
  assert.equal(byLabel['Largest Contentful Paint'].severity, 'low', '3000ms LCP needs improvement but is not poor');
  assert.equal(byLabel['Cumulative Layout Shift'].severity, 'medium');
  assert.equal(byLabel['First Contentful Paint'].severity, 'low');
  assert.equal(byLabel['Time to First Byte'].severity, 'high', '9000ms TTFB is more than double the poor threshold');
  assert.equal(mixed.findings.every((finding) => finding.category === 'performance'), true);
});

test('unavailable vitals are skipped rather than guessed', () => {
  const { findings, metrics } = analyzeVitals(
    { lcpMs: null, clsScore: null, fcpMs: null, ttfbMs: null, domContentLoadedMs: null, loadMs: null },
    'https://example.com/'
  );
  assert.deepEqual(findings, []);
  assert.equal(metrics.lcpMs, null);
  assert.equal(
    metrics.notes.some((note) => /LCP is its value/.test(note)),
    false
  );
});

test('the Markdown report renders the new categories and measured values', () => {
  const report = renderReport(
    {
      url: 'https://example.com/',
      score: 70,
      checks: ['cookies', 'mixed_content', 'weight', 'performance'],
      findingCount: 1,
      findings: [{ severity: 'medium', category: 'cookies', message: '1 cookie is missing the Secure flag on an HTTPS page.' }],
      metrics: {
        vitals: {
          lcpMs: 2600,
          clsScore: 0.12,
          fcpMs: 900,
          ttfbMs: 200,
          domContentLoadedMs: 1000,
          loadMs: 1200,
          inpMs: null,
          notes: ['INP is not measured: Interaction to Next Paint requires real user interaction.'],
        },
        weight: {
          totalBytes: 1_200_000,
          requestCount: 42,
          totalBytesComplete: false,
          bytesByResourceType: { script: 900_000 },
          thirdPartyOrigins: [
            { host: 'cdn.other.com', bytes: 400_000, requests: 3 },
            { host: 'blocked.other.com', bytes: 0, requests: 1 },
          ],
          slowestRequests: [{ url: 'https://cdn.other.com/a.js', durationMs: 800, bytes: 400_000, resourceType: 'script' }],
          budget: DEFAULT_WEIGHT_BUDGET,
        },
      },
    },
    { now: new Date('2026-08-04T00:00:00Z') }
  );

  assert.match(report, /\| Cookies and trackers \| `█+░*` 1 \|/);
  assert.match(report, /\| Mixed content \| `░+` 0 \|/);
  assert.match(report, /\| Page weight \| `░+` 0 \|/);
  assert.match(report, /^`█{17}░{7}` 70 \/ 100$/m, 'the score meter is scaled to 100 and rendered monospace');
  assert.match(report, /Where the bytes went:\n\n```\nscript {2}█{16} {2}900 kB\n```/);
  assert.match(report, /## Measurements/);
  assert.match(report, /Largest Contentful Paint \| 2600ms/);
  assert.match(report, /Interaction to Next Paint \| not measured/);
  assert.match(report, /Page transfer \| 1\.2 MB \(lower bound\) across 42 requests/);
  assert.match(report, /Heaviest third parties \| cdn\.other\.com 400 kB/);
  assert.equal(report.includes('blocked.other.com'), false, 'origins with no measured bytes are noise');
  assert.match(report, /Slowest request \| 800ms/);
});

test('reports without metrics omit the measurements section', () => {
  const report = renderReport({
    url: 'https://example.com/',
    score: 100,
    checks: ['seo'],
    findingCount: 0,
    findings: [],
  });
  assert.equal(report.includes('## Measurements'), false);
  assert.equal(report.includes('Where the bytes went'), false);
  assert.match(report, /^`█{24}` 100 \/ 100$/m);
  // With nothing to compare against, a bar in every row would imply a magnitude that is not there.
  assert.match(report, /\| SEO \| 0 \|/);
});

test('unknown check names are rejected instead of silently skipped', () => {
  // A misspelling used to match no `checks.has()` branch, so the check never ran
  // while its name was still echoed back. With every name unknown, nothing ran
  // at all and the scan still scored 100 — a clean result for zero work, which
  // fails open for anything gating on `score` or `findingCount`.
  assert.throws(() => resolveChecks(['security-headers']), /Unknown scan check\(s\): security-headers/);
  assert.throws(() => resolveChecks(['security-headers']), /Supported checks: .*security_headers/);

  // A valid name alongside an invalid one must fail too: previously the good one
  // ran and the typo was dropped, so the caller got a partial scan reported as
  // if it were the scan they asked for.
  assert.throws(() => resolveChecks(['accessibility', 'totally-bogus-name']), /totally-bogus-name/);
});

test('supported check names resolve, and are normalised', () => {
  assert.deepEqual([...resolveChecks(['accessibility'])], ['accessibility']);
  assert.deepEqual([...resolveChecks(['  Accessibility  ', 'SEO'])], ['accessibility', 'seo']);
  // Duplicates collapse rather than running a check twice.
  assert.deepEqual([...resolveChecks(['seo', 'seo'])], ['seo']);
});

test('omitting checks runs every supported check', () => {
  assert.deepEqual([...resolveChecks(undefined)], [...SUPPORTED_CHECKS]);
  assert.deepEqual([...resolveChecks([])], [...SUPPORTED_CHECKS]);
  // Whitespace-only entries are not a request for "no checks" — that would be a
  // silent empty scan, which is the bug this guards.
  assert.deepEqual([...resolveChecks(['   '])], [...SUPPORTED_CHECKS]);
});

test('every supported check name is reachable in scan-url', () => {
  // Guards the list against drifting from the branches that consume it: a name
  // present here but absent from scan-url would silently never run.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'dist', 'tools', 'scan-url.js'),
    'utf8',
  );
  for (const check of SUPPORTED_CHECKS) {
    assert.ok(source.includes(`'${check}'`), `${check} is not referenced in scan-url`);
  }
});

test('an empty inspect_page snapshot is explained, a populated one is not', () => {
  // The bug: all-empty arrays with no explanation read as authoritative, so
  // "page has no controls" and "page had not rendered yet" were indistinguishable.
  const empty = emptySnapshotWarnings({ headings: 0, interactive: 0, forms: 0 }, 3);
  assert.equal(empty.length, 1);
  // The node count is the part that disambiguates: 3 nodes is an empty shell.
  assert.match(empty[0], /3 DOM nodes/);
  assert.match(empty[0], /mid-render/);

  // Any one signal of content is enough to stay quiet — no noise on real pages.
  assert.deepEqual(emptySnapshotWarnings({ headings: 1, interactive: 0, forms: 0 }, 102), []);
  assert.deepEqual(emptySnapshotWarnings({ headings: 0, interactive: 11, forms: 0 }, 102), []);
  assert.deepEqual(emptySnapshotWarnings({ headings: 0, interactive: 0, forms: 1 }, 102), []);
});
