#!/usr/bin/env node

import { Command } from 'commander';
import { runProxy } from './proxy';
import { printClients } from './clients';
import { runLocalServer } from './server';
import { scanUrl } from './tools/scan-url';
import type { Severity } from './tools/common';
import { renderIssues, renderReport } from './report';
import { writeFile } from 'node:fs/promises';
import { PACKAGE_VERSION } from './metadata';

const program = new Command();

program
  .name('qmax-mcp')
  .description('QualityMax local QA MCP server')
  .version(PACKAGE_VERSION)
  .option('--clients', 'Print copy-paste MCP client configs and exit')
  .option('--unattended', 'Run supplied Playwright tests without per-run human approval')
  .action(async (options: { clients?: boolean; unattended?: boolean }) => {
    if (options.clients) {
      printClients();
      return;
    }

    await runLocalServer({ unattended: options.unattended });
  });

program
  .command('serve')
  .description('Start the local-first QA MCP server over stdio')
  .option('--unattended', 'Run supplied Playwright tests without per-run human approval')
  .action(async (options: { unattended?: boolean }) => {
    await runLocalServer({ unattended: options.unattended ?? program.opts<{ unattended?: boolean }>().unattended });
  });

program
  .command('proxy')
  .description('Proxy MCP stdio to the pinned hosted QualityMax MCP endpoint')
  .option('--api-key <key>', 'QualityMax API key (or set QUALITYMAX_API_KEY)')
  .action(async (options: { apiKey?: string }) => {
    const apiKey = options.apiKey ?? process.env['QUALITYMAX_API_KEY'] ?? '';
    await runProxy(apiKey);
  });

program
  .command('scan')
  .description('Run deterministic local QA checks without an MCP client')
  .argument('<url>', 'URL to scan')
  .option('--checks <checks>', 'Comma-separated checks to run')
  .option('--max-links <n>', 'Maximum links to check', '50')
  .option('--screenshot', 'Capture a screenshot', false)
  .option('--format <format>', 'Output format: markdown, json, or issue', 'markdown')
  .option('--min-severity <severity>', 'With --format issue, export only findings at or above this severity')
  .option('--out <file>', 'Write the report to a file instead of stdout')
  .option(
    '--allow-private-network',
    'Permit a loopback target such as a locally started app. Deliberate local development testing only',
    false
  )
  .option('--baseline <file>', 'Compare against a previous JSON scan result and report new/fixed findings')
  .option('--fail-on-new', 'Exit non-zero when the scan finds anything absent from the baseline', false)
  .action(
    async (
      url: string,
      options: {
        checks?: string;
        maxLinks: string;
        screenshot: boolean;
        format: string;
        minSeverity?: string;
        out?: string;
        allowPrivateNetwork?: boolean;
        baseline?: string;
        failOnNew?: boolean;
      }
    ) => {
      const checks = options.checks
        ?.split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const result = await scanUrl({
        url,
        checks,
        maxLinks: Number.parseInt(options.maxLinks, 10),
        screenshot: options.screenshot,
        allowPrivateNetwork: options.allowPrivateNetwork,
        baseline: options.baseline,
      });
      const output =
        options.format === 'json'
          ? `${JSON.stringify(result, null, 2)}\n`
          : options.format === 'issue'
            ? renderIssues(result, { minSeverity: options.minSeverity as Severity | undefined })
            : renderReport(result);
      if (options.out) {
        await writeFile(options.out, output, 'utf8');
        process.stderr.write(`Report written to ${options.out}\n`);
      } else {
        process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
      }

      // A pipeline gating on "findingCount > 0" cannot pass once a page has any
      // known-benign finding. Gating on "nothing new since the last green run"
      // is the check that stays useful, so it gets an exit code.
      if (options.failOnNew) {
        if (!options.baseline) {
          process.stderr.write('--fail-on-new needs --baseline to compare against.\n');
          process.exit(2);
        }
        const fresh = result.delta?.new.length ?? 0;
        if (fresh > 0) {
          process.stderr.write(`${fresh} new finding${fresh === 1 ? '' : 's'} since baseline.\n`);
          process.exit(1);
        }
      }
    }
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
