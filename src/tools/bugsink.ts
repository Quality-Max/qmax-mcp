// Read-only, sanitized Bugsink access for autonomous delivery workspaces.
//
// qmax-code reports its runtime errors to Bugsink (a Sentry-compatible sink)
// which is out-of-band from PostHog, so a delivery agent running a post-deploy
// validation pass has no sanitized way to look at those errors. These two
// tools close that gap over the Bugsink 2.0 canonical API
// (`/api/canonical/0/`), while holding a hard safety boundary:
//
//   * Only issue-level metadata is ever returned — never event payloads,
//     request bodies, cookies, DSNs, tokens, or raw infra logs. The event
//     `data` payload endpoint is deliberately NOT called.
//   * Every free-text field is run through `redactSensitive` first.
//   * Credentials are read from the environment and are never echoed back.
//   * Responses are cached with a hard 10-minute freshness cap, and the
//     freshness of the data served is always visible to the caller.

import { redactSensitive } from './sanitize';

// A read never serves data older than this, regardless of configuration.
const MAX_CACHE_TTL_SECONDS = 600; // 10 minutes
const DEFAULT_CACHE_TTL_SECONDS = 600;

const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 20;

// Bound how much a summary is willing to scan so a noisy project can't turn a
// single call into an unbounded page walk.
const MAX_SUMMARY_SCAN = 200;
const MAX_SUMMARY_PROJECTS = 25;
const SUMMARY_TOP_ISSUES = 5;

const API_PREFIX = 'api/canonical/0';

type SortKey = 'last_seen' | 'events' | 'digest_order';
type Order = 'asc' | 'desc';

const SORT_TO_API: Record<SortKey, string> = {
  last_seen: 'last_seen',
  events: 'digested_event_count',
  digest_order: 'digest_order',
};

export type BugsinkErrorSummaryArgs = {
  project?: string | number;
};

export type BugsinkListIssuesArgs = {
  project?: string | number;
  limit?: number;
  sort?: SortKey;
  order?: Order;
  cursor?: string;
};

type BugsinkConfig = {
  baseUrl: string;
  token: string;
  cacheTtlSeconds: number;
};

class BugsinkConfigError extends Error {}
class BugsinkRequestError extends Error {}

type RawRecord = Record<string, unknown>;

type SanitizedIssue = {
  id: string | null;
  friendlyId: string | null;
  type: string | null;
  value: string | null;
  transaction: string | null;
  digestedEventCount: number | null;
  storedEventCount: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  state: 'resolved' | 'muted' | 'unresolved';
  isResolved: boolean;
  isMuted: boolean;
};

type CacheEntry = { fetchedAtMs: number; body: unknown };

// Module-level cache shared across calls within a running server process. Keyed
// by the fully-qualified request URL (token lives in the header, never the URL).
const responseCache = new Map<string, CacheEntry>();

function loadConfig(): BugsinkConfig {
  const rawUrl = process.env['QMAX_BUGSINK_URL']?.trim();
  const token = process.env['QMAX_BUGSINK_TOKEN']?.trim();

  if (!rawUrl || !token) {
    throw new BugsinkConfigError(
      'Bugsink access is not configured. Set QMAX_BUGSINK_URL (the Bugsink base URL) and ' +
        'QMAX_BUGSINK_TOKEN (a read-only API token) in the delivery workspace environment. ' +
        'These credentials are read from the environment and are never returned by this tool.'
    );
  }

  let baseUrl: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('protocol');
    }
    baseUrl = parsed.origin;
  } catch {
    throw new BugsinkConfigError('QMAX_BUGSINK_URL must be a valid http(s) URL.');
  }

  const ttlRaw = Number.parseInt(process.env['QMAX_BUGSINK_CACHE_TTL_SECONDS'] ?? '', 10);
  const ttl = Number.isFinite(ttlRaw) ? ttlRaw : DEFAULT_CACHE_TTL_SECONDS;
  // Hard-cap freshness at 10 minutes; never let configuration exceed it.
  const cacheTtlSeconds = Math.max(0, Math.min(MAX_CACHE_TTL_SECONDS, ttl));

  return { baseUrl, token, cacheTtlSeconds };
}

function sanitizeErrorMessage(err: unknown, config?: BugsinkConfig): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (config?.token) {
    msg = msg.split(config.token).join('[REDACTED]');
  }
  return redactSensitive(msg);
}

/**
 * A per-call client that fetches over the Bugsink canonical API and tracks the
 * freshness of the oldest datapoint it served, so the caller can see exactly
 * how stale the answer is.
 */
class BugsinkClient {
  private oldestFetchedAtMs = Number.POSITIVE_INFINITY;
  private servedFromCache = false;

  constructor(private readonly config: BugsinkConfig) {}

  async get(pathAndQuery: string): Promise<unknown> {
    const url = `${this.config.baseUrl}/${API_PREFIX}/${pathAndQuery}`;
    const nowMs = Date.now();

    const cached = responseCache.get(url);
    if (cached && (nowMs - cached.fetchedAtMs) / 1000 <= this.config.cacheTtlSeconds) {
      this.record(cached.fetchedAtMs, true);
      return cached.body;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      throw new BugsinkRequestError(`Failed to reach Bugsink: ${sanitizeErrorMessage(err, this.config)}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new BugsinkRequestError(
        `Bugsink rejected the API token (HTTP ${res.status}). Confirm QMAX_BUGSINK_TOKEN has read access.`
      );
    }
    if (!res.ok) {
      throw new BugsinkRequestError(`Bugsink API returned HTTP ${res.status}.`);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new BugsinkRequestError('Bugsink returned a non-JSON response.');
    }

    responseCache.set(url, { fetchedAtMs: nowMs, body });
    this.record(nowMs, false);
    return body;
  }

  private record(fetchedAtMs: number, fromCache: boolean): void {
    this.oldestFetchedAtMs = Math.min(this.oldestFetchedAtMs, fetchedAtMs);
    if (fromCache) this.servedFromCache = true;
  }

  freshness() {
    const base = Number.isFinite(this.oldestFetchedAtMs) ? this.oldestFetchedAtMs : Date.now();
    const ageSeconds = Math.max(0, Math.round((Date.now() - base) / 1000));
    return {
      source: this.servedFromCache ? ('cache' as const) : ('live' as const),
      fetchedAt: new Date(base).toISOString(),
      ageSeconds,
      maxAgeSeconds: this.config.cacheTtlSeconds,
      // With the hard cap in place this should always be false; surface it so a
      // regression in cache handling is visible rather than silent.
      stale: ageSeconds > this.config.cacheTtlSeconds,
    };
  }
}

function resultsOf(body: unknown): RawRecord[] {
  if (Array.isArray(body)) return body as RawRecord[];
  if (body && typeof body === 'object' && Array.isArray((body as RawRecord)['results'])) {
    return (body as { results: RawRecord[] }).results;
  }
  return [];
}

function extractCursor(nextUrl: unknown): string | null {
  if (typeof nextUrl !== 'string' || !nextUrl) return null;
  try {
    return new URL(nextUrl).searchParams.get('cursor');
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function issueState(raw: RawRecord): SanitizedIssue['state'] {
  if (raw['is_resolved'] || raw['is_resolved_unconditionally'] || raw['is_resolved_by_next_release']) {
    return 'resolved';
  }
  if (raw['is_muted']) return 'muted';
  return 'unresolved';
}

function sanitizeIssue(raw: RawRecord): SanitizedIssue {
  return {
    id: stringOrNull(raw['id']),
    friendlyId: stringOrNull(raw['friendly_id']),
    type: redactSensitive(String(raw['calculated_type'] ?? '')) || null,
    value: redactSensitive(String(raw['calculated_value'] ?? '')) || null,
    transaction: redactSensitive(String(raw['transaction'] ?? '')) || null,
    digestedEventCount: numberOrNull(raw['digested_event_count']),
    storedEventCount: numberOrNull(raw['stored_event_count']),
    firstSeen: stringOrNull(raw['first_seen']),
    lastSeen: stringOrNull(raw['last_seen']),
    state: issueState(raw),
    isResolved: Boolean(raw['is_resolved']),
    isMuted: Boolean(raw['is_muted']),
  };
}

type NormalizedProject = { id: number; name: string | null };

function normalizeProject(raw: RawRecord): NormalizedProject | null {
  const id = raw['id'];
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const name = stringOrNull(raw['name']) ?? stringOrNull(raw['slug']);
  return { id, name };
}

async function listProjects(client: BugsinkClient): Promise<NormalizedProject[]> {
  const body = await client.get('projects/');
  return resultsOf(body)
    .map(normalizeProject)
    .filter((p): p is NormalizedProject => p !== null);
}

function describeProjects(projects: NormalizedProject[]): string {
  if (projects.length === 0) return '(none)';
  return projects.map((p) => `${p.name ?? '(unnamed)'} (id ${p.id})`).join(', ');
}

async function resolveProject(
  client: BugsinkClient,
  project: string | number | undefined
): Promise<NormalizedProject> {
  const projects = await listProjects(client);

  if (project === undefined || project === '') {
    if (projects.length === 1) return projects[0]!;
    throw new BugsinkRequestError(
      `Multiple Bugsink projects are available; pass "project" (id or name). Available: ${describeProjects(projects)}.`
    );
  }

  const trimmed = String(project).trim();
  const asNum = Number(trimmed);
  if (Number.isInteger(asNum) && trimmed === String(asNum)) {
    return projects.find((p) => p.id === asNum) ?? { id: asNum, name: null };
  }

  const needle = trimmed.toLowerCase();
  const match = projects.find((p) => p.name && p.name.toLowerCase() === needle);
  if (!match) {
    throw new BugsinkRequestError(
      `No Bugsink project matches "${trimmed}". Available: ${describeProjects(projects)}.`
    );
  }
  return match;
}

function buildIssuesPath(projectId: number, sort: string, order: Order, cursor?: string): string {
  const qs = new URLSearchParams();
  qs.set('project', String(projectId));
  qs.set('sort', sort);
  qs.set('order', order);
  if (cursor) qs.set('cursor', cursor);
  return `issues/?${qs.toString()}`;
}

/**
 * Page through the issues endpoint until at least `max` issues are collected or
 * the pages run out. Returns the raw records plus the cursor of the page that
 * follows the last one fetched (page-granular).
 */
async function fetchIssuesBounded(
  client: BugsinkClient,
  projectId: number,
  sort: string,
  order: Order,
  startCursor: string | undefined,
  max: number
): Promise<{ raw: RawRecord[]; nextCursor: string | null }> {
  const collected: RawRecord[] = [];
  let cursor = startCursor;
  let nextCursor: string | null = null;

  do {
    const body = await client.get(buildIssuesPath(projectId, sort, order, cursor));
    const page = resultsOf(body);
    collected.push(...page);
    nextCursor = extractCursor((body as RawRecord | undefined)?.['next']);
    cursor = nextCursor ?? undefined;
    if (page.length === 0) break;
  } while (cursor && collected.length < max);

  return { raw: collected, nextCursor };
}

export async function bugsinkErrorSummary(args: BugsinkErrorSummaryArgs = {}) {
  let config: BugsinkConfig | undefined;
  try {
    config = loadConfig();
    const client = new BugsinkClient(config);

    let targets: NormalizedProject[];
    if (args.project === undefined || args.project === '') {
      targets = (await listProjects(client)).slice(0, MAX_SUMMARY_PROJECTS);
    } else {
      targets = [await resolveProject(client, args.project)];
    }

    const projects = [];
    for (const project of targets) {
      const { raw } = await fetchIssuesBounded(
        client,
        project.id,
        SORT_TO_API.last_seen,
        'desc',
        undefined,
        MAX_SUMMARY_SCAN
      );
      const scanned = raw.slice(0, MAX_SUMMARY_SCAN);
      const issues = scanned.map(sanitizeIssue);

      const counts = { unresolved: 0, muted: 0, resolved: 0 };
      let totalDigestedEvents = 0;
      let mostRecentLastSeen: string | null = null;
      for (const issue of issues) {
        counts[issue.state] += 1;
        totalDigestedEvents += issue.digestedEventCount ?? 0;
        if (issue.lastSeen && (!mostRecentLastSeen || issue.lastSeen > mostRecentLastSeen)) {
          mostRecentLastSeen = issue.lastSeen;
        }
      }

      const topUnresolved = issues
        .filter((issue) => issue.state === 'unresolved')
        .slice(0, SUMMARY_TOP_ISSUES)
        .map((issue) => ({
          friendlyId: issue.friendlyId,
          type: issue.type,
          value: issue.value,
          digestedEventCount: issue.digestedEventCount,
          lastSeen: issue.lastSeen,
        }));

      projects.push({
        projectId: project.id,
        projectName: project.name,
        scannedIssueCount: issues.length,
        scanTruncated: raw.length >= MAX_SUMMARY_SCAN,
        counts,
        totalDigestedEvents,
        mostRecentLastSeen,
        topUnresolved,
      });
    }

    return {
      ok: true as const,
      projects,
      scanBound: MAX_SUMMARY_SCAN,
      note:
        'Counts are computed over the most-recent issues scanned per project (up to scanBound), ' +
        'sorted by last seen. When scanTruncated is true there are older issues beyond the scan window. ' +
        'Only sanitized issue-level metadata is returned — no event payloads.',
      cacheFreshness: client.freshness(),
    };
  } catch (err) {
    return errorResult(err, config);
  }
}

export async function bugsinkListIssues(args: BugsinkListIssuesArgs = {}) {
  let config: BugsinkConfig | undefined;
  try {
    config = loadConfig();
    const client = new BugsinkClient(config);

    const limit = clampLimit(args.limit);
    const sortKey: SortKey = args.sort ?? 'last_seen';
    const order: Order = args.order ?? 'desc';

    const project = await resolveProject(client, args.project);
    const { raw, nextCursor: pageAfterFetched } = await fetchIssuesBounded(
      client,
      project.id,
      SORT_TO_API[sortKey],
      order,
      args.cursor,
      limit
    );

    const issues = raw.slice(0, limit).map(sanitizeIssue);
    const truncatedWithinPage = raw.length > limit;
    const hasMore = truncatedWithinPage || Boolean(pageAfterFetched);
    // Cursors are page-granular. If the cap fell inside a page we can't hand
    // back a lossless resume point, so withhold the cursor and say why.
    const nextCursor = truncatedWithinPage ? null : pageAfterFetched;

    return {
      ok: true as const,
      projectId: project.id,
      projectName: project.name,
      sort: sortKey,
      order,
      limit,
      returned: issues.length,
      issues,
      pagination: {
        hasMore,
        nextCursor,
        note: hasMore
          ? nextCursor
            ? 'More issues are available. Pass nextCursor to fetch the next page.'
            : 'More issues are available but the limit fell mid-page; raise "limit" (max 50) to see more.'
          : 'No further issues.',
      },
      cacheFreshness: client.freshness(),
    };
  } catch (err) {
    return errorResult(err, config);
  }
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(limit)));
}

function errorResult(err: unknown, config?: BugsinkConfig) {
  const configured = !(err instanceof BugsinkConfigError);
  return {
    ok: false as const,
    configured,
    error: sanitizeErrorMessage(err, config),
  };
}
