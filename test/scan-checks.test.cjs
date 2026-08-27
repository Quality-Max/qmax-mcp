const assert = require('node:assert/strict');
const test = require('node:test');

const { analyzeCookies, observedTrackers, toCookieSignal } = require('../dist/tools/checks/cookies.js');
const { analyzeMixedContent } = require('../dist/tools/checks/mixed-content.js');
const { DEFAULT_WEIGHT_BUDGET, analyzeWeight } = require('../dist/tools/checks/weight.js');
const { analyzeVitals } = require('../dist/tools/checks/vitals.js');
const { formatBytes, mergeResourceSignals, transferBytes } = require('../dist/tools/checks/signals.js');
const { identifyTracker, isThirdParty, registrableDomain } = require('../dist/tools/checks/trackers.js');
const { describeTelemetryFailure, identifyTelemetryRequest, isPlaceholderCredential } = require('../dist/tools/checks/telemetry.js');
const { renderReport } = require('../dist/report.js');
const { assertSelfContainedTest } = require('../dist/tools/run-playwright-test.js');
const { emptySnapshotWarnings, summarizeTestability } = require('../dist/tools/inspect-page.js');
const { SUPPORTED_CHECKS, checkSecurityHeaders, isBenignNavigationAbort, resolveChecks } = require('../dist/tools/scan-url.js');
const { dedupeFindings, diffFindings, findingFingerprint, loadBaselineFindings, scoreFromFindings, withFingerprints } = require('../dist/tools/common.js');
const { describeApprovalFailure } = require('../dist/server.js');

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

test('HSTS is reported as inapplicable, not missing, on a plain-HTTP page', () => {
  // Browsers ignore Strict-Transport-Security over http://, so its absence there
  // is not a fixable defect. Reporting it as medium put an unavoidable penalty on
  // every local scan; mixed_content already downgrades itself for the same reason.
  const http = checkSecurityHeaders({}, 'http://localhost:3000/login');
  const hsts = http.find((finding) => /HSTS|strict-transport/i.test(finding.message));
  assert.equal(hsts.severity, 'info');
  assert.match(hsts.message, /does not apply/);
  // The genuinely actionable header findings still stand on an HTTP page.
  assert.ok(http.some((f) => f.message === 'Missing content-security-policy header.' && f.severity === 'medium'));

  // On HTTPS it remains a real finding.
  const https = checkSecurityHeaders({}, 'https://example.com/');
  const httpsHsts = https.find((finding) => /strict-transport/i.test(finding.message));
  assert.equal(httpsHsts.severity, 'medium');
  assert.match(httpsHsts.message, /^Missing strict-transport-security header\.$/);

  // A present header is never reported, on either scheme.
  assert.equal(
    checkSecurityHeaders({ 'strict-transport-security': 'max-age=63072000' }, 'https://example.com/')
      .some((f) => /strict-transport/i.test(f.message)),
    false
  );
});

test('identical findings collapse into one, and the penalty is charged once', () => {
  // One Sentry SDK with a stub DSN fired the same doomed request three times,
  // which produced three byte-identical high findings and a 3× score penalty
  // for one root cause.
  const finding = {
    severity: 'high',
    category: 'console',
    message: 'error: Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector',
    url: 'https://localhost/api/0/envelope/',
  };
  const deduped = dedupeFindings([
    { ...finding, evidence: { line: 1 } },
    { ...finding, evidence: { line: 2 } },
    { ...finding },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].occurrences, 3);
  // The first observation keeps its evidence; the count is all repetition adds.
  assert.deepEqual(deduped[0].evidence, { line: 1 });
  assert.equal(scoreFromFindings(deduped), 80);
});

test('findings that differ in any identity field stay separate', () => {
  const alt = { severity: 'medium', category: 'accessibility', message: 'Image is missing alt text.', selector: 'img:nth-of-type(1)' };
  const deduped = dedupeFindings([
    alt,
    { ...alt, selector: 'img:nth-of-type(2)' },
    { ...alt, severity: 'low' },
    { ...alt, category: 'seo' },
    { ...alt, message: 'Image is missing alt text?' },
  ]);
  assert.equal(deduped.length, 5);
  // A finding seen once carries no count, and the input is never mutated.
  assert.equal(deduped[0].occurrences, undefined);
  assert.equal(alt.occurrences, undefined);
});

test('router-initiated aborts are recognised; genuine failures are not', () => {
  const abort = (extra) => ({ url: 'http://localhost:13001/login', failure: 'net::ERR_ABORTED', ...extra });

  // The prefetch/RSC fingerprints: purpose headers, the RSC request header,
  // the _rsc search param, and Chromium's own prefetch resource type.
  assert.equal(isBenignNavigationAbort(abort({ headers: { purpose: 'prefetch' } })), true);
  assert.equal(isBenignNavigationAbort(abort({ headers: { 'sec-purpose': 'prefetch;anonymous-client-ip' } })), true);
  assert.equal(isBenignNavigationAbort(abort({ headers: { rsc: '1' } })), true);
  assert.equal(isBenignNavigationAbort(abort({ url: 'http://localhost:13001/login?_rsc=1a2b3' })), true);
  assert.equal(isBenignNavigationAbort(abort({ resourceType: 'prefetch' })), true);

  // A plain abort on a fetch the page needed keeps its severity.
  assert.equal(isBenignNavigationAbort(abort({ resourceType: 'fetch', headers: { accept: '*/*' } })), false);
  // Only aborts qualify: a blocked prefetch is still a blocked request.
  assert.equal(
    isBenignNavigationAbort({
      url: 'http://localhost:13001/x',
      failure: 'net::ERR_BLOCKED_BY_CLIENT.Inspector',
      headers: { purpose: 'prefetch' },
    }),
    false
  );
  // An unparseable URL cannot carry the _rsc fingerprint.
  assert.equal(isBenignNavigationAbort({ url: 'not a url', failure: 'net::ERR_ABORTED' }), false);
});

test('the report says how many times a collapsed finding was seen', () => {
  const base = {
    url: 'https://example.com/',
    score: 90,
    checks: ['console'],
    findingCount: 1,
  };
  const collapsed = renderReport({
    ...base,
    findings: [{ severity: 'medium', category: 'network', message: 'Request failed: net::ERR_ABORTED', occurrences: 3 }],
  });
  assert.match(collapsed, /Request failed: net::ERR_ABORTED \(seen 3 times\)/);

  const single = renderReport({
    ...base,
    findings: [{ severity: 'medium', category: 'network', message: 'Request failed: net::ERR_ABORTED' }],
  });
  assert.match(single, /Request failed: net::ERR_ABORTED\n/);
  assert.equal(single.includes('seen'), false);
});

test('telemetry transports are recognised by request shape, not by host', () => {
  // Both URLs are from one real session. Neither points at the vendor's own
  // domain: Sentry envelopes went to localhost and PostHog config to the app's
  // own port, which is why matching is on path and query rather than hostname.
  const sentry = identifyTelemetryRequest(
    'https://localhost/api/0/envelope/?sentry_version=7&sentry_key=stub&sentry_client=sentry.javascript.nextjs%2F10.47.0'
  );
  assert.equal(sentry.name, 'Sentry');
  assert.equal(sentry.credential.param, 'sentry_key');
  assert.equal(sentry.credential.value, 'stub');
  assert.equal(sentry.placeholderCredential, true);

  const posthog = identifyTelemetryRequest(
    'http://localhost:13001/ingest/array/stub_posthog_token_disabled_for_e2e_0000/config.js'
  );
  assert.equal(posthog.name, 'PostHog');
  assert.equal(posthog.credential.value, 'stub_posthog_token_disabled_for_e2e_0000');
  assert.equal(posthog.placeholderCredential, true);

  // Other vendors on the list, and the shapes that must not match.
  assert.equal(identifyTelemetryRequest('https://www.google-analytics.com/g/collect?tid=G-ABC').name, 'Google Analytics');
  assert.equal(identifyTelemetryRequest('https://rum.example.com/api/v2/rum').name, 'Datadog RUM');
  assert.equal(identifyTelemetryRequest('https://example.com/api/0/users/'), null);
  assert.equal(identifyTelemetryRequest('https://example.com/app.js'), null);
  assert.equal(identifyTelemetryRequest('not a url'), null);
});

test('a real credential is not mistaken for a placeholder', () => {
  // The distinction decides which fix the finding recommends, so a false
  // positive here would tell a team to empty a DSN that is doing its job.
  assert.equal(isPlaceholderCredential('stub'), true);
  assert.equal(isPlaceholderCredential('stub_posthog_token_disabled_for_e2e_0000'), true);
  assert.equal(isPlaceholderCredential('0000000000'), true);
  assert.equal(isPlaceholderCredential('xxxxxxxx'), true);
  assert.equal(isPlaceholderCredential(''), false);
  // A real Sentry public key and a real PostHog token, neither of which
  // contains a placeholder word as a segment.
  assert.equal(isPlaceholderCredential('a1b2c3d4e5f60718293a4b5c6d7e8f90'), false);
  assert.equal(isPlaceholderCredential('phc_pM4tYq7Lz2Rn8Vw3Kd6Jf1Hs5Bx9Cg0'), false);
  // "latest" contains "test" but is not a placeholder segment.
  assert.equal(isPlaceholderCredential('latest'), false);
});

test('a stubbed SDK is named, with the fix that actually disables it', () => {
  const signature = identifyTelemetryRequest('https://localhost/api/0/envelope/?sentry_key=stub');
  const finding = describeTelemetryFailure(signature, 'https://localhost/api/0/envelope/', 'net::ERR_BLOCKED_BY_CLIENT');

  assert.equal(finding.category, 'telemetry');
  assert.match(finding.message, /^Sentry is initialized with a placeholder credential/);
  // The point of the issue: name the one-line fix instead of "fix runtime errors".
  assert.match(finding.suggestion, /prefer an empty DSN\/token/);
  assert.match(finding.suggestion, /sentry_key=stub/);
  assert.equal(finding.evidence.failure, 'net::ERR_BLOCKED_BY_CLIENT');

  // A reachable-but-failing vendor endpoint with a real key gets the other advice.
  const real = identifyTelemetryRequest('https://o1.ingest.sentry.io/api/42/envelope/?sentry_key=a1b2c3d4e5f60718293a4b5c6d7e8f90');
  const realFinding = describeTelemetryFailure(real, 'https://o1.ingest.sentry.io/api/42/envelope/', 'net::ERR_TIMED_OUT');
  assert.match(realFinding.message, /^Sentry telemetry requests fail/);
  assert.match(realFinding.suggestion, /Confirm the Sentry endpoint is reachable/);
});

test('a fingerprint identifies the problem, not the run it was seen in', () => {
  const base = { severity: 'high', category: 'console', message: 'error: boom', url: 'https://example.com/a' };

  // Same problem, reported differently: severity reclassified, seen more often,
  // whitespace and case reflowed. All must hash the same, or a diff would
  // report a change nobody made.
  const id = findingFingerprint(base);
  assert.equal(findingFingerprint({ ...base, severity: 'info' }), id);
  assert.equal(findingFingerprint({ ...base, occurrences: 4 }), id);
  assert.equal(findingFingerprint({ ...base, message: '  ERROR:   boom  ' }), id);

  // Genuinely different problems must not collide.
  assert.notEqual(findingFingerprint({ ...base, url: 'https://example.com/b' }), id);
  assert.notEqual(findingFingerprint({ ...base, category: 'network' }), id);
  assert.notEqual(findingFingerprint({ ...base, message: 'error: other' }), id);

  // Deterministic across calls and short enough to read in a log.
  assert.equal(findingFingerprint(base), id);
  assert.match(id, /^[0-9a-f]{12}$/);
});

test('a baseline diff separates new, fixed, and unchanged', () => {
  const stale = { severity: 'high', category: 'console', message: 'error: gone', url: 'https://example.com/a' };
  const kept = { severity: 'medium', category: 'network', message: 'Request failed: net::ERR_ABORTED', url: 'https://example.com/b' };
  const fresh = { severity: 'high', category: 'console', message: 'error: brand new', url: 'https://example.com/c' };

  const delta = diffFindings([kept, fresh], [stale, kept]);
  assert.deepEqual(delta.new.map((f) => f.message), ['error: brand new']);
  assert.deepEqual(delta.fixed.map((f) => f.message), ['error: gone']);
  assert.deepEqual(delta.unchanged.map((f) => f.message), ['Request failed: net::ERR_ABORTED']);
  assert.equal(delta.verdict, '1 new finding since baseline, 1 finding fixed.');

  // The verdict is the line a CI log shows, so both quiet cases read correctly.
  assert.equal(diffFindings([kept], [kept]).verdict, 'No new findings since baseline.');
  assert.equal(diffFindings([], [kept]).verdict, 'No new findings since baseline; 1 finding fixed.');
  assert.equal(diffFindings([fresh, kept], []).verdict, '2 new findings since baseline.');

  // An unchanged finding keeps a severity reclassification without being
  // reported as fixed-and-new: the fingerprint ignores severity on purpose.
  const reclassified = diffFindings([{ ...kept, severity: 'info' }], [kept]);
  assert.equal(reclassified.new.length, 0);
  assert.equal(reclassified.fixed.length, 0);
  assert.equal(reclassified.unchanged.length, 1);
});

test('withFingerprints keeps an id a finding already carries', () => {
  const [minted] = withFingerprints([{ severity: 'low', category: 'seo', message: 'x' }]);
  assert.match(minted.id, /^[0-9a-f]{12}$/);
  const [preserved] = withFingerprints([{ severity: 'low', category: 'seo', message: 'x', id: 'supplied' }]);
  assert.equal(preserved.id, 'supplied');
});

test('a baseline may be handed over inline, and is validated either way', async () => {
  // The agent loop holds the previous result in memory; a pipeline persists it.
  const findings = [{ severity: 'low', category: 'seo', message: 'Page title is missing or very short.' }];
  assert.deepEqual(await loadBaselineFindings({ findings }), findings);

  // Anything that is not a scan result is rejected by name, not by TypeError.
  await assert.rejects(() => loadBaselineFindings({}), /including its findings array/);
  await assert.rejects(() => loadBaselineFindings({ findings: 'nope' }), /including its findings array/);

  // A baseline path gets the same workspace confinement as storageStatePath.
  await assert.rejects(() => loadBaselineFindings('/etc/passwd'), /baseline must be relative to the active workspace/);
  await assert.rejects(() => loadBaselineFindings('../../etc/passwd'), /baseline (escapes the active workspace|must name an existing workspace file)/);
  await assert.rejects(() => loadBaselineFindings('no-such-baseline.json'), /baseline must name an existing workspace file/);
});

test('the report leads with the baseline verdict', () => {
  const report = renderReport({
    url: 'https://example.com/',
    score: 80,
    checks: ['console'],
    findingCount: 1,
    findings: [{ severity: 'medium', category: 'network', message: 'Request failed: net::ERR_ABORTED' }],
    delta: {
      verdict: '1 new finding since baseline, 2 findings fixed.',
      new: [{ severity: 'high', category: 'console', message: 'error: regression', url: 'https://example.com/a' }],
      fixed: [
        { severity: 'high', category: 'console', message: 'error: gone' },
        { severity: 'low', category: 'seo', message: 'Meta description is missing or very short.' },
      ],
      unchanged: [],
    },
  });

  // The verdict is the question the reader came with, so it sits above the
  // category tables rather than below the findings.
  assert.match(report, /\*\*Since baseline:\*\* 1 new finding since baseline, 2 findings fixed\./);
  assert.match(report, /- New: error: regression \(`https:\/\/example\.com\/a`\)/);
  assert.match(report, /- Fixed: error: gone/);
  assert.ok(report.indexOf('Since baseline') < report.indexOf('| Category |'));

  // Without a baseline the report is unchanged: no empty section appears.
  const plain = renderReport({ url: 'https://example.com/', score: 100, checks: ['seo'], findingCount: 0, findings: [] });
  assert.equal(plain.includes('Since baseline'), false);
test('page testability counts only handles that survive a copy edit', () => {
  const summary = summarizeTestability([
    { stability: 'stable' },
    { stability: 'stable' },
    { stability: 'acceptable' },
    { stability: 'fragile' },
    { stability: 'none' },
  ]);
  // acceptable and fragile deliberately do not count: a text-derived name moves
  // with the copy, and a placeholder-derived one moves with a translation.
  assert.equal(summary.score, 40);
  assert.equal(summary.stable, 2);
  assert.match(summary.note, /1 of 5 controls have no stable handle/);

  // A page whose every control has a handle says nothing extra.
  assert.equal(summarizeTestability([{ stability: 'stable' }]).note, undefined);
  assert.equal(summarizeTestability([{ stability: 'stable' }]).score, 100);

  // A page with no interactive controls is not a 0% testable page.
  assert.equal(summarizeTestability([]).score, 100);
  assert.equal(summarizeTestability([]).note, undefined);
});

test('approval failures name the mode, the outcome, and the way out', () => {
  const base = { digest: 'a'.repeat(64), client: 'test-client' };

  // The four cases used to collapse into two messages, neither of which said
  // which mode the server was in or how to change it.
  const unsupported = describeApprovalFailure({ ...base, reason: 'client-unsupported' });
  assert.match(unsupported, /cannot provide verifiable human approval/);
  assert.match(unsupported, /form elicitation/);

  const declined = describeApprovalFailure({ ...base, reason: 'declined' });
  const cancelled = describeApprovalFailure({ ...base, reason: 'cancelled' });
  const notApproved = describeApprovalFailure({ ...base, reason: 'not-approved' });
  assert.match(declined, /declined by the human reviewer/);
  assert.match(cancelled, /cancelled before an answer/);
  assert.match(notApproved, /answered without granting approval/);
  // Distinguishable from each other, which is the whole point.
  assert.equal(new Set([declined, cancelled, notApproved]).size, 3);

  // Every message states the mode, a digest prefix, the client, and the remedy.
  for (const message of [unsupported, declined, cancelled, notApproved]) {
    assert.match(message, /gated mode/);
    assert.match(message, /digest aaaaaaaaaaaa/);
    assert.match(message, /client test-client/);
    assert.match(message, /--unattended/);
  }
  // The full digest is not echoed; a prefix is enough to correlate.
  assert.equal(declined.includes('a'.repeat(64)), false);
});

test('a test importing from a relative path is rejected before execution', () => {
  // The runner snapshots the source into an isolated directory, so './helpers'
  // stops resolving and the spec fails to *load* — previously surfacing as a
  // module-not-found against a temp path. Say why instead.
  const withImport = "import { test } from '@playwright/test';\nimport { login } from './helpers';\ntest('x', async () => {});";
  assert.throws(() => assertSelfContainedTest(withImport), /relative path \(\.\/helpers\)/);
  assert.throws(() => assertSelfContainedTest(withImport), /playwright\.config are not available/);

  // Bare specifiers are fine — those resolve from the workspace's node_modules.
  assert.doesNotThrow(() =>
    assertSelfContainedTest("import { test, expect } from '@playwright/test';\ntest('x', async () => {});")
  );

  // Import-like prose in comments and string literals is documentation, not a
  // dependency. The fail-fast used to reject these valid self-contained tests.
  assert.doesNotThrow(() =>
    assertSelfContainedTest(
      "// Project mode can import './helpers'.\nconst docs = \"Do not require('../setup') here\";\ntest('x', async () => {});"
    )
  );
  assert.doesNotThrow(() =>
    assertSelfContainedTest("const docs = `Example: import './helpers'`;\ntest('x', async () => {});")
  );
  // A template's raw text is documentation, but ${...} is executable code.
  assert.throws(
    () => assertSelfContainedTest("const helper = `${require('./helpers')}`;"),
    /relative path \(\.\/helpers\)/
  );

  // All three import forms are covered, and parent-relative paths too.
  assert.throws(() => assertSelfContainedTest("const h = require('../helpers');"), /\.\.\/helpers/);
  assert.throws(() => assertSelfContainedTest("import './setup';"), /\.\/setup/);
  assert.throws(() => assertSelfContainedTest("const setup = await import('./setup');"), /\.\/setup/);
  // Every offending path is named, not just the first.
  assert.throws(
    () => assertSelfContainedTest("import a from './a';\nimport b from './b';"),
    /\.\/a, \.\/b/
  );
});
