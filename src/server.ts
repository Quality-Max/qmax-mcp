import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { generatePlaywrightRepro } from './tools/generate-playwright-repro';
import { inspectPage } from './tools/inspect-page';
import { runPlaywrightTest } from './tools/run-playwright-test';
import { scanUrl } from './tools/scan-url';
import { renderReport } from './report';
import { MCP_SERVER_NAME, PACKAGE_VERSION } from './metadata';

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

function textResult(text: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
  };
}

export function createLocalServer(): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: PACKAGE_VERSION,
  });

  server.registerTool(
    'scan_url',
    {
      title: 'Scan URL',
      description:
        'Inspect a URL with outbound browser and HTTP network requests for console errors, links, accessibility, performance, SEO, and security headers. This may write a local screenshot artifact when screenshot:true. Set format:"markdown" for a shareable graded report.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        url: z.string().url(),
        checks: z.array(z.string()).optional(),
        maxLinks: z.number().int().min(0).max(250).optional(),
        screenshot: z.boolean().optional(),
        allowPrivateNetwork: z.boolean().optional(),
        format: z.enum(['json', 'markdown']).optional(),
        viewport: z
          .object({
            width: z.number().int().min(320).max(3840),
            height: z.number().int().min(320).max(2400),
          })
          .optional(),
      },
    },
    async ({ format, ...args }) => {
      const result = await scanUrl(args);
      return format === 'markdown' ? textResult(renderReport(result)) : jsonResult(result);
    }
  );

  server.registerTool(
    'inspect_page',
    {
      title: 'Inspect Page',
      description:
        'Read page structure through outbound browser network requests and return headings, forms, buttons, links, inputs, role/name selectors, and data-testid candidates. Does not intentionally modify the target or local filesystem.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        url: z.string().url(),
        includeAccessibilityTree: z.boolean().optional(),
        includeForms: z.boolean().optional(),
        allowPrivateNetwork: z.boolean().optional(),
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
      description:
        'Generate a minimal Playwright test from a scan finding, URL, or plain-English goal and write it below the approved workspace directory .qmax-mcp/repros. outputPath must be relative; existing files require overwrite:true after review. No outbound network request is made by generation.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        url: z.string().url(),
        goal: z.string().optional(),
        finding: z.record(z.string(), z.unknown()).optional(),
        testName: z.string().optional(),
        outputPath: z.string().optional(),
        overwrite: z.boolean().optional(),
      },
    },
    async (args) => jsonResult(await generatePlaywrightRepro(args))
  );

  server.registerTool(
    'run_playwright_test',
    {
      title: 'Run Playwright Test',
      description:
        'Execute supplied local Playwright code or a local test file. This is a code-execution and artifact-writing boundary: clients must obtain explicit approval before calling it. The runner may make outbound network requests requested by the test.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        testPath: z.string().optional(),
        code: z.string().optional(),
        baseUrl: z.string().url().optional(),
        browser: z.enum(['chromium', 'firefox', 'webkit']).optional(),
        headed: z.boolean().optional(),
        timeoutMs: z.number().int().min(1000).max(300000).optional(),
        wallClockTimeoutMs: z.number().int().min(1000).max(330000).optional(),
        allowedEnv: z.record(z.string(), z.string()).optional(),
        executionAcknowledged: z.literal(true).describe('Required acknowledgement before supplied test code is executed.'),
      },
    },
    async (args, extra) => jsonResult(await runPlaywrightTest(args, { signal: extra.signal }))
  );

  return server;
}

export async function runLocalServer(): Promise<void> {
  const server = createLocalServer();
  process.stderr.write('qmax-mcp: local QA MCP server running over stdio\n');
  await server.connect(new StdioServerTransport());
}
