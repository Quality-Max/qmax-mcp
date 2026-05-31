#!/usr/bin/env node

import { Command } from 'commander';
import { runProxy } from './proxy';
import { printClients } from './clients';

const DEFAULT_URL = 'https://app.qualitymax.io/api/mcp';

const program = new Command();

program
  .name('qmax-mcp')
  .description('QualityMax MCP server — AI-native test automation via Model Context Protocol')
  .version('0.1.0')
  .option('--api-key <key>', 'QualityMax API key (or set QUALITYMAX_API_KEY)')
  .option('--url <url>', 'QualityMax MCP endpoint URL', DEFAULT_URL)
  .option('--clients', 'Print copy-paste client configs and exit')
  .action(async (options: { apiKey?: string; url: string; clients?: boolean }) => {
    if (options.clients) {
      const key = options.apiKey ?? process.env['QUALITYMAX_API_KEY'];
      printClients(key);
      process.exit(0);
    }

    const apiKey = options.apiKey ?? process.env['QUALITYMAX_API_KEY'] ?? '';
    const url = process.env['QUALITYMAX_API_URL'] ?? options.url;

    await runProxy(apiKey, url);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
