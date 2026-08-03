#!/usr/bin/env node

import { Command } from 'commander';
import { runProxy } from './proxy';
import { printClients } from './clients';
import { runLocalServer } from './server';
import { scanUrl } from './tools/scan-url';
import { renderReport } from './report';
import { writeFile } from 'node:fs/promises';

const DEFAULT_URL = 'https://app.qualitymax.io/api/mcp';

const program = new Command();

program
  .name('qmax-mcp')
  .description('QualityMax local QA MCP server')
  .version('0.1.0')
  .option('--clients', 'Print copy-paste MCP client configs and exit')
  .action(async (options: { clients?: boolean }) => {
    if (options.clients) {
      printClients();
      return;
    }

    await runLocalServer();
  });

program
  .command('serve')
  .description('Start the local-first QA MCP server over stdio')
  .action(async () => {
    await runLocalServer();
  });

program
  .command('proxy')
  .description('Proxy MCP stdio to the hosted QualityMax MCP endpoint')
  .option('--api-key <key>', 'QualityMax API key (or set QUALITYMAX_API_KEY)')
  .option('--url <url>', 'QualityMax MCP endpoint URL', DEFAULT_URL)
  .action(async (options: { apiKey?: string; url: string }) => {
    const apiKey = options.apiKey ?? process.env['QUALITYMAX_API_KEY'] ?? '';
    const url = process.env['QUALITYMAX_API_URL'] ?? options.url;
    await runProxy(apiKey, url);
  });

program
  .command('scan')
  .description('Run deterministic local QA checks without an MCP client')
  .argument('<url>', 'URL to scan')
  .option('--checks <checks>', 'Comma-separated checks to run')
  .option('--max-links <n>', 'Maximum links to check', '50')
  .option('--screenshot', 'Capture a screenshot', false)
  .option('--format <format>', 'Output format: markdown or json', 'markdown')
  .option('--out <file>', 'Write the report to a file instead of stdout')
  .action(
    async (
      url: string,
      options: { checks?: string; maxLinks: string; screenshot: boolean; format: string; out?: string }
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
      });
      const output =
        options.format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : renderReport(result);
      if (options.out) {
        await writeFile(options.out, output, 'utf8');
        process.stderr.write(`Report written to ${options.out}\n`);
      } else {
        process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
      }
    }
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
