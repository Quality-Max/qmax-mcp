/**
 * Recognise the request shapes that telemetry and analytics SDKs use for their
 * own transport.
 *
 * A stubbed-but-still-initialized SDK is a common test-environment failure mode:
 * given a placeholder DSN or token the SDK treats the credential as present,
 * initializes for real, and fires doomed requests on every page load. The scan
 * saw those as anonymous console errors and request failures and suggested
 * "fix runtime errors", which sends the reader into the application source for
 * something the request itself already identifies — `/api/0/envelope/` with
 * `sentry_key=stub` is not ambiguous.
 *
 * Matching is on path and query shape rather than hostname, because these
 * requests are frequently sent to a self-hosted, proxied, or stubbed origin:
 * in the session that motivated this, Sentry envelopes went to `localhost` and
 * PostHog config to the application's own port.
 *
 * Deliberately small and hand-maintained, like the tracker host list. It labels
 * observed requests; it never blocks them.
 *
 * Last reviewed: 2026-08-27.
 */

export type TelemetrySignature = {
  /** Vendor name as a reader would recognise it. */
  name: string;
  /** The part of the request that identified the vendor, quoted as evidence. */
  fingerprint: string;
  /** The credential the request carries, when one is recognisable. */
  credential?: { param: string; value: string };
  /** True when that credential reads as a placeholder rather than a real key. */
  placeholderCredential: boolean;
};

type Matcher = {
  name: string;
  /** Match against the URL path, and the search string when the shape needs it. */
  match: (path: string, params: URLSearchParams) => string | null;
  /** Pull the credential out of a matched request. */
  credential?: (path: string, params: URLSearchParams) => { param: string; value: string } | undefined;
};

const MATCHERS: Matcher[] = [
  {
    name: 'Sentry',
    // The envelope endpoint is the SDK's transport: /api/<project>/envelope/.
    // `sentry_key` alone is enough on its own for tunnelled or proxied setups.
    match: (path, params) =>
      /\/api\/\d+\/envelope\/?$/.test(path)
        ? `${path} (Sentry envelope endpoint)`
        : params.has('sentry_key')
          ? 'sentry_key query parameter'
          : /\/api\/\d+\/(store|security)\/?$/.test(path)
            ? `${path} (Sentry store endpoint)`
            : null,
    credential: (_path, params) => {
      const value = params.get('sentry_key');
      return value ? { param: 'sentry_key', value } : undefined;
    },
  },
  {
    name: 'PostHog',
    // posthog-js fetches remote config from /array/<token>/config.js and posts
    // events to /e/, /i/v0/e/ or /decide/. A reverse-proxy prefix such as
    // /ingest is the documented deployment, so anchor on the tail, not the root.
    match: (path) => {
      const array = /\/array\/([^/]+)\/config(?:\.js)?$/.exec(path);
      if (array) return `${path} (PostHog remote config)`;
      if (/\/(?:i\/v0\/)?e\/?$/.test(path)) return `${path} (PostHog event capture)`;
      if (/\/decide\/?$/.test(path)) return `${path} (PostHog feature-flag decide)`;
      return null;
    },
    credential: (path, params) => {
      const array = /\/array\/([^/]+)\/config(?:\.js)?$/.exec(path);
      if (array) return { param: 'project token', value: decodeURIComponent(array[1]) };
      const token = params.get('token') || params.get('api_key');
      return token ? { param: 'token', value: token } : undefined;
    },
  },
  {
    name: 'Google Analytics',
    match: (path, params) =>
      /\/(?:g|j|r)?\/?collect$/.test(path) || (path.endsWith('/collect') && params.has('tid'))
        ? `${path} (Measurement Protocol collect)`
        : null,
    credential: (_path, params) => {
      const value = params.get('tid');
      return value ? { param: 'tid', value } : undefined;
    },
  },
  {
    name: 'Datadog RUM',
    match: (path) => (/\/api\/v2\/rum$/.test(path) ? `${path} (Datadog RUM intake)` : null),
    credential: (_path, params) => {
      const value = params.get('dd-api-key');
      return value ? { param: 'dd-api-key', value } : undefined;
    },
  },
  {
    name: 'Amplitude',
    match: (path) => (/\/2\/httpapi$/.test(path) || /\/batch$/.test(path) ? `${path} (Amplitude HTTP API)` : null),
  },
  {
    name: 'Mixpanel',
    match: (path) => (/\/(track|engage)\/?$/.test(path) ? `${path} (Mixpanel track endpoint)` : null),
  },
];

/**
 * Words that mark a credential as scaffolding rather than a real key.
 *
 * Matched against the value's alphanumeric segments, so `sentry_key=stub` and
 * `stub_posthog_token_disabled_for_e2e_0000` both hit while a real key that
 * merely contains these letters does not.
 */
const PLACEHOLDER_WORDS = new Set([
  'stub',
  'stubbed',
  'placeholder',
  'dummy',
  'fake',
  'example',
  'sample',
  'changeme',
  'todo',
  'disabled',
  'notset',
  'unset',
  'none',
  'null',
  'undefined',
  'test',
  'testing',
  'e2e',
  'xxx',
  'xxxx',
]);

/** True when a credential value reads as a placeholder rather than a real key. */
export function isPlaceholderCredential(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[0x-]+$/i.test(trimmed)) return true;
  return trimmed
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((segment) => PLACEHOLDER_WORDS.has(segment));
}

/** Identify a telemetry transport request, or null when the URL is not one. */
export function identifyTelemetryRequest(rawUrl: string): TelemetrySignature | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';

  for (const matcher of MATCHERS) {
    const fingerprint = matcher.match(path, url.searchParams);
    if (!fingerprint) continue;
    const credential = matcher.credential?.(path, url.searchParams);
    return {
      name: matcher.name,
      fingerprint,
      credential,
      placeholderCredential: credential ? isPlaceholderCredential(credential.value) : false,
    };
  }
  return null;
}

/**
 * Describe a failing telemetry request in terms of the SDK and its fix.
 *
 * `displayUrl` is the redacted URL for the finding; `failure` is the transport
 * error or console text that brought it to attention.
 */
export function describeTelemetryFailure(
  signature: TelemetrySignature,
  displayUrl: string,
  failure: string
): { severity: 'medium'; category: 'telemetry'; message: string; url: string; evidence: unknown; suggestion: string } {
  const credential = signature.credential;
  const quoted = credential ? `${credential.param}=${credential.value}` : undefined;

  return {
    severity: 'medium',
    category: 'telemetry',
    message: signature.placeholderCredential
      ? `${signature.name} is initialized with a placeholder credential and its requests fail.`
      : `${signature.name} telemetry requests fail on this page.`,
    url: displayUrl,
    evidence: { fingerprint: signature.fingerprint, credential: quoted, failure },
    suggestion: signature.placeholderCredential
      ? `A placeholder credential${quoted ? ` (\`${quoted}\`)` : ''} still counts as present, so the SDK initializes and fires doomed requests on every page load. In test environments prefer an empty DSN/token, which these SDKs treat as disabled, over a fake-but-present value.`
      : `Confirm the ${signature.name} endpoint is reachable in this environment, or disable the SDK with an empty DSN/token so it does not initialize and retry on every page load.`,
  };
}
