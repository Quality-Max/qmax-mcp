import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { generatePlaywrightRepro } from './tools/generate-playwright-repro';
import { inspectPage } from './tools/inspect-page';
import { describeExecutionApproval, runPlaywrightTest, type RunPlaywrightTestArgs } from './tools/run-playwright-test';
import { SUPPORTED_CHECKS, scanUrl } from './tools/scan-url';
import { renderReport } from './report';
import { renderServerInstructions } from './ecosystem';
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

/**
 * Describe *why* execution was not authorized, in terms the caller can act on.
 *
 * The failure used to read only "declined or cancelled", which covers three
 * different situations with three different remedies: a human said no, a client
 * closed the prompt, or a client answered the form without approving. None of
 * them mentioned which mode the server was started in, so a caller in an
 * automated environment could not tell "no human is available here" from "a
 * human refused" — and the fix for the former (`--unattended`, which is
 * process-start only) is invisible from inside the session.
 */
export function describeApprovalFailure(context: {
  reason: 'client-unsupported' | 'declined' | 'cancelled' | 'not-approved';
  digest: string;
  client: string;
}): string {
  const where = `gated mode; digest ${context.digest.slice(0, 12)}; client ${context.client}`;
  const enableUnattended =
    'Start the server with --unattended for isolated automation where no human can answer an elicitation.';

  if (context.reason === 'client-unsupported') {
    return (
      `This MCP client cannot provide verifiable human approval for code execution (${where}). ` +
      `${enableUnattended} Otherwise connect a client that supports MCP form elicitation.`
    );
  }

  const outcome = {
    declined: 'was declined by the human reviewer',
    cancelled: 'was cancelled before an answer was given',
    'not-approved': 'was answered without granting approval',
  }[context.reason];

  return `Human approval for code execution ${outcome} (${where}). ${enableUnattended}`;
}

async function requestHumanExecutionApproval(server: McpServer, args: RunPlaywrightTestArgs) {
  const approval = await describeExecutionApproval(args);
  const client = server.server.getClientVersion()?.name || 'unknown-client';
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
    throw new Error(
      describeApprovalFailure({ reason: 'client-unsupported', digest: approval.digest, client })
    );
  }

  if (response.action !== 'accept' || response.content?.['approved'] !== true) {
    const reason =
      response.action === 'decline'
        ? 'declined'
        : response.action === 'cancel'
          ? 'cancelled'
          : 'not-approved';
    throw new Error(describeApprovalFailure({ reason, digest: approval.digest, client }));
  }

  return {
    mechanism: 'mcp-form-elicitation-v1',
    digest: approval.digest,
    target: approval.target,
    client,
  };
}

export type LocalServerOptions = {
  /** Execute supplied Playwright tests without a per-run MCP human elicitation. */
  unattended?: boolean;
};

async function authorizeExecution(server: McpServer, args: RunPlaywrightTestArgs, unattended: boolean) {
  if (!unattended) return requestHumanExecutionApproval(server, args);

  const authorization = await describeExecutionApproval(args);
  return {
    mechanism: 'unattended-cli-opt-in-v1',
    digest: authorization.digest,
    target: authorization.target,
    client: server.server.getClientVersion()?.name || 'unknown-client',
    unattended: true,
  };
}

export function createLocalServer(options: LocalServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: PACKAGE_VERSION,
    },
    { instructions: renderServerInstructions(options) }
  );

  server.registerTool(
    'scan_url',
    {
      title: 'Scan URL',
      description:
        'Inspect a URL with outbound browser and HTTP network requests for console errors, links, accessibility, Core Web Vitals, SEO, security headers, cookie and tracker privacy, mixed content, and page weight. storageStatePath may name a workspace-relative Playwright storage-state file so the checks can run on an authenticated page; its credentials are loaded into the throwaway browser context and never returned, but the returned findings may reflect private content. This may write a local screenshot artifact when screenshot:true. Set format:"markdown" for a shareable graded report. allowPrivateNetwork:true is limited to deliberate loopback development targets.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        url: z.string().url(),
        checks: z.array(z.enum(SUPPORTED_CHECKS)).optional(),
        storageStatePath: z.string().min(1).optional(),
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
        'Read page structure through outbound browser network requests and return headings, forms, buttons, links, inputs, role/name selectors, and data-testid candidates. storageStatePath may name a workspace-relative Playwright storage-state file for authenticated pages; its credentials are loaded into the throwaway browser context and never returned, but the returned page content may be private. Does not intentionally modify the target or local filesystem. allowPrivateNetwork:true is limited to deliberate loopback development targets.',
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
        storageStatePath: z.string().min(1).optional(),
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
      description: options.unattended
        ? 'Execute supplied local Playwright code or a local test file. This server was explicitly started with --unattended, so no per-run human approval is requested. The exact test is still snapshotted and digest-bound. Execution writes artifacts and may make outbound network requests requested by the test.'
        : 'Execute supplied local Playwright code or a local test file. This is a code-execution and artifact-writing boundary: qmax-mcp first requires an MCP human-approval elicitation bound to the exact test digest. The runner may make outbound network requests requested by the test.',
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
      const approval = await authorizeExecution(server, args, options.unattended === true);
      const result = await runPlaywrightTest(args, { signal: extra.signal, approvalDigest: approval.digest });
      return jsonResult({ ...result, approval });
    }
  );

  return server;
}

export async function runLocalServer(options: LocalServerOptions = {}): Promise<void> {
  const server = createLocalServer(options);
  process.stderr.write(
    options.unattended
      ? 'qmax-mcp: local QA MCP server running over stdio in UNATTENDED execution mode\n'
      : 'qmax-mcp: local QA MCP server running over stdio\n'
  );
  await server.connect(new StdioServerTransport());
}
