# QualityMax QA MCP

Give a coding agent independent QA evidence before it declares a web change done: scan the page, inspect the UI, generate a focused Playwright repro, then review the execution result.

```bash
npx -y @qualitymax/qmax-mcp
```

The four local tools require no QualityMax account, API key, or hosted service.

## Start with a useful result

Ask an MCP-enabled agent to scan the URL it changed, or run the local CLI:

```bash
npx -y @qualitymax/qmax-mcp scan https://example.com --format markdown
```

The report includes a grade, findings, concrete reproduction steps, and suggested fixes. For a checked-in, dependency-free walkthrough of the whole flow, see the [reproducible demo](demo/README.md): **scan → finding → generated repro → executed evidence**.

## What the agent can do

| Tool | Local capability | Boundary to review |
| --- | --- | --- |
| `scan_url` | Scan a URL for console, network, link, accessibility, SEO, performance, and header findings. | It makes outbound requests and can write a screenshot. |
| `inspect_page` | Return page structure and role/name locator candidates. | It makes outbound requests. |
| `generate_playwright_repro` | Write a deterministic, workspace-contained Playwright repro. | It writes below `.qmax-mcp/repros`; overwrites are explicit. |
| `run_playwright_test` | Execute one local Playwright test and return structured status. | It executes code and writes controlled artifacts; requires an accepted, digest-bound MCP human-approval elicitation. |

The local server does not require an account. [Hosted proxy mode](#hosted-proxy-mode) is a separate, opt-in connection for account-backed QualityMax capabilities; do not add it unless that capability is needed.

## Add it to your coding agent

Copy a ready-made, no-credential configuration and the accompanying instruction file for your client:

| Claude Code | Cursor | Codex | VS Code |
| --- | --- | --- | --- |
| [`claude/.mcp.json`](examples/agent-setup/claude/.mcp.json) | [`cursor/.cursor`](examples/agent-setup/cursor/.cursor) | [`codex/.codex/config.toml`](examples/agent-setup/codex/.codex/config.toml) | [`vscode/.vscode/mcp.json`](examples/agent-setup/vscode/.vscode/mcp.json) |

The [agent setup guide](docs/agent-setup.md) explains the expected approval surfaces and has a generic stdio configuration. The root [`AGENTS.md`](AGENTS.md) is the portable instruction: collect evidence, report unresolved failures, and request approval before mutating files or executing supplied code.

## Safety and honest limits

- Local scanning is networked. Private targets are denied by default; `allowPrivateNetwork: true` is only deliberate caller-side consent for a narrow loopback target.
- Generated repros stay in a controlled workspace directory. Test runs use a minimal environment and controlled artifact directory.
- `run_playwright_test` uses MCP form elicitation before execution. The server displays the target, side effects, and a SHA-256 digest to the client, and runs only after the client returns an accepted human approval for that exact digest. Clients without form-elicitation support fail closed; a bare caller-supplied boolean is not accepted as proof.
- Read the full [MCP safety contract](docs/mcp-safety.md) and [security threat model](docs/security-threat-model.md) before publishing or enabling hosted capabilities.

## Architecture

![Agent-to-local-server and optional-cloud boundary](docs/launch/architecture.svg)

The [launch comparison](docs/launch/competitor-comparison.md) records dated, first-party capability references for TestSprite, BrowserStack, mabl, and Momentic. It is a factual boundary comparison, not a ranking.

## Hosted proxy mode

The local tools are the open, local-first layer. Hosted QualityMax is an explicit proxy for workspace-backed project, test-case, script, and observability workflows:

```bash
QUALITYMAX_API_KEY="<your-api-key>" npx -y @qualitymax/qmax-mcp proxy
```

Only configure the proxy when a hosted-only capability is needed. The bearer credential is sent only to the pinned `https://app.qualitymax.io/api/mcp` endpoint; endpoint overrides and redirects are refused.

## Support and responsible disclosure

Use [GitHub Issues](https://github.com/Quality-Max/qmax-mcp/issues) for non-sensitive usage and documentation support. Do not report vulnerabilities in a public issue; follow the repository [security policy](SECURITY.md). The [launch checklist](docs/launch/launch-checklist.md) includes the owner checks required before any public announcement.

## Development

The runtime requires Node 22.13.0 or newer.

```bash
npm install
npx playwright install chromium
npm run check
npm run demo
```

`npm run demo` starts a dependency-free local fixture, prints a Markdown quality receipt by default, and leaves its generated repro and Playwright artifacts under `.qmax-mcp/` for inspection. Use `npm run demo -- --format json` for a machine-readable receipt.

## Package and release metadata

`server.json` is the canonical MCP Registry manifest. `npm run validate:registry` checks it against the official schema without publishing anything. Before a release, use `npm run version:sync -- <semver>` and then `npm run version:sync -- --check` to update and verify every public metadata surface together. The release workflow and rollback procedure are documented in [the release runbook](docs/release.md).
