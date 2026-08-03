import { writeGeneratedOutput } from './generated-output';

export type GeneratePlaywrightReproArgs = {
  url: string;
  goal?: string;
  finding?: Record<string, unknown>;
  testName?: string;
  outputPath?: string;
  overwrite?: boolean;
};

export async function generatePlaywrightRepro(args: GeneratePlaywrightReproArgs) {
  const title = sanitizeTestName(args.testName || args.goal || findingMessage(args.finding) || 'QualityMax repro');
  const code = buildTest(args.url, title, args.goal, args.finding);
  const filePath = await writeGeneratedOutput({
    content: code,
    outputPath: args.outputPath,
    overwrite: args.overwrite,
  });

  return {
    filePath,
    code,
    assumptions: [
      'Generated locally from deterministic templates.',
      'Written beneath .qmax-mcp/repros as a workspace-relative path.',
      'Review selectors before committing.',
      'Use inspect_page when a stronger role/data-testid locator is needed.',
    ],
  };
}

function buildTest(url: string, title: string, goal?: string, finding?: Record<string, unknown>): string {
  const category = typeof finding?.['category'] === 'string' ? finding['category'] : '';
  const message = findingMessage(finding);
  const escapedUrl = JSON.stringify(url);
  const escapedTitle = JSON.stringify(title);

  if (category === 'console' || category === 'network') {
    return `import { test, expect } from '@playwright/test';

test(${escapedTitle}, async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(${escapedUrl}, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  expect(errors, ${JSON.stringify(message || 'No console/page errors expected')}).toEqual([]);
});
`;
  }

  if (category === 'links') {
    const link = typeof finding?.['url'] === 'string' ? finding['url'] : undefined;
    return `import { test, expect, request } from '@playwright/test';

test(${escapedTitle}, async ({ page }) => {
  await page.goto(${escapedUrl}, { waitUntil: 'domcontentloaded' });
  const api = await request.newContext();
  const response = await api.get(${JSON.stringify(link || url)});
  expect(response.status()).toBeLessThan(400);
});
`;
  }

  if (category === 'accessibility') {
    const selector = typeof finding?.['selector'] === 'string' ? finding['selector'] : 'body';
    return `import { test, expect } from '@playwright/test';

test(${escapedTitle}, async ({ page }) => {
  await page.goto(${escapedUrl}, { waitUntil: 'domcontentloaded' });
  const target = page.locator(${JSON.stringify(selector)}).first();
  await expect(target).toBeVisible();
  // Finding: ${comment(message)}
});
`;
  }

  return `import { test, expect } from '@playwright/test';

test(${escapedTitle}, async ({ page }) => {
  await page.goto(${escapedUrl}, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle(/.+/);
  // Goal: ${comment(goal || message || 'Add assertions for the target workflow.')}
});
`;
}

function sanitizeTestName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120) || 'QualityMax repro';
}

function findingMessage(finding?: Record<string, unknown>): string {
  return typeof finding?.['message'] === 'string' ? finding['message'] : '';
}

function comment(value: string): string {
  return value.replace(/\*\//g, '* /').replace(/\n/g, ' ').slice(0, 300);
}
