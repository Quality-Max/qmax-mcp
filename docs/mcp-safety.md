# MCP safety contract

MCP annotations are machine-readable hints, so clients still need to present
their own approval UI. qmax-mcp therefore makes the action boundary explicit in
both the annotation flags and every tool description.

| Tool | Network | Local filesystem | Local code execution | Approval boundary |
| --- | --- | --- | --- | --- |
| `scan_url` | Outbound browser and HTTP requests | Optional screenshot artifact | No | Approve a networked scan / artifact write |
| `inspect_page` | Outbound browser requests | No intended write | No | Approve target inspection |
| `generate_playwright_repro` | None | Writes under `.qmax-mcp/repros` | No | Approve file creation or explicit overwrite |
| `run_playwright_test` | May be requested by supplied test code | Writes controlled run artifacts | Yes | Require `executionAcknowledged: true` after code-execution approval |

The MCP-standard `readOnlyHint`, `destructiveHint`, `idempotentHint`, and
`openWorldHint` values are locked by a protocol-level tool-list test using two
independent client fixtures. This is a compatibility check; it does not claim
that a particular client will always render a specific UI.

## Generated repro output

`generate_playwright_repro` writes only beneath the active workspace:
`.qmax-mcp/repros`. Pass a relative `outputPath`; absolute paths, traversal,
and symlink escapes are rejected. Existing files are preserved unless the call
sets `overwrite: true` deliberately.

```json
{
  "url": "https://example.com",
  "goal": "capture the login regression",
  "outputPath": "login/repro.spec.ts"
}
```

The result returns `.qmax-mcp/repros/login/repro.spec.ts`, never an unrelated
host path. Generated repros are durable workspace artifacts; remove the
`.qmax-mcp/repros` directory when they are no longer needed.

## Local test execution

`run_playwright_test` starts the test process with a minimal environment:
`PATH`, a temporary-directory setting, the runner's Playwright dependency
path, `BASE_URL` from the request, and a runner marker. It does not inherit the
parent process environment. A caller may deliberately add non-sensitive values
with `allowedEnv`; reserved process-control variables cannot be replaced.
Every call must also include `executionAcknowledged: true`; this makes the
execution consent visible in the request rather than relying on a tool name.

The runner has an independent wall-clock limit (`wallClockTimeoutMs`) and
terminates its process group on timeout or MCP request cancellation. It keeps
test reports under `.qmax-mcp/runs`; remove that directory after inspecting
artifacts. Returned paths are workspace-relative. Raw stdout and stderr stay in
the local artifact directory and are deliberately withheld from the MCP
response, because supplied test code can print arbitrary secret formats. The
response provides only a content-free indicator and numeric Playwright counts.

## URL network policy

`scan_url` and `inspect_page` default-deny loopback, private, carrier-grade
NAT, link-local, metadata, multicast, unspecified, benchmark, and documentation
address ranges. Set `allowPrivateNetwork: true` only for deliberate local
development testing; it permits only an exact `localhost` or loopback-literal origin (for example,
`http://127.0.0.1:3000`), never RFC1918/ULA, link-local, or metadata
destinations.
The same policy validates the initial target, DNS answers at request time,
browser HTTP and WebSocket subrequests, checked links, and every followed
redirect. Browser DNS resolution is still performed by the browser after the
route check, so a hostile resolver can race that handoff; repeated request-time
validation narrows but cannot eliminate this runtime-level DNS rebinding residual
risk. This residual is a launch-review item, not an assurance that browser
connections are address-pinned.
