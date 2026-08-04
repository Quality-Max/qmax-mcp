# MCP safety contract

MCP annotations are machine-readable hints, so clients still need to present
their own approval UI. qmax-mcp therefore makes the action boundary explicit in
both the annotation flags and every tool description.

| Tool | Network | Local filesystem | Local code execution | Approval boundary |
| --- | --- | --- | --- | --- |
| `scan_url` | Outbound browser and HTTP requests | Optional screenshot artifact | No | Approve a networked scan / artifact write |
| `scan_url` (cookie check) | Reads the scan browser's own cookie jar | No write | No | Cookie names and flags only; values are never returned |
| `inspect_page` | Outbound browser requests | No intended write | No | Approve target inspection |
| `generate_playwright_repro` | None | Writes under `.qmax-mcp/repros` | No | Approve file creation or explicit overwrite |
| `run_playwright_test` | May be requested by supplied test code | Writes controlled run artifacts | Yes | Require an accepted MCP form elicitation for the exact execution digest |

The MCP-standard `readOnlyHint`, `destructiveHint`, `idempotentHint`, and
`openWorldHint` values are locked by a protocol-level tool-list test using two
independent client fixtures. This is a compatibility check; it does not claim
that a particular client will always render a specific UI.

## Cookie inspection

The `cookies` check reads the cookies the scanned page set in the scan's own
throwaway browser context. It never touches a real browser profile, and it
returns only each cookie's name, domain, path, and security flags.

Cookie values are dropped at the single point where a browser cookie becomes a
scan signal, so no value can reach a finding, the Markdown report, or the MCP
response. A test asserts this directly.

Tracker attribution uses a small, dated host list committed in the repository.
It labels observed requests in the output and never blocks them. The
"trackers loaded before consent" finding is a documented heuristic — a fixed or
sticky overlay naming cookies or consent with an accept/reject control — and it
returns the matched selector and text excerpt so a human can confirm it.

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
Before each call, the server issues an MCP form elicitation that states the
execution target, its code-execution/filesystem/network effects, and a SHA-256
digest of the test source plus every execution-affecting option. It runs only
when the client returns `accept` with `approved: true`; the result includes the
mechanism, digest, target, and client name as an approval record. A changed file
or option has a different digest and must be approved again. The runner executes
an approved snapshot, so changing a file after the approval screen cannot swap
the direct test source.

This is client-visible, protocol-verifiable consent—not identity attestation.
It relies on a client that faithfully presents MCP form elicitations to a human.
Clients without that capability fail closed, and qmax-mcp does not treat a tool
argument or an agent assertion as human approval.

The runner has an independent wall-clock limit (`wallClockTimeoutMs`) and
terminates its process group on timeout or MCP request cancellation. It keeps
test reports under `.qmax-mcp/runs`; remove that directory after inspecting
artifacts. Returned paths are workspace-relative. Raw stdout and stderr stay in
the local artifact directory and are deliberately withheld from the MCP
response, because supplied test code can print arbitrary secret formats. The
response provides only a content-free indicator and numeric Playwright counts.

## Hosted proxy boundary

`qmax-mcp proxy` is the only hosted path. It always sends its bearer credential
to `https://app.qualitymax.io/api/mcp`; it has no endpoint flag or environment
override. HTTP redirects are rejected before a bearer can be forwarded. The
proxy returns a generic transport error rather than echoing low-level endpoint
or credential-bearing error text.

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
