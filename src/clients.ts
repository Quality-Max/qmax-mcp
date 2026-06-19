const PACKAGE_NAME = '@qualitymax/qmax-mcp';
const SETTINGS_URL = 'https://app.qualitymax.io/settings/api-tokens';

export function printClients(apiKey?: string): void {
  const key = apiKey ?? '<your-api-key>';

  console.log(`
QualityMax QA MCP — client configs

Local-first mode runs deterministic QA tools on your machine. No QualityMax
API key is required for scan_url, inspect_page, generate_playwright_repro, or
run_playwright_test.

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
      "env": { "QUALITYMAX_API_KEY": "${key}" }
    }
  }
}
`);
}
