import { type Finding, type FindingDelta, type Severity, SEVERITY_RANK, gradeFromScore } from './tools/common';
import { formatBytes } from './tools/checks/signals';
import type { ScanMetrics } from './tools/scan-url';

export type ScanResult = {
  url: string;
  score: number;
  checks: string[];
  findingCount: number;
  findings: Finding[];
  metrics?: ScanMetrics;
  delta?: FindingDelta;
  screenshotPath?: string;
};

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  high: '🔴',
  medium: '🟠',
  low: '🟡',
  info: '🔵',
};

const GRADE_EMOJI: Record<string, string> = {
  A: '🟢',
  B: '🟢',
  C: '🟡',
  D: '🟠',
  F: '🔴',
};

const CHECK_META: Array<{ check: string; label: string; categories: string[] }> = [
  { check: 'console', label: 'Console errors', categories: ['console', 'network', 'telemetry'] },
  { check: 'links', label: 'Broken links', categories: ['links'] },
  { check: 'accessibility', label: 'Accessibility', categories: ['accessibility'] },
  { check: 'performance', label: 'Performance', categories: ['performance'] },
  { check: 'seo', label: 'SEO', categories: ['seo'] },
  { check: 'security_headers', label: 'Security headers', categories: ['security_headers'] },
  { check: 'cookies', label: 'Cookies and trackers', categories: ['cookies'] },
  { check: 'mixed_content', label: 'Mixed content', categories: ['mixed_content'] },
  { check: 'weight', label: 'Page weight', categories: ['weight'] },
];

/**
 * A text meter. Wrapped in a code span by callers so Markdown renders it in a monospace font and
 * the bars stay aligned down the column.
 */
function meter(value: number, max: number, width: number): string {
  if (max <= 0) return '░'.repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function worstSeverity(findings: Finding[]): Severity | null {
  if (findings.length === 0) return null;
  return findings.reduce<Severity>(
    (worst, f) => (SEVERITY_RANK[f.severity] < SEVERITY_RANK[worst] ? f.severity : worst),
    'info'
  );
}

function reproBlock(repro: string): string {
  // Multi-line repros are DevTools step lists; one-liners are shell commands.
  if (repro.includes('\n')) {
    return `**Reproduce:**\n\n${repro}\n`;
  }
  return `**Reproduce:**\n\n\`\`\`bash\n${repro}\n\`\`\`\n`;
}

/** Render measured values that are context rather than defects. */
function measurementLines(metrics: ScanMetrics | undefined): string[] {
  if (!metrics?.vitals && !metrics?.weight) return [];

  const rows: string[] = [];
  const vitals = metrics.vitals;
  if (vitals) {
    const ms = (value: number | null) => (value === null ? 'not available' : `${value}ms`);
    rows.push(`| Largest Contentful Paint | ${ms(vitals.lcpMs)} |`);
    rows.push(`| Cumulative Layout Shift | ${vitals.clsScore === null ? 'not available' : vitals.clsScore.toFixed(3)} |`);
    rows.push(`| Time to First Byte | ${ms(vitals.ttfbMs)} |`);
    rows.push(`| First Contentful Paint | ${ms(vitals.fcpMs)} |`);
    rows.push('| Interaction to Next Paint | not measured — needs real user interaction |');
  }

  const weight = metrics.weight;
  if (weight) {
    const qualifier = weight.totalBytesComplete ? '' : ' (lower bound)';
    rows.push(`| Page transfer | ${formatBytes(weight.totalBytes)}${qualifier} across ${weight.requestCount} requests |`);
    const thirdParty = weight.thirdPartyOrigins.filter((origin) => origin.bytes > 0).slice(0, 3);
    if (thirdParty.length > 0) {
      const summary = thirdParty.map((origin) => `${origin.host} ${formatBytes(origin.bytes)}`).join(', ');
      rows.push(`| Heaviest third parties | ${summary} |`);
    }
    const slowest = weight.slowestRequests[0];
    if (slowest) {
      rows.push(`| Slowest request | ${slowest.durationMs}ms — ${slowest.url} |`);
    }
  }

  const lines = ['---', '', '## Measurements', '', '| Metric | Value |', '|--------|-------|', ...rows, ''];

  // Byte breakdown as a bar list: which resource types actually account for the page's weight.
  const byType = Object.entries(weight?.bytesByResourceType ?? {})
    .filter(([, bytes]) => bytes > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  if (byType.length > 0) {
    const widestType = Math.max(...byType.map(([type]) => type.length));
    const widestSize = Math.max(...byType.map(([, bytes]) => formatBytes(bytes).length));
    lines.push('Where the bytes went:');
    lines.push('');
    lines.push('```');
    for (const [type, bytes] of byType) {
      lines.push(
        `${type.padEnd(widestType)}  ${meter(bytes, byType[0][1], 16)}  ${formatBytes(bytes).padStart(widestSize)}`
      );
    }
    lines.push('```');
    lines.push('');
  }

  for (const note of vitals?.notes ?? []) {
    lines.push(`_${note}_`);
    lines.push('');
  }
  return lines;
}

/**
 * Render each finding as a self-contained, tracker-agnostic issue block.
 *
 * Findings already carry roughly what a ticket needs — message, repro,
 * suggestion, selector or URL, severity — but as report fields rather than
 * ticket fields, so filing one means rewriting all of it as prose. In the
 * session that motivated this, six findings became six hand-written tickets and
 * each needed the same transformation. Teams that must do that by hand file the
 * top one or two findings and drop the rest, which is where findings die.
 *
 * The blocks are separated by HTML comments rather than headings: a comment
 * renders as nothing in every tracker, so a block can be pasted straight into a
 * description without carrying the report's own structure with it.
 */
export function renderIssues(
  result: ScanResult,
  opts: { now?: Date; minSeverity?: Severity } = {}
): string {
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const floor = opts.minSeverity ? SEVERITY_RANK[opts.minSeverity] : SEVERITY_RANK.info;
  const selected = [...result.findings]
    .filter((finding) => SEVERITY_RANK[finding.severity] <= floor)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.category.localeCompare(b.category));

  if (selected.length === 0) {
    const qualifier = opts.minSeverity ? ` at or above ${opts.minSeverity}` : '';
    return `<!-- qmax-mcp: no findings${qualifier} for ${result.url} on ${date} -->\n`;
  }

  const blocks = selected.map((finding, index) => {
    // Where the problem is: a selector when the finding has one, the URL when it
    // does not, and nothing rather than a guess when it has neither.
    const locus = finding.selector ? `\`${finding.selector}\`` : finding.url ? finding.url : undefined;
    const lines: string[] = [];

    lines.push(`<!-- issue ${index + 1} of ${selected.length} · ${finding.severity} · ${finding.category} -->`);
    lines.push('');
    lines.push('## Summary');
    lines.push(locus ? `${finding.message} (${locus})` : finding.message);
    lines.push('');
    lines.push('## Steps to Reproduce');
    if (finding.repro) {
      // A multi-line repro is already a numbered list; a one-liner is a command.
      lines.push(finding.repro.includes('\n') ? finding.repro : `1. Run \`${finding.repro}\``);
    } else {
      lines.push(`1. Open ${result.url}`);
      if (locus) lines.push(`2. Inspect ${locus}`);
    }
    lines.push('');
    lines.push('## Expected Result');
    // The suggestion states the fix, which is the same information as the
    // expected end state. Without one there is nothing honest to assert beyond
    // the absence of the finding.
    lines.push(finding.suggestion ?? 'The scan reports no finding here.');
    lines.push('');
    lines.push('## Actual Result');
    lines.push(
      finding.occurrences && finding.occurrences > 1
        ? `${finding.message} Observed ${finding.occurrences} times on one page load.`
        : finding.message
    );
    lines.push('');
    lines.push('## Environment');
    lines.push(
      `Found by an automated scan (qmax-mcp \`scan_url\`, Chromium) against ${result.url} on ${date}. ` +
        `Severity ${finding.severity}, category ${finding.category}.`
    );
    return lines.join('\n');
  });

  return `${blocks.join('\n\n---\n\n')}\n`;
}

/** Render a scan result as a shareable Markdown report. */
export function renderReport(result: ScanResult, opts: { now?: Date } = {}): string {
  const grade = gradeFromScore(result.score);
  const ranThese = new Set(result.checks);
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);

  const lines: string[] = [];
  lines.push(`# QA Scan — ${host(result.url)}`);
  lines.push('');
  lines.push(
    `**Grade: ${GRADE_EMOJI[grade]} ${grade}  (${result.score} / 100)**   ·   ` +
      `${result.findingCount} ${result.findingCount === 1 ? 'issue' : 'issues'} found   ·   scanned ${date}`
  );
  lines.push('');
  lines.push(`\`${meter(result.score, 100, 24)}\` ${result.score} / 100`);
  lines.push('');

  // The verdict goes above the tables: when a baseline was supplied, "did this
  // change introduce anything?" is the question the reader came with.
  if (result.delta) {
    lines.push(`**Since baseline:** ${result.delta.verdict}`);
    lines.push('');
    const bullets = [
      ['New', result.delta.new],
      ['Fixed', result.delta.fixed],
    ] as const;
    for (const [label, items] of bullets) {
      for (const item of items.slice(0, 10)) {
        lines.push(`- ${label}: ${item.message}${item.url ? ` (\`${item.url}\`)` : ''}`);
      }
      if (items.length > 10) lines.push(`- ${label}: …and ${items.length - 10} more`);
    }
    if (result.delta.new.length > 0 || result.delta.fixed.length > 0) lines.push('');
  }

  // Category summary table — one row per check that actually ran, with a bar scaled to the noisiest
  // category so the shape of the result is readable before any row is.
  const counts = CHECK_META.filter((meta) => ranThese.has(meta.check)).map((meta) => ({
    meta,
    matched: result.findings.filter((f) => meta.categories.includes(f.category)),
  }));
  const busiest = Math.max(0, ...counts.map((entry) => entry.matched.length));
  const rows = counts.map(({ meta, matched }) => {
    const worst = worstSeverity(matched);
    const bar = busiest > 0 ? ` \`${meter(matched.length, busiest, 10)}\`` : '';
    return `| ${meta.label} |${bar} ${matched.length} | ${worst ? `${SEVERITY_EMOJI[worst]} ${worst}` : '—'} |`;
  });
  if (rows.length) {
    lines.push('| Category | Issues | Worst |');
    lines.push('|----------|--------|:-----:|');
    lines.push(...rows);
    lines.push('');
  }

  lines.push(...measurementLines(result.metrics));

  if (result.findings.length === 0) {
    lines.push('---');
    lines.push('');
    lines.push('✅ No issues found in the checks that ran.');
  } else {
    const sorted = [...result.findings].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.category.localeCompare(b.category)
    );
    for (const f of sorted) {
      lines.push('---');
      lines.push('');
      const times = f.occurrences && f.occurrences > 1 ? ` (seen ${f.occurrences} times)` : '';
      lines.push(`## ${SEVERITY_EMOJI[f.severity]} ${f.severity} · ${f.message}${times}`);
      if (f.url) lines.push(`\`${f.url}\``);
      if (f.selector) lines.push(`Selector: \`${f.selector}\``);
      lines.push('');
      if (f.repro) {
        lines.push(reproBlock(f.repro));
      }
      if (f.suggestion) {
        lines.push(`**Fix:** ${f.suggestion}`);
        lines.push('');
      }
    }
  }

  if (result.screenshotPath) {
    lines.push(`Screenshot: \`${result.screenshotPath}\``);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('_Scanned by **qmax-mcp** · `npx -y @qualitymax/qmax-mcp scan <url>` · free, local, no account_');
  lines.push('');

  return lines.join('\n');
}
