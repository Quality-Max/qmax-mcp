const MCP_URL = 'https://app.qualitymax.io/api/mcp';
const SETTINGS_URL = 'https://app.qualitymax.io/settings/api-tokens';

export function printClients(apiKey?: string): void {
  const key = apiKey ?? '<your-api-key>';

  console.log(`
QualityMax MCP — client configs
Get your API key at ${SETTINGS_URL}

─────────────────────────────────────────────
Claude Code  (.mcp.json in your project root)
─────────────────────────────────────────────
{
  "mcpServers": {
    "qualitymax": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer ${key}" }
    }
  }
}

─────────────────────────────────────────
Claude Desktop  (claude_desktop_config.json)
─────────────────────────────────────────
{
  "mcpServers": {
    "qualitymax": {
      "command": "npx",
      "args": ["-y", "@qualitymax/mcp"],
      "env": { "QUALITYMAX_API_KEY": "${key}" }
    }
  }
}

─────────────────────────────────────────
Cursor  (~/.cursor/mcp.json)
─────────────────────────────────────────
{
  "mcpServers": {
    "qualitymax": {
      "command": "npx",
      "args": ["-y", "@qualitymax/mcp"],
      "env": { "QUALITYMAX_API_KEY": "${key}" }
    }
  }
}

─────────────────────────────────────────
Windsurf  (~/.codeium/windsurf/mcp_config.json)
─────────────────────────────────────────
{
  "mcpServers": {
    "qualitymax": {
      "command": "npx",
      "args": ["-y", "@qualitymax/mcp"],
      "env": { "QUALITYMAX_API_KEY": "${key}" }
    }
  }
}

─────────────────────────────────────────
Docker
─────────────────────────────────────────
docker run -i -e QUALITYMAX_API_KEY=${key} qualitymax/mcp
`);
}
