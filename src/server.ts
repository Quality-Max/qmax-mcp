import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { bugsinkErrorSummary, bugsinkListIssues } from './tools/bugsink';
import { generatePlaywrightRepro } from './tools/generate-playwright-repro';
import { inspectPage } from './tools/inspect-page';
import { runPlaywrightTest } from './tools/run-playwright-test';
import { scanUrl } from './tools/scan-url';

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export async function runLocalServer(): Promise<void> {
  const server = new McpServer({
    name: 'qmax-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'scan_url',
    {
      title: 'Scan URL',
      description:
        'Run deterministic local QA checks against a URL: console errors, broken links, accessibility, performance, SEO, and security headers.',
      inputSchema: {
        url: z.string().url(),
        checks: z.array(z.string()).optional(),
        maxLinks: z.number().int().min(0).max(250).optional(),
        screenshot: z.boolean().optional(),
        viewport: z
          .object({
            width: z.number().int().min(320).max(3840),
            height: z.number().int().min(320).max(2400),
          })
          .optional(),
      },
    },
    async (args) => jsonResult(await scanUrl(args))
  );

  server.registerTool(
    'inspect_page',
    {
      title: 'Inspect Page',
      description:
        'Return headings, forms, buttons, links, inputs, role/name selectors, and data-testid candidates for a page.',
      inputSchema: {
        url: z.string().url(),
        includeAccessibilityTree: z.boolean().optional(),
        includeForms: z.boolean().optional(),
        viewport: z
          .object({
            width: z.number().int().min(320).max(3840),
            height: z.number().int().min(320).max(2400),
          })
          .optional(),
      },
    },
    async (args) => jsonResult(await inspectPage(args))
  );

  server.registerTool(
    'generate_playwright_repro',
    {
      title: 'Generate Playwright Repro',
      description: 'Generate a minimal Playwright test from a scan finding, URL, or plain-English goal.',
      inputSchema: {
        url: z.string().url(),
        goal: z.string().optional(),
        finding: z.record(z.string(), z.unknown()).optional(),
        testName: z.string().optional(),
        outputPath: z.string().optional(),
      },
    },
    async (args) => jsonResult(await generatePlaywrightRepro(args))
  );

  server.registerTool(
    'run_playwright_test',
    {
      title: 'Run Playwright Test',
      description: 'Run one local Playwright test file or inline test and return structured output.',
      inputSchema: {
        testPath: z.string().optional(),
        code: z.string().optional(),
        baseUrl: z.string().url().optional(),
        browser: z.enum(['chromium', 'firefox', 'webkit']).optional(),
        headed: z.boolean().optional(),
        timeoutMs: z.number().int().min(1000).max(300000).optional(),
      },
    },
    async (args) => jsonResult(await runPlaywrightTest(args))
  );

  server.registerTool(
    'bugsink_error_summary',
    {
      title: 'Bugsink Error Summary',
      description:
        'Read-only, sanitized health snapshot of qmax-code runtime errors from Bugsink: per-project ' +
        'unresolved/muted/resolved counts and the top recent unresolved issues, for post-deploy ' +
        'validation. Returns only issue-level metadata (no event payloads, request bodies, cookies, ' +
        'DSNs, or tokens) and includes visible cache freshness capped at 10 minutes. Requires ' +
        'QMAX_BUGSINK_URL and QMAX_BUGSINK_TOKEN in the environment.',
      inputSchema: {
        project: z.union([z.string(), z.number()]).optional(),
      },
    },
    async (args) => jsonResult(await bugsinkErrorSummary(args))
  );

  server.registerTool(
    'bugsink_list_issues',
    {
      title: 'Bugsink List Issues',
      description:
        'Read-only, sanitized, length-capped list of qmax-code Bugsink issues (max 50) with type, ' +
        'value, transaction, event counts, first/last seen, and resolution state — for verifying a ' +
        'specific post-deploy error (e.g. the QUA-1579 check). Returns only sanitized issue-level ' +
        'metadata (never event payloads, request bodies, cookies, DSNs, or tokens) and includes ' +
        'visible cache freshness capped at 10 minutes. Requires QMAX_BUGSINK_URL and ' +
        'QMAX_BUGSINK_TOKEN in the environment.',
      inputSchema: {
        project: z.union([z.string(), z.number()]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        sort: z.enum(['last_seen', 'events', 'digest_order']).optional(),
        order: z.enum(['asc', 'desc']).optional(),
        cursor: z.string().optional(),
      },
    },
    async (args) => jsonResult(await bugsinkListIssues(args))
  );

  process.stderr.write('qmax-mcp: local QA MCP server running over stdio\n');
  await server.connect(new StdioServerTransport());
}
