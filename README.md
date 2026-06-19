# QualityMax QA MCP

Private-first MCP server for local QA automation.

Give Claude Code, Cursor, and other MCP clients the ability to scan a URL, inspect a page, generate Playwright repro tests, and run those tests locally.

```bash
npx -y @qualitymax/qmax-mcp
```

No QualityMax account is required for the local tools.

## Tools

### `scan_url`

Runs deterministic local QA checks:

- browser console errors and warnings
- failed network requests
- broken links
- basic accessibility issues
- SEO basics
- lightweight performance timing
- HTTP security headers
- optional screenshot capture

### `inspect_page`

Returns structured page context for agents:

- headings
- buttons, links, inputs, and forms
- role/name locator suggestions
- data-testid/data-test/data-qa candidates
- accessibility snapshot

### `generate_playwright_repro`

Generates a minimal Playwright `.spec.ts` from a URL, goal, or `scan_url` finding.

The first version is deterministic template generation. BYO LLM and hosted QualityMax generation can be added without changing the tool contract.

### `run_playwright_test`

Runs one local Playwright test file or inline test and returns structured status, output, failures, and artifact directory.

## No-MCP CLI

```bash
npx -y @qualitymax/qmax-mcp scan https://example.com --screenshot
```

## Client Configs

Print copy-paste configs:

```bash
npx -y @qualitymax/qmax-mcp --clients
```

Claude Code `.mcp.json`:

```json
{
  "mcpServers": {
    "qmax": {
      "command": "npx",
      "args": ["-y", "@qualitymax/qmax-mcp"]
    }
  }
}
```

## Hosted Proxy Mode

The local tools are the OSS wedge. Hosted QualityMax remains available as an explicit proxy mode for workspace-backed project/test-case/script workflows:

```bash
QUALITYMAX_API_KEY=qm_... npx -y @qualitymax/qmax-mcp proxy
```

## Private-First Launch Boundary

Free/private-first:

- local URL scanning
- page inspection
- deterministic Playwright repro generation
- local Playwright execution

Keep paid:

- hosted browser runners
- persisted projects, scripts, executions, and history
- CI gates and PR comments
- managed self-healing at scale
- private repo analysis
- corpus-backed AI crawl
- team dashboards and enterprise auth

## Development

```bash
npm install
npm run build
npx playwright install chromium
node dist/index.js scan https://example.com
```
