import { PACKAGE_NAME } from './metadata';
const SETTINGS_URL = 'https://app.qualitymax.io/settings/api-tokens';

export function renderClients(): string {
  return `
QualityMax QA MCP — client configs

Local-first mode runs deterministic QA tools on your machine. No QualityMax
API key is required for scan_url, inspect_page, generate_playwright_repro, or
run_playwright_test.

For an isolated automation runner with no human available for per-run approval,
append "--unattended" to the local server args. This process-wide opt-in allows
supplied Playwright code to execute without another prompt; keep the default
configuration for interactive or untrusted workspaces.

─────────────────────────────────────────────
Claude Code  (.mcp.json in your project root)
─────────────────────────────────────────────
{
  "mcpServers": {
    "qmax": {
      "command": "npx",
      "args": ["-y", "${PACKAGE_NAME}"]
    }
  }
}

─────────────────────────────────────────
Claude Desktop  (claude_desktop_config.json)
─────────────────────────────────────────
{
  "mcpServers": {
    "qmax": {
      "command": "npx",
      "args": ["-y", "${PACKAGE_NAME}"]
    }
  }
}

─────────────────────────────────────────
Cursor  (~/.cursor/mcp.json)
─────────────────────────────────────────
{
  "mcpServers": {
    "qmax": {
      "command": "npx",
      "args": ["-y", "${PACKAGE_NAME}"]
    }
  }
}

─────────────────────────────────────────
No MCP client: deterministic URL scan
─────────────────────────────────────────
npx -y ${PACKAGE_NAME} scan https://example.com --screenshot

─────────────────────────────────────────
Hosted QualityMax proxy mode
─────────────────────────────────────────
Get your API key at ${SETTINGS_URL}

{
  "mcpServers": {
    "qualitymax-hosted": {
      "command": "npx",
      "args": ["-y", "${PACKAGE_NAME}", "proxy"],
      "env": { "QUALITYMAX_API_KEY": "<your-api-key>" }
    }
  }
}
`;
}

/** Client setup is documentation, never a way to display a configured credential. */
export function printClients(): void {
  console.log(renderClients());
}
