/**
 * First-party classification of well-known third-party tracking hosts.
 *
 * This is a deliberately small, hand-maintained list rather than a vendored blocklist: it is used
 * only to label observed requests in scan output, never to block them.
 *
 * Last reviewed: 2026-08-04.
 */

export type TrackerCategory = 'analytics' | 'advertising' | 'session-replay' | 'support';

const TRACKER_HOSTS: Array<{ suffix: string; name: string; category: TrackerCategory }> = [
  { suffix: 'google-analytics.com', name: 'Google Analytics', category: 'analytics' },
  { suffix: 'analytics.google.com', name: 'Google Analytics', category: 'analytics' },
  { suffix: 'googletagmanager.com', name: 'Google Tag Manager', category: 'analytics' },
  { suffix: 'doubleclick.net', name: 'Google DoubleClick', category: 'advertising' },
  { suffix: 'googlesyndication.com', name: 'Google AdSense', category: 'advertising' },
  { suffix: 'googleadservices.com', name: 'Google Ads', category: 'advertising' },
  { suffix: 'facebook.net', name: 'Meta Pixel', category: 'advertising' },
  { suffix: 'facebook.com', name: 'Meta', category: 'advertising' },
  { suffix: 'ads-twitter.com', name: 'X Ads', category: 'advertising' },
  { suffix: 'analytics.tiktok.com', name: 'TikTok Pixel', category: 'advertising' },
  { suffix: 'ads.linkedin.com', name: 'LinkedIn Ads', category: 'advertising' },
  { suffix: 'snap.licdn.com', name: 'LinkedIn Insight', category: 'advertising' },
  { suffix: 'hotjar.com', name: 'Hotjar', category: 'session-replay' },
  { suffix: 'hotjar.io', name: 'Hotjar', category: 'session-replay' },
  { suffix: 'fullstory.com', name: 'FullStory', category: 'session-replay' },
  { suffix: 'clarity.ms', name: 'Microsoft Clarity', category: 'session-replay' },
  { suffix: 'logrocket.io', name: 'LogRocket', category: 'session-replay' },
  { suffix: 'segment.com', name: 'Segment', category: 'analytics' },
  { suffix: 'segment.io', name: 'Segment', category: 'analytics' },
  { suffix: 'mixpanel.com', name: 'Mixpanel', category: 'analytics' },
  { suffix: 'amplitude.com', name: 'Amplitude', category: 'analytics' },
  { suffix: 'posthog.com', name: 'PostHog', category: 'analytics' },
  { suffix: 'intercom.io', name: 'Intercom', category: 'support' },
  { suffix: 'intercomcdn.com', name: 'Intercom', category: 'support' },
];

/**
 * Multi-label public suffixes needed so `example.co.uk` is not reduced to `co.uk`.
 * An approximation of the Public Suffix List, kept small on purpose.
 */
const MULTI_LABEL_SUFFIXES = [
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'co.jp',
  'or.jp',
  'ne.jp',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'com.cn',
  'com.mx',
  'co.in',
  'co.za',
  'co.kr',
];

/** Reduce a hostname to its approximate registrable domain. */
export function registrableDomain(host: string): string {
  const clean = host.toLowerCase().replace(/\.$/, '');
  const labels = clean.split('.');
  if (labels.length <= 2) return clean;

  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.includes(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/** True when `host` is not same-site with the scanned page. */
export function isThirdParty(host: string, pageHost: string): boolean {
  return registrableDomain(host) !== registrableDomain(pageHost);
}

/** Identify a known tracker by hostname, or null when the host is not on the list. */
export function identifyTracker(host: string): { name: string; category: TrackerCategory } | null {
  const clean = host.toLowerCase();
  for (const entry of TRACKER_HOSTS) {
    if (clean === entry.suffix || clean.endsWith(`.${entry.suffix}`)) {
      return { name: entry.name, category: entry.category };
    }
  }
  return null;
}

/** Hostname of a URL, or null when it cannot be parsed. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
