import { type Finding, type Severity, SEVERITY_RANK, gradeFromScore } from './tools/common';
import { formatBytes } from './tools/checks/signals';
import type { ScanMetrics } from './tools/scan-url';

export type ScanResult = {
  url: string;
  score: number;
  checks: string[];
  findingCount: number;
  findings: Finding[];
  metrics?: ScanMetrics;
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
  { check: 'console', label: 'Console errors', categories: ['console', 'network'] },
  { check: 'links', label: 'Broken links', categories: ['links'] },
  { check: 'accessibility', label: 'Accessibility', categories: ['accessibility'] },
  { check: 'performance', label: 'Performance', categories: ['performance'] },
  { check: 'seo', label: 'SEO', categories: ['seo'] },
  { check: 'security_headers', label: 'Security headers', categories: ['security_headers'] },
  { check: 'cookies', label: 'Cookies and trackers', categories: ['cookies'] },
  { check: 'mixed_content', label: 'Mixed content', categories: ['mixed_content'] },
  { check: 'weight', label: 'Page weight', categories: ['weight'] },
];

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
  for (const note of vitals?.notes ?? []) {
    lines.push(`_${note}_`);
    lines.push('');
  }
  return lines;
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

  // Category summary table — one row per check that actually ran.
  const rows = CHECK_META.filter((meta) => ranThese.has(meta.check)).map((meta) => {
    const matched = result.findings.filter((f) => meta.categories.includes(f.category));
    const worst = worstSeverity(matched);
    return `| ${meta.label} | ${matched.length} | ${worst ? `${SEVERITY_EMOJI[worst]} ${worst}` : '—'} |`;
  });
  if (rows.length) {
    lines.push('| Category | Issues | Worst |');
    lines.push('|----------|:------:|:-----:|');
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
      lines.push(`## ${SEVERITY_EMOJI[f.severity]} ${f.severity} · ${f.message}`);
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
