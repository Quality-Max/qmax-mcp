import type { Finding } from '../common';
import { formatBytes, transferBytes, type RenderBlockingSignal, type ResourceSignal } from './signals';
import { hostOf, identifyTracker, isThirdParty } from './trackers';

export type WeightBudget = {
  totalBytes: number;
  requestCount: number;
  renderBlocking: number;
  imageBytes: number;
  scriptBytes: number;
};

/** Default budget. Roughly a mid-range mobile connection staying interactive on first load. */
export const DEFAULT_WEIGHT_BUDGET: WeightBudget = {
  totalBytes: 2_000_000,
  requestCount: 80,
  renderBlocking: 5,
  imageBytes: 500_000,
  scriptBytes: 250_000,
};

export type WeightMetrics = {
  totalBytes: number;
  requestCount: number;
  /** False when at least one cross-origin response withheld its size, making totals a lower bound. */
  totalBytesComplete: boolean;
  bytesByResourceType: Record<string, number>;
  thirdPartyOrigins: Array<{ host: string; bytes: number; requests: number; tracker?: string }>;
  slowestRequests: Array<{ url: string; durationMs: number; bytes: number; resourceType: string }>;
  budget: WeightBudget;
};

export type WeightInput = {
  /** Display-safe URL of the scanned page. */
  pageUrl: string;
  resources: ResourceSignal[];
  renderBlocking: RenderBlockingSignal[];
  budget?: Partial<WeightBudget>;
};

const COMPRESSIBLE_TYPE = /^(text\/|application\/(javascript|json|xml|x-javascript)|image\/svg\+xml)/i;
const COMPRESSED_ENCODING = /\b(gzip|br|deflate|zstd)\b/i;
const UNCOMPRESSED_FLOOR_BYTES = 10_000;

/** Measure page weight, third-party cost, and the slowest requests against a budget. */
export function analyzeWeight(input: WeightInput): { findings: Finding[]; metrics: WeightMetrics } {
  const budget = { ...DEFAULT_WEIGHT_BUDGET, ...input.budget };
  const pageHost = hostOf(input.pageUrl);
  const findings: Finding[] = [];

  let totalBytes = 0;
  let totalBytesComplete = true;
  const bytesByResourceType: Record<string, number> = {};
  const thirdParty = new Map<string, { host: string; bytes: number; requests: number; tracker?: string }>();

  for (const resource of input.resources) {
    const bytes = transferBytes(resource);
    if (bytes === 0 && !resource.timingAvailable) totalBytesComplete = false;
    totalBytes += bytes;
    bytesByResourceType[resource.resourceType] = (bytesByResourceType[resource.resourceType] ?? 0) + bytes;

    const host = hostOf(resource.url);
    if (!host || !pageHost || !isThirdParty(host, pageHost)) continue;
    const entry = thirdParty.get(host) ?? { host, bytes: 0, requests: 0, tracker: identifyTracker(host)?.name };
    entry.bytes += bytes;
    entry.requests += 1;
    thirdParty.set(host, entry);
  }

  const thirdPartyOrigins = Array.from(thirdParty.values())
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10);

  const slowestRequests = input.resources
    .filter((resource) => typeof resource.durationMs === 'number')
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, 10)
    .map((resource) => ({
      url: resource.url,
      durationMs: Math.round(resource.durationMs ?? 0),
      bytes: transferBytes(resource),
      resourceType: resource.resourceType,
    }));

  const metrics: WeightMetrics = {
    totalBytes,
    requestCount: input.resources.length,
    totalBytesComplete,
    bytesByResourceType,
    thirdPartyOrigins,
    slowestRequests,
    budget,
  };

  const networkSteps = `1. Open ${input.pageUrl}\n2. Open DevTools → Network with cache disabled\n3. Reload and read the transferred total`;

  if (totalBytes > budget.totalBytes) {
    findings.push({
      severity: totalBytes > budget.totalBytes * 2 ? 'high' : 'medium',
      category: 'weight',
      message: `Page transfers ${formatBytes(totalBytes)}, over the ${formatBytes(budget.totalBytes)} budget.`,
      evidence: { totalBytes, budgetBytes: budget.totalBytes, totalBytesComplete, bytesByResourceType },
      repro: networkSteps,
      suggestion: 'Compress and split the largest resource types listed above before adding more to the page.',
    });
  }

  if (input.resources.length > budget.requestCount) {
    findings.push({
      severity: input.resources.length > budget.requestCount * 2 ? 'medium' : 'low',
      category: 'weight',
      message: `Page makes ${input.resources.length} requests, over the ${budget.requestCount} budget.`,
      evidence: { requestCount: input.resources.length, budgetRequests: budget.requestCount },
      repro: networkSteps,
      suggestion: 'Bundle or defer non-critical requests; each one costs a connection and a round trip.',
    });
  }

  if (input.renderBlocking.length > budget.renderBlocking) {
    findings.push({
      severity: 'medium',
      category: 'weight',
      message: `${input.renderBlocking.length} render-blocking resources in <head>, over the ${budget.renderBlocking} budget.`,
      evidence: input.renderBlocking.map((item) => `${item.kind}: ${item.url}`).slice(0, 20),
      repro: `1. Open ${input.pageUrl}\n2. View source\n3. Count <head> scripts without async/defer and non-print stylesheets`,
      suggestion: 'Add async or defer to head scripts, and inline or preload only the CSS needed for first paint.',
    });
  }

  const oversized = (types: string[], limit: number) =>
    input.resources.filter((resource) => types.includes(resource.resourceType) && transferBytes(resource) > limit);

  const bigImages = oversized(['image'], budget.imageBytes);
  if (bigImages.length > 0) {
    findings.push({
      severity: 'medium',
      category: 'weight',
      message: `${bigImages.length} image${bigImages.length === 1 ? ' exceeds' : 's exceed'} ${formatBytes(budget.imageBytes)}.`,
      evidence: bigImages.slice(0, 20).map((resource) => `${resource.url} — ${formatBytes(transferBytes(resource))}`),
      repro: networkSteps,
      suggestion: 'Serve AVIF or WebP at the displayed dimensions and add width/height to avoid layout shift.',
    });
  }

  const bigScripts = oversized(['script'], budget.scriptBytes);
  if (bigScripts.length > 0) {
    findings.push({
      severity: 'medium',
      category: 'weight',
      message: `${bigScripts.length} script${bigScripts.length === 1 ? ' exceeds' : 's exceed'} ${formatBytes(budget.scriptBytes)}.`,
      evidence: bigScripts.slice(0, 20).map((resource) => `${resource.url} — ${formatBytes(transferBytes(resource))}`),
      repro: networkSteps,
      suggestion: 'Code-split the bundle and load rarely used routes on demand; large scripts also block the main thread.',
    });
  }

  const uncompressed = input.resources.filter((resource) => {
    if (!resource.contentType || !COMPRESSIBLE_TYPE.test(resource.contentType)) return false;
    if (resource.contentEncoding && COMPRESSED_ENCODING.test(resource.contentEncoding)) return false;
    return transferBytes(resource) > UNCOMPRESSED_FLOOR_BYTES;
  });
  if (uncompressed.length > 0) {
    findings.push({
      severity: 'medium',
      category: 'weight',
      message: `${uncompressed.length} text resource${uncompressed.length === 1 ? ' is' : 's are'} served without compression.`,
      evidence: uncompressed.slice(0, 20).map((resource) => `${resource.url} — ${formatBytes(transferBytes(resource))}`),
      repro: `1. Open ${input.pageUrl}\n2. Open DevTools → Network\n3. Check the content-encoding response header on the listed resources`,
      suggestion: 'Enable Brotli or gzip at the origin or CDN. Text assets typically shrink by 70% or more.',
    });
  }

  const heaviestThirdParty = thirdPartyOrigins[0];
  if (heaviestThirdParty && totalBytes > 0 && heaviestThirdParty.bytes > totalBytes * 0.25) {
    findings.push({
      severity: 'medium',
      category: 'weight',
      message: `Third-party origin ${heaviestThirdParty.host} accounts for ${formatBytes(heaviestThirdParty.bytes)} of page weight.`,
      evidence: thirdPartyOrigins,
      repro: `1. Open ${input.pageUrl}\n2. Open DevTools → Network\n3. Sort by size and filter to ${heaviestThirdParty.host}`,
      suggestion: 'Load third-party scripts lazily or behind consent, and confirm the page still works when they fail.',
    });
  }

  return { findings, metrics };
}
