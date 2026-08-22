# Roadmap

Candidate work for `@qualitymax/qmax-mcp` after 0.4.0, written 2026-08-21. This
project is pre-1.0: the entries below are the shape of the work and the
boundaries it has to respect, not a delivery commitment or a dated plan. Nothing
here is announced until it ships and appears in [the changelog](../CHANGELOG.md).

## The boundary rule

Hosted QualityMax already owns projects, test cases, frameworks, scripts, stored
memory, and CI/CD setup. If the local server grows its own version of those
nouns, the result is two implementations of the same concept and a connected
agent that cannot tell which one to call.

So the split is:

- **Local is the offline substrate.** It produces durable, diffable,
  git-committable files in an open format, with no account and no egress beyond
  the target being tested.
- **Hosted is the system of record.** It stores, orchestrates, and shares what
  local produced.

Interop runs through QTML, which hosted already parses, imports, and exports.
Local artifacts should be QTML-shaped wherever a test case is involved, so a
workspace can be lifted into a hosted project without a translation layer.

## Constraints that apply to every entry

These are the existing invariants. A feature that cannot be built inside them
does not get built.

| Constraint | Why it holds |
| --- | --- |
| Tool count stays at or below eight | The [agent-discovery corpus](../evals/agent-discovery/v1) measures tool selection. Every added tool competes with the four that already work. Prefer new parameters, MCP resources, and CLI subcommands over new tools. |
| Every added capability ships with eval cases | A 40-case corpus that does not grow with the tool surface silently stops describing the server. |
| Writes stay under `.qmax-mcp/` | Workspace containment is load-bearing, not stylistic. Anything that must write outside it plans first and applies behind an explicit, digest-bound approval. |
| Secrets never enter an artifact | Cookie values are already dropped where a browser cookie becomes a scan signal. Any new artifact type — memory, HAR, captured webhook — inherits that rule. |
| New persistence gets a threat-model row | See [the security threat model](security-threat-model.md). Stored data that re-enters agent context is a new attack surface, not a new convenience. |

## Tier 1

### 1. CI gating primitives on the CLI

The gap is concrete: `qmax-mcp scan` always exits 0, so it cannot gate anything.
An agent is not present in a pipeline; the CLI is the pipeline surface, and it
currently has no way to fail.

- Exit codes as a documented contract: `0` clean, `1` findings at or above the
  configured threshold, `2` tool error.
- `--fail-on <severity>`, `--budget-file <path>`, `--baseline <dir>`,
  `--fail-on-regression`.
- `--format sarif` for GitHub code-scanning annotations on the changed lines,
  and `--format junit` for the reporters every CI system already understands.
  The Markdown renderer already exists; documenting how to write it to
  `$GITHUB_STEP_SUMMARY` is the cheapest visible improvement on this list.
- CLI parity with parameters the MCP tools already accept and CI needs:
  `--allow-private-network` for a service started inside the job, `--viewport`,
  and the weight budget.
- `examples/ci/` with copy-paste GitHub Actions, GitLab, and CircleCI files
  covering deploy-preview URL wiring, browser caching keyed on the Playwright
  version, and concurrency groups.
- A stated posture on `--unattended`: CI is the isolated-automation case the
  flag exists for, and a developer's editor configuration is not.

### 2. Evidence memory

A single scan cannot say that something got worse. Baselines are what turn a
one-shot grade into a regression signal, and a regression signal is what makes a
quality gate adoptable on a site that would never pass an absolute threshold.

Stored under `.qmax-mcp/memory/`, in files a human can read and review:

| File | Holds |
| --- | --- |
| `baselines/<host>/<route-hash>.json` | Last grade, Core Web Vitals, page-weight breakdown, finding fingerprints |
| `locators/<host>/<route-hash>.json` | Role and name locators confirmed by `inspect_page`, so generated repros stop guessing selectors |
| `suppressions.json` | Accepted findings, each with a reason and a required expiry date |

`scan_url` gains a `baseline` mode returning a `delta` block: new findings, fixed
findings, and metric movement. Reads are exposed as MCP resources rather than
tools; mutation goes through one tool with an action enum.

Two honest limits. Vitals still come from one cold load on the scanning machine,
so a delta across machines is not a field-data comparison and must not be
presented as one. And memory is a cross-session prompt-injection surface: page
content flows into a baseline and back into agent context in a later session, so
stored text is capped, labelled as data, and stripped of query strings and
cookie values, with a threat-model row of its own.

### 3. Mocks — HAR replay and fault injection

Playwright already provides `recordHar` and `routeFromHAR`, so the mechanism is
mostly wiring:

- `scan_url` records to `.qmax-mcp/har/<id>.har`.
- `run_playwright_test` replays it, which makes a repro deterministic and
  offline — it still reproduces after the live site has changed.

Redaction is on by default and not optional in CI guidance: `Cookie`,
`Set-Cookie`, `Authorization`, and API-key headers are stripped, and bodies are
kept only for allowlisted content types. A HAR is a secret-bearing artifact.
`.qmax-mcp/` is gitignored in this repository but will not be in a consumer's,
so the documentation has to say so plainly.

The differentiated half is declarative fault injection —
`mocks: [{ url, status: 500, delayMs: 3000 }]` — and a re-scan that reports what
the UI actually does when a dependency fails: infinite spinner, blank region,
unhandled rejection, no error message. Empty, error, and loading states are
invisible to a happy-path scan by construction.

## Tier 2

### 4. Webhook capture

An ephemeral receiver bound to loopback that records what the application under
test sends, so an agent can assert on a callback instead of guessing.
Loopback-only binding, a TTL, a size cap, and `Authorization` stripped at record
time. This is capture, not delivery — see below.

### 5. Scaffold generation

Deterministic templates for a Playwright project: config, fixtures, a page-object
base, a sample spec, a CI workflow, `.gitignore`. Because this writes outside
`.qmax-mcp/`, it plans by default — returning the file list and the diffs — and
applies only behind the same digest-bound approval that guards test execution.
An adopt mode patches an existing configuration instead of overwriting it.

## Deliberately not building

**Outbound webhooks to a caller-supplied URL.** This process sends a bearer token
to exactly one pinned host and refuses redirects; that pinning is a stated
security property, not an implementation detail. A tool that posts a report to
an arbitrary URL taken from a tool argument converts an injected page into an
exfiltration channel: scanned content lands in the report, and the agent is
talked into sending it somewhere.

If a delivery path is ever needed, it takes the destination from an on-disk
allowlist rather than from tool arguments, signs the payload, refuses redirects,
and references credentials by environment-variable name without echoing them.
The better default is the one that already exists: emit the quality receipt and
let CI, holding its own credentials, do the posting.

## This repository's own pipeline

Already in place: SHA-pinned actions, `npm ci --ignore-scripts`,
`persist-credentials: false`, npm provenance, and OIDC-authenticated registry
publishing. Open gaps:

- No CodeQL or equivalent SAST workflow.
- `dependency-review.yml` only covers dependency changes on a pull request, so
  there is no scheduled vulnerability sweep of the existing tree.
- No scheduled run, so an upstream Playwright or Chromium change is found by a
  user rather than by CI.
- The `demo` job drives a real browser with no `timeout-minutes` and no stated
  retry budget.

## Sequencing

CI gating and evidence memory come first, and they compound: baseline diffing is
what makes the gate usable on a real codebase, and the gate is what gives the
baseline somewhere to be enforced. Mocks and HAR replay follow. Webhook capture
and scaffolding come after that.
