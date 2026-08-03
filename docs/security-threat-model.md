# qmax-mcp public local/hosted trust boundary

Status: **launch-blocking design record** for [QUA-1726](https://linear.app/quality-max/issue/QUA-1726/p0-threat-model-qmax-mcps-public-localhosted-trust-boundary). This document records the current baseline, the required controls, their owners, and the evidence required before distribution. It is not a claim that the required controls have shipped.

The public local package must remain useful without an account. Hosted QualityMax is available only when a user explicitly starts `qmax-mcp proxy` for a capability that requires the hosted service. Local tools must never quietly turn into telemetry, cloud upload, or a credential broker.

## Security objectives

1. An MCP prompt, page, or generated test cannot turn the local agent host into an unconstrained execution or network pivot.
2. Credentials, cookies, private configuration, and customer data do not enter tool output, artifacts, logs, or the child-test environment by default.
3. Local/private target access is possible only through a narrow, per-call consent mechanism; cloud metadata and link-local targets are never permitted.
4. Generated files and test artifacts stay in an approved output area and cannot escape through traversal, symlinks, or implicit overwrite.
5. A hosted request is explicit, authenticated, endpoint-pinned, and truthful about the data it sends. No local tool promotes or contacts the hosted service on its own.
6. A published package, registry record, and release provenance all identify the reviewed source artifact.

## Scope, assets, and trust boundaries

The assets requiring protection are the developer's process environment; local filesystem and source tree; browser profile, page content, cookies, and network reachability; generated tests and artifacts; the hosted API token; MCP request/response streams; and npm/registry package identity.

```text
Untrusted MCP client / prompt
          │ stdio JSON-RPC
          ▼
  ┌─────────────────────────────── local qmax-mcp process ───────────────────────────────┐
  │                                                                                       │
  │ scan_url / inspect_page ──► Playwright browser ──► public web, links, redirects       │
  │ generate_playwright_repro ─► approved output root only                                │
  │ run_playwright_test ───────► isolated, bounded child process                          │
  │                                                                                       │
  │ Explicit `proxy` only ─────► authenticated, pinned QualityMax MCP endpoint            │
  └───────────────────────────────────────────────────────────────────────────────────────┘
          │ tool result / CLI report                         │ explicit authenticated call
          ▼                                                  ▼
  Agent-visible output and local artifacts          Hosted QualityMax service
```

Crossing any arrow changes the security posture. Input schemas are validation, not authorization: supplied URLs, test code, paths, page-derived links, and proxy responses remain untrusted at every boundary.

## Pre-remediation baseline review

The following source review is retained from commit `5b34d7be383a07237a3a40a8477f0029d317e570` for threat traceability. The control matrix below records the current required dispositions and regressions.

| Surface | Current data flow and behavior | Required disposition before release |
| --- | --- | --- |
| `scan_url` | Opens caller URL in Playwright, observes page/console/network data, then follows up to 50 page-derived links with `fetch`. `validateHttpUrl` checks only scheme, while link fetches follow redirects. | Network policy must validate originals, redirects, resolved addresses, and page-derived links; output must be redacted and bounded. |
| `inspect_page` | Opens caller URL and returns DOM, form, locator, accessibility, and page URL data to the agent. | Apply the same target/redirect policy and prevent sensitive page-derived values from being returned unintentionally. |
| `generate_playwright_repro` | Builds deterministic code and writes to a temp file by default, but directly creates and writes any supplied `outputPath`. | Confine writes to an explicit output root; reject traversal, absolute escape, symlink escape, and silent overwrite. |
| `run_playwright_test` | Accepts local test path or inline supplied code, then launches `npx playwright test`. The child environment is composed with `process.env`; no process-level timeout/kill tree is installed. | Treat supplied code as hostile: minimal environment allowlist, explicit opt-in variables, bounded resource/time/cancellation policy, and redacted output. |
| `proxy` | Runs only when explicitly invoked with an API key and forwards stdio JSON-RPC to the single pinned `https://app.qualitymax.io/api/mcp` endpoint. Redirects are disabled. | Retain the endpoint/redirect regression and verify response/error handling against the release candidate. |
| `--clients` CLI output | Passes `QUALITYMAX_API_KEY` into a copy-paste hosted-proxy configuration and prints that configuration to stdout. This is a current credential disclosure path, even though the command itself makes no hosted request. | Never render an environment-sourced key; emit a literal placeholder and explain secure configuration instead. Add a regression test before release. |

Source references: [`validateHttpUrl`](../src/tools/common.ts#L45-L51), browser navigation and its subresource-capable page ([`common.ts`](../src/tools/common.ts#L59-L76)), link requests ([`scan-url.ts`](../src/tools/scan-url.ts#L70-L75)), caller-selected output ([`generate-playwright-repro.ts`](../src/tools/generate-playwright-repro.ts#L11-L21)), child environment ([`run-playwright-test.ts`](../src/tools/run-playwright-test.ts#L81-L100)), the hosted bearer request ([`proxy.ts`](../src/proxy.ts#L31-L51)), and the `--clients` stdout configuration ([`index.ts`](../src/index.ts#L20-L23), [`clients.ts`](../src/clients.ts#L4-L5), [`clients.ts`](../src/clients.ts#L60-L66)).

## Abuse-case control and regression matrix

`Blocking gates` lists the distribution action that cannot proceed until the test passes and the control is reviewed: **V** = repository visibility, **N** = npm publication, **R** = MCP Registry/directory submission. All proposed test IDs are mandatory regression evidence, not present-day passing tests; their owner ticket must add them to the repository test suite.

| ID | Abuse case | Preventative / detective control | Required regression evidence | Owner | Blocking gates | Residual risk after control |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Prompt/page induces arbitrary local code execution. | `run_playwright_test` is explicitly dangerous and requires an accepted MCP form elicitation showing the exact test digest and effects. It snapshots the approved direct source, runs in a bounded child process, and has process-group cleanup. Tool annotation discloses execution. | `test/generated-output-and-tools.test.cjs`: unsupported/declined clients do not launch; accepted approval produces a digest-bound record; cancellation kills descendants. | QUA-1730 | V, N, R | Consent is protocol-verifiable, not user-identity attestation; it depends on a client that faithfully presents elicitation to a human. User-approved code still has the operating-system permissions of the local user. |
| T2 | Inline/test-file code reads or exfiltrates inherited credentials. | Start child environment from a documented minimal allowlist; never merge parent environment. Explicit per-call allowlisted variables are non-secret by policy. | `test/generated-output-and-tools.test.cjs`: sentinel parent variable absent; explicit non-sensitive value is present; no returned token-shaped value. | QUA-1727 | V, N, R | Code can access credentials deliberately placed in its allowed environment; users must not opt in secrets. |
| T3 | Tool output, child stderr, `--clients`, or proxy errors disclose a secret. | Never echo runner environment; retain raw runner streams only as local artifacts and return content-free stream indicators plus numeric counts; `--clients` always renders a literal placeholder instead of an environment-sourced key. Broader page/proxy output redaction remains a release gate. | `test/generated-output-and-tools.test.cjs`: seeded token-shaped runner output is withheld and `--clients` renders a placeholder. | QUA-1727 | V, N, R | Page/proxy data is out of the runner response boundary and needs its own release-gate coverage. |
| T4 | Public target redirects or links into loopback, RFC1918, CGNAT, multicast, unspecified, IPv6 local, link-local, or cloud metadata space. | Default-deny special/private ranges; metadata, link-local, RFC1918, and ULA always denied; per-call consent permits only an exact `localhost` or loopback-literal origin and port; validate initial URL, every redirect, every browser HTTP/WebSocket request, and every discovered link; disable Service Workers so browser routing covers subrequests. | `test/generated-output-and-tools.test.cjs`: IPv4/IPv6 aliases, metadata endpoints, opt-in RFC1918/ULA denial, redirect chain, browser HTTP/WebSocket subrequests, and page links are denied; an explicit loopback target succeeds only under consent; browser contexts block Service Workers. | QUA-1728 | V, N, R | A user who expressly consents to a local target accepts that target's local exposure. |
| T5 | DNS changes after validation (rebinding). | Resolve immediately before each request and reject a target if any answer is disallowed; repeat validation for redirects and browser requests. The browser/host resolver can still re-resolve between this check and connection, so deployment must preserve the documented DNS-rebinding residual risk. | `test/generated-output-and-tools.test.cjs`: injected resolver returns both public and private answers; request is refused without address details. | QUA-1728 | V, N, R | Browser and host resolver behavior can differ after preflight validation; supported resolver behavior must be documented and retested. |
| T6 | Generated path traverses outside approved output or follows a symlink; an existing file is overwritten. | Canonicalize output root and candidate path; reject absolute/traversal/symlink escape; create new files atomically; require explicit overwrite confirmation. | `test/generated-output-and-tools.test.cjs`: traversal, absolute path, symlink, collision, and approved nested path cases. | QUA-1729 | V, N, R | Files inside the explicit approved root remain user-controlled data. |
| T7 | Child Playwright process hangs, forks, or survives cancellation. | Enforce wall-clock deadline below tool limit; run in a process group/job; terminate then forcibly reap descendants; bound stdout/stderr and artifacts. | `test/generated-output-and-tools.test.cjs`: hanging process and spawned descendant are gone after timeout/cancel; response is bounded. | QUA-1727 | V, N, R | OS-specific process-tree semantics require macOS/Linux/Windows coverage before broad support claims. |
| T8 | npm or registry metadata points at an untrusted artifact. | Protected release workflow with provenance, exact tag/commit mapping, package-content review, registry metadata verification, and clean-room install checks. | `release/package-provenance.test.ts` plus CI attestation verification and `npm pack --json` content allowlist. | QUA-1731, QUA-1732, QUA-1736 | V, N, R | Compromise of an approved publisher or registry remains a supply-chain risk; provenance enables detection and revocation. |
| T9 | Local telemetry or cloud calls occur without consent. | The four local tools contain no hosted call path. Only an explicitly invoked hosted configuration may use a credential; `--clients` must not expose one. Any future measurement is off by default, documented, minimized, and separately consented. | `security/no-implicit-egress.test.ts`: all four local tools operate with hosted endpoint interceptor unused; telemetry opt-in tests cover each event. | QUA-1742 | V, N, R | User-initiated target scanning necessarily contacts the supplied target and its page resources. |
| T10 | Hosted escalation is advertising rather than a requested capability. | Do not invoke or suggest a hosted call in local tool execution; expose proxy only through explicit configuration/command and describe its data boundary. | `security/explicit-hosted-escalation.test.ts`: local tool responses contain no hosted request/credential requirement; proxy fails closed without explicit credentials. | QUA-1741 | V, N, R | Documentation can become stale; release review must re-check client instructions and tool descriptions. |

## Tool-by-tool data and consent contract

| Tool / command | Reads | Writes / executes | Network | Consent and release requirement |
| --- | --- | --- | --- | --- |
| `scan_url` | Caller URL, page DOM, console/network events, response headers, selected links | Optional screenshot/artifact | Supplied public URL plus page resources and checked links | Must declare network access; special-network policy applies to all navigation and links. |
| `inspect_page` | Caller URL, DOM/accessibility/forms/locators | None intended | Supplied public URL plus page resources | Must declare network access; results are treated as untrusted page data and redacted/bounded. |
| `generate_playwright_repro` | URL, goal, finding, requested path | Generates a `.spec.ts` file | None | Must declare filesystem write; output-root and overwrite consent are mandatory. |
| `run_playwright_test` | Test path or inline code and explicitly allowlisted variables | Executes code; creates config/artifacts | Test-directed navigation runs with the local user's network permissions | Must declare code execution, filesystem write, and network; an accepted MCP form elicitation bound to the exact digest is mandatory. |
| `proxy` | JSON-RPC request and explicit API key | Writes MCP response to stdout | Pinned QualityMax endpoint only | Must declare authenticated network forwarding; never starts from local tools and never logs the key. |

The MCP annotations required by QUA-1729 must be checked against this table. Generic prose such as “local QA” cannot hide network, filesystem, authentication, or code-execution side effects.

## Public-distribution checklist

This checklist is intentionally conservative. It is the repository-side checklist linked from the epic and must be reviewed again by QUA-1730 for the exact release-candidate commit.

- [x] QUA-1726 threat model and control/test matrix reviewed against the current five surfaces.
- [ ] QUA-1727 environment isolation, output redaction, explicit execution consent, and child-process lifecycle controls merged with regression evidence.
- [ ] QUA-1728 network policy protects initial URLs, redirects, page resources, and links, including DNS rebinding tests.
- [ ] QUA-1729 output-root protections and accurate MCP safety annotations merged with regression evidence.
- [ ] QUA-1731 independent secret/history/content review, license/security policy, CI, and release provenance are verified.
- [ ] QUA-1732 package/registry contract is validated against the packed artifact.
- [ ] QUA-1730 security review gives an explicit GO for the exact candidate commit.
- [ ] Before any publication action: exact candidate commit, package contents, provenance, test results, and rollback owner are recorded in Linear.

Failure of any unchecked security gate blocks repository visibility, npm publication, and registry/directory submission. QUA-1726 itself authorizes none of those actions.

## Review cadence and ownership

Security owner for the release decision is the QUA-1730 reviewer, not the documentation author. Each control owner above must attach its test evidence to its Linear issue. The release owner must re-run this checklist against the candidate SHA, record exceptions with concrete evidence, and stop on any unknown high/critical security finding.

To report a vulnerability before the repository’s responsible-disclosure policy is added by QUA-1731, use the existing private QualityMax security contact rather than an issue tracker. Do not include secrets, credentials, or customer data in reports, test fixtures, or Linear evidence.
