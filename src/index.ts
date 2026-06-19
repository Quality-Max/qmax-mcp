#!/usr/bin/env node

import { Command } from 'commander';
import { runProxy } from './proxy';
import { printClients } from './clients';
import { runLocalServer } from './server';
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

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
