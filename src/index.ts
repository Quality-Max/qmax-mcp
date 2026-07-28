#!/usr/bin/env node

import { Command } from 'commander';
import { runProxy } from './proxy';
import { printClients } from './clients';
import { runLocalServer } from './server';
import { bugsinkErrorSummary, bugsinkListIssues } from './tools/bugsink';
import { scanUrl } from './tools/scan-url';

const DEFAULT_URL = 'https://app.qualitymax.io/api/mcp';

const program = new Command();

program
  .name('qmax-mcp')
  .description('QualityMax local QA MCP server')
  .version('0.1.0')
  .option('--clients', 'Print copy-paste MCP client configs and exit')
  .action(async (options: { clients?: boolean }) => {
    if (options.clients) {
      printClients(process.env['QUALITYMAX_API_KEY']);
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
  .action(async (url: string, options: { checks?: string; maxLinks: string; screenshot: boolean }) => {
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
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

const bugsink = program
  .command('bugsink')
  .description('Read-only, sanitized Bugsink error queries (needs QMAX_BUGSINK_URL and QMAX_BUGSINK_TOKEN)');

bugsink
  .command('summary')
  .description('Sanitized per-project error summary from Bugsink')
  .option('--project <idOrName>', 'Bugsink project id or name (defaults to the only project)')
  .action(async (options: { project?: string }) => {
    const result = await bugsinkErrorSummary({ project: options.project });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  });

bugsink
  .command('issues')
  .description('Sanitized, length-capped Bugsink issue list')
  .option('--project <idOrName>', 'Bugsink project id or name (defaults to the only project)')
  .option('--limit <n>', 'Maximum issues to return (max 50)', '20')
  .option('--sort <sort>', 'Sort key: last_seen | events | digest_order', 'last_seen')
  .option('--order <order>', 'Order: asc | desc', 'desc')
  .option('--cursor <cursor>', 'Pagination cursor from a previous response')
  .action(async (options: { project?: string; limit: string; sort: string; order: string; cursor?: string }) => {
    const result = await bugsinkListIssues({
      project: options.project,
      limit: Number.parseInt(options.limit, 10),
      sort: options.sort as 'last_seen' | 'events' | 'digest_order',
      order: options.order as 'asc' | 'desc',
      cursor: options.cursor,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
