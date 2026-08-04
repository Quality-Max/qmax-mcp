/**
 * Shared, browser-free inputs for the scan analyzers.
 *
 * Everything here is collected during the single page load `scanUrl` already performs, so the
 * analyzers stay pure functions that can be unit-tested without launching Playwright.
 */

/** One network response observed while loading the page. */
export type ResourceSignal = {
  url: string;
  /** Playwright request resource type: document, script, stylesheet, image, xhr, fetch, font, ... */
  resourceType: string;
  status?: number;
  contentType?: string;
  contentEncoding?: string;
  /** Bytes reported by the `content-length` response header, when present. */
  contentLength?: number;
  /**
   * Bytes reported by PerformanceResourceTiming. Cross-origin responses without
   * `Timing-Allow-Origin` report 0, which is why `timingAvailable` exists.
   */
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
  startMs?: number;
  durationMs?: number;
  /** False when resource timing was withheld, so byte totals are a lower bound. */
  timingAvailable: boolean;
};

/** A cookie reduced to its security-relevant metadata. The value is deliberately absent. */
export type CookieSignal = {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  /** Unix seconds, or -1 for a session cookie. */
  expires?: number;
};

/** A render-blocking `<head>` subresource found in the served markup. */
export type RenderBlockingSignal = {
  kind: 'script' | 'stylesheet';
  url: string;
};

/** Core Web Vitals and navigation timings sampled from the page. */
export type VitalsSignal = {
  lcpMs: number | null;
  clsScore: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  domContentLoadedMs: number | null;
  loadMs: number | null;
};

/** A response as seen by Playwright's `response` event. */
export type ResponseObservation = {
  url: string;
  resourceType: string;
  status?: number;
  contentType?: string;
  contentEncoding?: string;
  contentLength?: number;
};

/** One `PerformanceResourceTiming` entry read back from the page. */
export type ResourceTimingObservation = {
  url: string;
  initiatorType?: string;
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
  startMs?: number;
  durationMs?: number;
};

/** PerformanceResourceTiming initiator types mapped onto Playwright resource types. */
const INITIATOR_RESOURCE_TYPE: Record<string, string> = {
  navigation: 'document',
  iframe: 'document',
  frame: 'document',
  script: 'script',
  link: 'stylesheet',
  img: 'image',
  image: 'image',
  input: 'image',
  video: 'media',
  audio: 'media',
  track: 'media',
  xmlhttprequest: 'xhr',
  fetch: 'fetch',
  beacon: 'fetch',
  css: 'other',
};

/**
 * Join what the network layer saw with what the page's own resource timing reports.
 *
 * Responses carry the authoritative resource type and headers; resource timing carries the byte
 * counts and durations. Entries present in only one source are still included, so a resource that
 * never produced a response event is not silently dropped from the weight total.
 */
export function mergeResourceSignals(
  responses: ResponseObservation[],
  timings: ResourceTimingObservation[],
  toDisplayUrl: (url: string) => string
): ResourceSignal[] {
  const timingByUrl = new Map(timings.map((timing) => [timing.url, timing]));
  const merged = new Map<string, ResourceSignal>();

  const sizesUsable = (timing?: ResourceTimingObservation) =>
    Boolean(timing && ((timing.transferSize ?? 0) > 0 || (timing.encodedBodySize ?? 0) > 0));

  for (const response of responses) {
    const timing = timingByUrl.get(response.url);
    merged.set(response.url, {
      ...response,
      url: toDisplayUrl(response.url),
      transferSize: timing?.transferSize,
      encodedBodySize: timing?.encodedBodySize,
      decodedBodySize: timing?.decodedBodySize,
      startMs: timing?.startMs,
      durationMs: timing?.durationMs,
      timingAvailable: sizesUsable(timing),
    });
  }

  for (const timing of timings) {
    if (merged.has(timing.url)) continue;
    merged.set(timing.url, {
      url: toDisplayUrl(timing.url),
      resourceType: INITIATOR_RESOURCE_TYPE[timing.initiatorType ?? ''] ?? 'other',
      transferSize: timing.transferSize,
      encodedBodySize: timing.encodedBodySize,
      decodedBodySize: timing.decodedBodySize,
      startMs: timing.startMs,
      durationMs: timing.durationMs,
      timingAvailable: sizesUsable(timing),
    });
  }

  return Array.from(merged.values());
}

/**
 * Best available transfer size for one resource.
 *
 * Prefers real resource timing, falls back to the `content-length` header, and reports 0 rather
 * than guessing when neither is available.
 */
export function transferBytes(resource: ResourceSignal): number {
  if (resource.timingAvailable && typeof resource.transferSize === 'number' && resource.transferSize > 0) {
    return resource.transferSize;
  }
  if (typeof resource.contentLength === 'number' && resource.contentLength > 0) {
    return resource.contentLength;
  }
  if (typeof resource.encodedBodySize === 'number' && resource.encodedBodySize > 0) {
    return resource.encodedBodySize;
  }
  return 0;
}

/** Format a byte count for finding messages. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${bytes} B`;
}
