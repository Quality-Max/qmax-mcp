import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { generatePlaywrightRepro } from './tools/generate-playwright-repro';
import { inspectPage } from './tools/inspect-page';
import { describeExecutionApproval, runPlaywrightTest, type RunPlaywrightTestArgs } from './tools/run-playwright-test';
import { scanUrl } from './tools/scan-url';
import { renderReport } from './report';
import { SERVER_INSTRUCTIONS } from './ecosystem';
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

async function requestHumanExecutionApproval(server: McpServer, args: RunPlaywrightTestArgs) {
  const approval = await describeExecutionApproval(args);
  let response;
  try {
    response = await server.server.elicitInput({
      mode: 'form',
      message:
        `Approve execution of ${approval.source} (${approval.target}). ` +
        'It can write run artifacts and make any network requests contained in the supplied test. ' +
        `This approval is bound to SHA-256 ${approval.digest} and cannot be reused for changed code.`,
      requestedSchema: {
        type: 'object',
        properties: {
          approved: {
            type: 'boolean',
            title: 'Approve code execution',
            description: 'Select true only after reviewing the execution target and effects above.',
          },
        },
        required: ['approved'],
      },
    });
  } catch {
    throw new Error('This MCP client cannot provide verifiable human approval for code execution.');
  }

  if (response.action !== 'accept' || response.content?.['approved'] !== true) {
    throw new Error('Human approval for code execution was declined or cancelled.');
  }

  return {
    mechanism: 'mcp-form-elicitation-v1',
    digest: approval.digest,
    target: approval.target,
    client: server.server.getClientVersion()?.name || 'unknown-client',
  };
}

export function createLocalServer(): McpServer {
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: PACKAGE_VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    'scan_url',
    {
      title: 'Scan URL',
      description:
        'Inspect a URL with outbound browser and HTTP network requests for console errors, links, accessibility, Core Web Vitals, SEO, security headers, cookie and tracker privacy, mixed content, and page weight. This may write a local screenshot artifact when screenshot:true. Set format:"markdown" for a shareable graded report. allowPrivateNetwork:true is limited to deliberate loopback development targets.',
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
        weightBudget: z
          .object({
            totalBytes: z.number().int().positive().optional(),
            requestCount: z.number().int().positive().optional(),
            renderBlocking: z.number().int().nonnegative().optional(),
            imageBytes: z.number().int().positive().optional(),
            scriptBytes: z.number().int().positive().optional(),
          })
          .optional(),
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
        'Read page structure through outbound browser network requests and return headings, forms, buttons, links, inputs, role/name selectors, and data-testid candidates. Does not intentionally modify the target or local filesystem. allowPrivateNetwork:true is limited to deliberate loopback development targets.',
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
        'Execute supplied local Playwright code or a local test file. This is a code-execution and artifact-writing boundary: qmax-mcp first requires an MCP human-approval elicitation bound to the exact test digest. The runner may make outbound network requests requested by the test.',
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
      },
    },
    async (args, extra) => {
      const approval = await requestHumanExecutionApproval(server, args);
      const result = await runPlaywrightTest(args, { signal: extra.signal, approvalDigest: approval.digest });
      return jsonResult({ ...result, approval });
    }
  );

  return server;
}

export async function runLocalServer(): Promise<void> {
  const server = createLocalServer();
  process.stderr.write('qmax-mcp: local QA MCP server running over stdio\n');
  await server.connect(new StdioServerTransport());
}
