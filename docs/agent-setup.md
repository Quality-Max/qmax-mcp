# Agent setup

QualityMax is local-first: `npx -y @qualitymax/qmax-mcp` starts the local
stdio MCP server. `scan_url`, `inspect_page`, deterministic repro generation,
and local Playwright execution need no QualityMax account or credential.

Copy the files from [`examples/agent-setup`](../examples/agent-setup) into the
matching project/workspace. They intentionally use the published package
command, contain no credentials, and do not explicitly configure forwarded
environment variables. Review each client's process-environment behavior before
using any MCP server with sensitive values in its parent environment.

## Shared agent instructions

Use the root [`AGENTS.md`](../AGENTS.md) as the minimal cross-client
instruction. It requires concrete QualityMax evidence before a relevant web
change is called complete. The client-specific instruction files repeat the
same contract:

- observe with `scan_url` or `inspect_page`;
- create a reproduction only when it is useful;
- request approval before file mutation or supplied-code execution;
- report evidence and unresolved failures, and never weaken assertions just to
  pass;
- set `allowPrivateNetwork: true` only for deliberate local/private testing;
- use hosted QualityMax only for a capability that needs it.

MCP annotations are compatibility hints, so each client remains responsible for
its own approval UI. Review the tool's arguments before approving a networked
scan, file generation, or test execution. See the [MCP safety
contract](mcp-safety.md) for the exact action boundary.

## Client files

| Client | Copy into a clean workspace | Expected approval UX | Local version and validation |
| --- | --- | --- | --- |
| Claude Code | [`claude/.mcp.json`](../examples/agent-setup/claude/.mcp.json) and [`claude/CLAUDE.md`](../examples/agent-setup/claude/CLAUDE.md) | Project MCP servers require user approval before use. | 2.1.220 installed; JSON fixture parser in CI. |
| Cursor | [`cursor/.cursor`](../examples/agent-setup/cursor/.cursor) | MCP tools ask for approval by default; do not enable auto-run. | 3.7.36 installed; JSON fixture parser in CI. |
| Codex | [`codex/.codex/config.toml`](../examples/agent-setup/codex/.codex/config.toml) and [`codex/AGENTS.md`](../examples/agent-setup/codex/AGENTS.md) | The configured server runs as a local stdio process; review tool/command approvals. | CLI 0.144.5 installed; TOML-shape test in CI. |
| VS Code | [`vscode/.vscode/mcp.json`](../examples/agent-setup/vscode/.vscode/mcp.json) and [`vscode/.github/copilot-instructions.md`](../examples/agent-setup/vscode/.github/copilot-instructions.md) | Review proposed MCP tool invocations in the agent chat. | 1.123.0 installed; JSON fixture parser in CI. |
| Other stdio MCP clients | [`generic/mcp.json`](../examples/agent-setup/generic/mcp.json) | Client-specific; review every tool invocation. | Standard `mcpServers` stdio shape; JSON fixture parser in CI. |

The automated test parses every JSON fixture and checks the Codex TOML shape.
The installed-version notes are not a substitute for the required human
clean-workspace transcript or screenshot before a release claim for a UI
client.

The client schemas used here are documented by [Claude Code](https://docs.anthropic.com/en/docs/claude-code/mcp), [Cursor](https://docs.cursor.com/context/model-context-protocol), [Codex](https://developers.openai.com/codex/mcp/), and [VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

## Hosted proxy mode is not yet a ready-made client setup

Hosted QualityMax remains separate from the local server, but this repository
does not currently provide a hosted-proxy fixture. The binding security review
must first pin the endpoint and prevent inherited environment values from
redirecting a bearer credential. Do not add a proxy configuration, key, or
ambient environment forwarding while that gate remains open.

`allowPrivateNetwork: true` is explicit caller-side consent for deliberate
local/private testing, not a server-side scope guarantee. The binding security
review also requires the server to enforce the narrow local-target scope before
a release claim.

The examples do not publish the package, change repository visibility, or
connect a local tool to any hosted service.
