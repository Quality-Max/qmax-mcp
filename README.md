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

### `bugsink_error_summary` / `bugsink_list_issues`

Read-only, sanitized access to qmax-code runtime errors in [Bugsink](https://www.bugsink.com/) so
autonomous delivery agents can run post-deploy validation without an interactive session.

- `bugsink_error_summary` — per-project unresolved/muted/resolved counts and the top recent
  unresolved issues.
- `bugsink_list_issues` — a length-capped (max 50) issue list with type, value, transaction, event
  counts, first/last seen, and resolution state.

Both tools hold a strict safety boundary and **only ever return issue-level metadata** — never event
payloads, request bodies, cookies, DSNs, tokens, or raw infra logs. Every free-text field is scrubbed
for secrets before it is returned, and each response carries a `cacheFreshness` block whose age is
**hard-capped at 10 minutes**.

Configure via environment variables (a read-scoped token, read from the environment and never echoed
back):

```bash
export QMAX_BUGSINK_URL=https://bugsink.example.com
export QMAX_BUGSINK_TOKEN=your-read-only-bugsink-token
# Optional; capped at 600 seconds.
export QMAX_BUGSINK_CACHE_TTL_SECONDS=600
```

When these are unset the tools return a structured, non-fatal `configured: false` result instead of
failing, so the rest of the server keeps working.

## No-MCP CLI

```bash
npx -y @qualitymax/qmax-mcp scan https://example.com --screenshot
```

Read-only Bugsink queries (needs `QMAX_BUGSINK_URL` and `QMAX_BUGSINK_TOKEN`):

```bash
npx -y @qualitymax/qmax-mcp bugsink summary
npx -y @qualitymax/qmax-mcp bugsink issues --limit 20 --sort last_seen
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
