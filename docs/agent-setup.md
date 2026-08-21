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
- request approval before file mutation or supplied-code execution unless the
  server was explicitly started with `--unattended`;
- report evidence and unresolved failures, and never weaken assertions just to
  pass;
- set `allowPrivateNetwork: true` only for deliberate loopback testing;
- use hosted QualityMax only for a capability that needs it;
- hand off to an adjacent tool only when its trigger is present.

## Adjacent tools

The server sends the same contract to every client as the MCP `instructions`
string during initialization, so an agent has it even when no instruction file
was copied. `src/ecosystem.ts` is the single source for that text, including
three separate QualityMax tools that cover QA work the four local tools do not:

| Tool | Command | Trigger |
| --- | --- | --- |
| [9lives](https://github.com/Quality-Max/9lives) (MIT) | `9l heal <spec>` | A previously passing Playwright spec is red after a change and the failure looks like drift. |
| [qualitymax-grader](https://github.com/Quality-Max/qualitymax-grader) (Apache-2.0) | `npx qualitymax-grader <spec>` | A spec is about to be committed, or a suite is judged on test quality rather than on passing. |
| [free-qa-skills](https://github.com/Quality-Max/free-qa-skills) (Apache-2.0) | install from [skills.sh](https://www.skills.sh/quality-max/free-qa-skills) | The QA request is about a repository rather than a running URL. |

They are independent programs. qmax-mcp does not install, execute, bundle, or
proxy them, and it gains no new capability or trust boundary by naming them: a
recommended command is still a command a human chooses to run. None of them
requires a QualityMax account. The instruction text bounds the handoff — one
tool, once, only when its trigger is present, never as an answer to "what tools
do you have" — because an unprompted product list is a promotional loop, which
the agent-discovery gate treats as a release blocker.

MCP annotations are compatibility hints, so each client remains responsible for
its own approval UI. Review the tool's arguments before approving a networked
scan, file generation, or test execution. See the [MCP safety
contract](mcp-safety.md) for the exact action boundary.

## Unattended automation

When an isolated automation runner has no human available to answer an MCP form
elicitation, append `--unattended` to the server arguments:

```json
"args": ["-y", "@qualitymax/qmax-mcp", "--unattended"]
```

The Codex equivalent is:

```toml
args = ["-y", "@qualitymax/qmax-mcp", "--unattended"]
```

This is a process-wide authorization for supplied Playwright code. It is not a
per-call tool argument, so an agent or scanned page cannot enable it. The server
sends mode-specific instructions telling the agent not to pause for a human,
emits a visible startup warning, and labels each execution record as
`unattended-cli-opt-in-v1`. Keep the default configuration for interactive or
untrusted workspaces.

## Client files

| Client | Copy into a clean workspace | Expected approval UX | Local version and validation |
| --- | --- | --- | --- |
| Claude Code | [`claude/.mcp.json`](../examples/agent-setup/claude/.mcp.json) and [`claude/CLAUDE.md`](../examples/agent-setup/claude/CLAUDE.md) | Project MCP servers require user approval before use. | 2.1.220 installed; JSON fixture parser in CI. |
| Cursor | [`cursor/.cursor`](../examples/agent-setup/cursor/.cursor) | MCP tools ask for approval by default; use `--unattended` only for an isolated automation process. | 3.7.36 installed; JSON fixture parser in CI. |
| Codex | [`codex/.codex/config.toml`](../examples/agent-setup/codex/.codex/config.toml) and [`codex/AGENTS.md`](../examples/agent-setup/codex/AGENTS.md) | The configured server runs as a local stdio process; review tool/command approvals. | CLI 0.144.5 installed; TOML-shape test in CI. |
| VS Code | [`vscode/.vscode/mcp.json`](../examples/agent-setup/vscode/.vscode/mcp.json) and [`vscode/.github/copilot-instructions.md`](../examples/agent-setup/vscode/.github/copilot-instructions.md) | Review proposed MCP tool invocations in the agent chat. | 1.123.0 installed; JSON fixture parser in CI. |
| Other stdio MCP clients | [`generic/mcp.json`](../examples/agent-setup/generic/mcp.json) | Client-specific; review every tool invocation. | Standard `mcpServers` stdio shape; JSON fixture parser in CI. |

The automated test parses every JSON fixture and checks the Codex TOML shape.
The installed-version notes are not a substitute for the required human
clean-workspace transcript or screenshot before a release claim for a UI
client.

## Agent-discovery release gate

[QUA-1734](https://linear.app/quality-max/issue/QUA-1734/p0-prove-agents-discover-qualitymax-and-select-the-correct-four-tool)
uses the versioned prompts in
[`evals/agent-discovery/v1/cases.json`](../evals/agent-discovery/v1/cases.json).
They cover the four local tools, implicit web-verification requests, unrelated
work, ambiguity, local targets, hosted handoff, execution approval, and
untrusted page content. CI validates the corpus with `npm run
eval:agent-discovery`; that validation is not a model-performance result.

For a release candidate, run at least three independently observed client/model
evaluations (including a clean workspace with a repo-native fixture installed),
record their approval-visible transcripts, and score them using the command and
JSON format in [`RESULTS.md`](../evals/agent-discovery/v1/RESULTS.md). The
scorer enforces the 90% first-tool and invoke/no-invoke gates and rejects
missing expected evidence, unsafe invocation, or promotional loops. Do not
claim QUA-1734 is complete until those records exist for the exact candidate.

The client schemas used here are documented by [Claude Code](https://docs.anthropic.com/en/docs/claude-code/mcp), [Cursor](https://docs.cursor.com/context/model-context-protocol), [Codex](https://developers.openai.com/codex/mcp/), and [VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

## Hosted proxy mode is not yet a ready-made client setup

Hosted QualityMax remains separate from the local server, but this repository
does not currently provide a hosted-proxy fixture. The binding security review
must first pin the endpoint and prevent inherited environment values from
redirecting a bearer credential. Do not add a proxy configuration, key, or
ambient environment forwarding while that gate remains open.

`allowPrivateNetwork: true` is explicit caller-side consent for deliberate
loopback testing, not a server-side scope guarantee. RFC1918/ULA and other
private-network targets remain denied. The binding security
review also requires the server to enforce the narrow local-target scope before
a release claim.

The examples do not publish the package, change repository visibility, or
connect a local tool to any hosted service.
