import type { Finding } from '../common';
import type { CookieSignal } from './signals';
import { hostOf, identifyTracker, isThirdParty, type TrackerCategory } from './trackers';

export type CookieCheckInput = {
  /** Display-safe URL of the scanned page. */
  pageUrl: string;
  cookies: CookieSignal[];
  /** Every request URL observed while loading the page. */
  requestUrls: string[];
  /** Set when the page renders an overlay that looks like a cookie/consent banner. */
  consentBanner?: { present: boolean; selector?: string; excerpt?: string };
};

export type TrackerObservation = {
  host: string;
  name: string;
  category: TrackerCategory;
};

/** Cookie names that usually carry authentication or session state. */
const SESSION_COOKIE = /(^|[._-])(sess|session|sid|auth|token|jwt|login|remember|csrf)([._-]|$)/i;

/**
 * Reduce a browser cookie to the metadata the scan may report.
 *
 * Cookie values are dropped here and never enter a `Finding`. This function is the single place
 * that boundary is enforced.
 */
export function toCookieSignal(cookie: {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expires?: number;
}): CookieSignal {
  return {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expires: cookie.expires,
  };
}

/** Known trackers contacted while loading the page, de-duplicated by host. */
export function observedTrackers(requestUrls: string[]): TrackerObservation[] {
  const seen = new Map<string, TrackerObservation>();
  for (const url of requestUrls) {
    const host = hostOf(url);
    if (!host || seen.has(host)) continue;
    const tracker = identifyTracker(host);
    if (tracker) seen.set(host, { host, ...tracker });
  }
  return Array.from(seen.values()).sort((a, b) => a.host.localeCompare(b.host));
}

function describe(cookie: CookieSignal): string {
  return `${cookie.name} (${cookie.domain}${cookie.path})`;
}

/** Audit cookies and third-party trackers observed during the scan. */
export function analyzeCookies(input: CookieCheckInput): Finding[] {
  const findings: Finding[] = [];
  const pageHost = hostOf(input.pageUrl);
  const isHttps = input.pageUrl.startsWith('https://');
  const applicationSteps = `1. Open ${input.pageUrl}\n2. Open DevTools → Application → Cookies\n3. Compare the flags on the listed cookies`;

  const group = (
    matched: CookieSignal[],
    severity: Finding['severity'],
    message: (count: number) => string,
    suggestion: string
  ) => {
    if (matched.length === 0) return;
    findings.push({
      severity,
      category: 'cookies',
      message: message(matched.length),
      evidence: matched.map(describe),
      repro: applicationSteps,
      suggestion,
    });
  };

  group(
    input.cookies.filter((cookie) => cookie.sameSite === 'None' && !cookie.secure),
    'high',
    (count) => `${count} cookie${count === 1 ? ' is' : 's are'} SameSite=None without Secure.`,
    'Browsers reject SameSite=None without Secure. Set Secure, or use SameSite=Lax when cross-site delivery is not required.'
  );

  if (isHttps) {
    group(
      input.cookies.filter((cookie) => !cookie.secure),
      'medium',
      (count) => `${count} cookie${count === 1 ? ' is' : 's are'} missing the Secure flag on an HTTPS page.`,
      'Set Secure so the cookie is never sent over plaintext HTTP.'
    );
  }

  group(
    input.cookies.filter((cookie) => SESSION_COOKIE.test(cookie.name) && !cookie.httpOnly),
    'medium',
    (count) => `${count} session or authentication cookie${count === 1 ? ' is' : 's are'} readable from JavaScript.`,
    'Set HttpOnly on session and authentication cookies so injected script cannot exfiltrate them.'
  );

  group(
    input.cookies.filter((cookie) => !cookie.httpOnly && !SESSION_COOKIE.test(cookie.name)),
    'low',
    (count) => `${count} cookie${count === 1 ? ' is' : 's are'} missing HttpOnly.`,
    'Set HttpOnly unless client-side JavaScript genuinely needs to read the cookie.'
  );

  group(
    input.cookies.filter((cookie) => !cookie.sameSite),
    'low',
    (count) => `${count} cookie${count === 1 ? ' has' : 's have'} no explicit SameSite attribute.`,
    'Declare SameSite explicitly instead of relying on the browser default, which varies by client.'
  );

  if (pageHost) {
    group(
      input.cookies.filter((cookie) => isThirdParty(cookie.domain.replace(/^\./, ''), pageHost)),
      'medium',
      (count) => `${count} third-party cookie${count === 1 ? ' is' : 's are'} set on this page.`,
      'Third-party cookies are blocked by default in several browsers. Confirm the feature still works without them.'
    );
  }

  const trackers = observedTrackers(input.requestUrls);
  if (trackers.length > 0) {
    findings.push({
      severity: 'info',
      category: 'cookies',
      message: `${trackers.length} known third-party tracker${trackers.length === 1 ? '' : 's'} contacted during load.`,
      evidence: trackers.map((tracker) => `${tracker.name} — ${tracker.host} (${tracker.category})`),
      repro: `1. Open ${input.pageUrl}\n2. Open DevTools → Network\n3. Filter by the listed hosts`,
      suggestion: 'Confirm each tracker is disclosed in your privacy notice and covered by your consent flow.',
    });

    if (input.consentBanner?.present) {
      findings.push({
        severity: 'high',
        category: 'cookies',
        message: 'Trackers loaded before the consent banner was answered.',
        evidence: {
          consentBannerSelector: input.consentBanner.selector,
          consentBannerText: input.consentBanner.excerpt,
          trackersBeforeConsent: trackers.map((tracker) => tracker.host),
          heuristic: 'A fixed or sticky overlay naming cookies/consent with an accept or reject control. Confirm the excerpt above before acting on this finding.',
        },
        repro: `1. Open ${input.pageUrl} in a fresh profile\n2. Open DevTools → Network before dismissing the consent banner\n3. Observe requests to the listed tracker hosts`,
        suggestion:
          'Gate non-essential tags behind an accepted consent choice. Under GDPR/ePrivacy, loading them first can be unlawful regardless of the banner.',
      });
    }
  }

  return findings;
}
