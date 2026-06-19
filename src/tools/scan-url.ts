import { writeTempFile, type Finding, type Viewport, scoreFromFindings, validateHttpUrl, withPage } from './common';

const DEFAULT_CHECKS = ['console', 'links', 'accessibility', 'performance', 'seo', 'security_headers'];

export type ScanUrlArgs = {
  url: string;
  checks?: string[];
  maxLinks?: number;
  screenshot?: boolean;
  viewport?: Viewport;
};

export async function scanUrl(args: ScanUrlArgs) {
  const url = validateHttpUrl(args.url);
  const checks = new Set((args.checks && args.checks.length ? args.checks : DEFAULT_CHECKS).map((item) => item.toLowerCase()));
  const findings: Finding[] = [];
  const consoleMessages: Array<{ type: string; text: string; location?: unknown }> = [];
  const requestFailures: Array<{ url: string; failure?: string }> = [];
  let mainHeaders: Record<string, string> = {};
  let screenshotPath: string | undefined;

  await withPage({ url, viewport: args.viewport }, async (page) => {
    page.on('console', (msg) => {
      if (['error', 'warning'].includes(msg.type())) {
        consoleMessages.push({
          type: msg.type(),
          text: msg.text().slice(0, 1000),
          location: msg.location(),
        });
      }
    });
    page.on('pageerror', (err) => {
      consoleMessages.push({ type: 'error', text: err.message.slice(0, 1000) });
    });
    page.on('requestfailed', (request) => {
      requestFailures.push({
        url: request.url(),
        failure: request.failure()?.errorText,
      });
    });

    const response = await page.reload({ waitUntil: 'networkidle', timeout: 30_000 }).catch(async () => {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    });
    mainHeaders = response?.headers() ?? {};

    if (checks.has('console')) {
      for (const message of consoleMessages) {
        findings.push({
          severity: message.type === 'error' ? 'high' : 'medium',
          category: 'console',
          message: `${message.type}: ${message.text}`,
          evidence: message.location,
          suggestion: 'Fix runtime errors and warnings before relying on generated tests.',
        });
      }
      for (const failed of requestFailures.slice(0, 20)) {
        findings.push({
          severity: 'medium',
          category: 'network',
          message: `Request failed: ${failed.failure ?? 'unknown error'}`,
          url: failed.url,
          suggestion: 'Verify the asset or API route is reachable in the tested environment.',
        });
      }
    }

    if (checks.has('links')) {
      findings.push(...(await checkLinks(pageUrl(url), await page.locator('a[href]').evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).href)), args.maxLinks ?? 50)));
    }

    if (checks.has('accessibility')) {
      findings.push(...(await page.evaluate(() => {
        const issues: Finding[] = [];
        const selectorFor = (el: Element) => {
          const id = el.getAttribute('id');
          if (id) return `#${CSS.escape(id)}`;
          const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
          if (testId) return `[data-testid="${testId}"]`;
          return el.tagName.toLowerCase();
        };

        for (const img of Array.from(document.images)) {
          if (!img.getAttribute('alt')) {
            issues.push({
              severity: 'medium',
              category: 'accessibility',
              message: 'Image is missing alt text.',
              selector: selectorFor(img),
              suggestion: 'Add meaningful alt text or alt="" for decorative images.',
            });
          }
        }

        for (const input of Array.from(document.querySelectorAll('input, textarea, select'))) {
          const id = input.getAttribute('id');
          const hasLabel = Boolean(
            input.getAttribute('aria-label') ||
              input.getAttribute('aria-labelledby') ||
              (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) ||
              input.closest('label')
          );
          if (!hasLabel && input.getAttribute('type') !== 'hidden') {
            issues.push({
              severity: 'high',
              category: 'accessibility',
              message: 'Form control has no accessible label.',
              selector: selectorFor(input),
              suggestion: 'Associate the control with a visible label or aria-label.',
            });
          }
        }

        for (const el of Array.from(document.querySelectorAll('button, a[href], [role="button"], [role="link"]'))) {
          const name = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
          if (!name) {
            issues.push({
              severity: 'medium',
              category: 'accessibility',
              message: 'Interactive element has no accessible name.',
              selector: selectorFor(el),
              suggestion: 'Add visible text or aria-label.',
            });
          }
        }

        const h1Count = document.querySelectorAll('h1').length;
        if (h1Count !== 1) {
          issues.push({
            severity: h1Count === 0 ? 'medium' : 'low',
            category: 'accessibility',
            message: `Expected exactly one h1, found ${h1Count}.`,
            suggestion: 'Use one clear h1 for the page topic.',
          });
        }

        return issues;
      })));
    }

    if (checks.has('seo')) {
      const seo = await page.evaluate(() => ({
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
        h1Count: document.querySelectorAll('h1').length,
      }));
      if (!seo.title || seo.title.length < 10) {
        findings.push({ severity: 'low', category: 'seo', message: 'Page title is missing or very short.' });
      }
      if (!seo.description || seo.description.length < 50) {
        findings.push({ severity: 'low', category: 'seo', message: 'Meta description is missing or very short.' });
      }
    }

    if (checks.has('performance')) {
      const perf = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        return nav
          ? {
              domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
              loadMs: Math.round(nav.loadEventEnd - nav.startTime),
              transferSize: nav.transferSize,
            }
          : null;
      });
      if (perf?.domContentLoadedMs && perf.domContentLoadedMs > 3000) {
        findings.push({
          severity: 'medium',
          category: 'performance',
          message: `DOM content loaded in ${perf.domContentLoadedMs}ms.`,
          evidence: perf,
          suggestion: 'Investigate render-blocking resources and slow server responses.',
        });
      }
    }

    if (checks.has('security_headers')) {
      findings.push(...checkSecurityHeaders(mainHeaders));
    }

    if (args.screenshot) {
      const file = await writeTempFile('scan', 'png', '');
      await page.screenshot({ path: file, fullPage: true });
      screenshotPath = file;
    }
  });

  return {
    url,
    score: scoreFromFindings(findings),
    checks: Array.from(checks),
    findingCount: findings.length,
    findings,
    screenshotPath,
  };
}

function pageUrl(url: string): URL {
  return new URL(url);
}

async function checkLinks(baseUrl: URL, hrefs: string[], maxLinks: number): Promise<Finding[]> {
  const findings: Finding[] = [];
  const unique = Array.from(new Set(hrefs))
    .filter((href) => href.startsWith('http://') || href.startsWith('https://'))
    .slice(0, Math.max(0, maxLinks));

  await Promise.all(
    unique.map(async (href) => {
      try {
        const url = new URL(href, baseUrl);
        const res = await fetch(url, { method: 'HEAD', redirect: 'follow' }).catch(() => fetch(url, { method: 'GET', redirect: 'follow' }));
        if (res.status >= 400) {
          findings.push({
            severity: res.status >= 500 ? 'high' : 'medium',
            category: 'links',
            message: `Link returned HTTP ${res.status}.`,
            url: url.toString(),
            suggestion: 'Update, redirect, or remove the broken link.',
          });
        }
      } catch (err) {
        findings.push({
          severity: 'medium',
          category: 'links',
          message: `Link check failed: ${err instanceof Error ? err.message : String(err)}`,
          url: href,
        });
      }
    })
  );

  return findings;
}

function checkSecurityHeaders(headers: Record<string, string>): Finding[] {
  const required: Array<[string, string, Finding['severity']]> = [
    ['content-security-policy', 'Add a Content-Security-Policy to reduce script injection risk.', 'medium'],
    ['strict-transport-security', 'Add HSTS on HTTPS sites.', 'medium'],
    ['x-content-type-options', 'Add X-Content-Type-Options: nosniff.', 'low'],
    ['referrer-policy', 'Add a Referrer-Policy header.', 'low'],
  ];
  return required
    .filter(([header]) => !headers[header])
    .map(([header, suggestion, severity]) => ({
      severity,
      category: 'security_headers',
      message: `Missing ${header} header.`,
      suggestion,
    }));
}
