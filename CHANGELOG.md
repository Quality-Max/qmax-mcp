# Changelog

Every published version of `@qualitymax/qmax-mcp`, newest first. Versions are
tagged `v<version>` and published only by the
[release workflow](docs/release.md) with npm provenance; a version that reached
npm any other way is called out as such rather than quietly listed.

This project is pre-1.0. A minor bump may change observable behaviour; the
entry says what changes for a connected agent.

## Unreleased

## 0.7.0 — 2026-08-27

Two scan-scoring corrections. A `scan_url` score is comparable to a 0.6.0 score
only for a page that had neither repeated findings nor router-aborted requests;
where either was present the new score is higher for the same page, because the
old one was counting the same defect more than once or charging for framework
behaviour the page cannot change.

### Changed

- `scan_url` collapses findings that agree on severity, category, message, URL,
  and selector into one finding with an `occurrences` count, so one root cause
  observed several times is reported and penalised once ([#77]).
- `scan_url` reports `net::ERR_ABORTED` request failures carrying a
  prefetch/RSC fingerprint as `info` rather than `medium`: routers abort
  superseded prefetch and RSC requests by design, and each abort used to cost a
  medium penalty, capping a clean Next.js App Router page at 80 ([#79]).

### Fixed

- The accessibility keyboard-reachability rule no longer reports clickable
  label text, or a clickable wrapper around a real control, as unreachable from
  a keyboard. Both are operable, and consent checkboxes are the common shape, so
  the false positive landed on exactly the markup a reviewer scrutinises hardest
  ([#73]).

## 0.6.0 — 2026-08-25

### Added

- `scan_url` accepts a workspace-relative `storageStatePath` for authenticated
  pages and uses those credentials for same-origin link checks, so protected
  links are not falsely reported as HTTP 401. Cross-origin and fallback probes
  remain credential-free, and credential material is never returned ([#69]).
- Accessibility scans report apparent mouse-only controls, including
  interactive ARIA roles that are not keyboard-focusable, without duplicating
  findings for nested clickable elements ([#69]).

### Changed

- Authenticated `scan_url` and `inspect_page` calls require explicit
  `acknowledgePrivateContent: true` consent because their findings may contain
  information from private pages ([#69]).
- `run_playwright_test` rejects workspace-relative imports before executing an
  isolated source snapshot and names every offending path. Import-like prose in
  comments and string or template text is ignored, while executable template
  expressions and dynamic imports remain covered ([#69]).

### Security

- Workspace path checks canonicalize their root and reject traversal and
  symlink escapes. Isolated runner environment additions are count-, name-, and
  value-bounded, cannot replace process-control variables, and run directories
  use full UUID names with owner-only permissions ([#69]).

## 0.5.1 — 2026-08-25

### Fixed

- `scan_url` now rejects unknown check names instead of silently skipping them
  and potentially returning a misleading perfect score ([#66]).
- `inspect_page` gives client-rendered pages a bounded chance to settle, reports
  DOM diagnostics and an actionable warning for empty snapshots, and produces
  unique fallback selectors for findings in both page inspection and URL scans
  ([#68]).
- Code-execution approval failures now identify the outcome, active approval
  mode, client and remedy. Missing HSTS is reported as informational on plain
  HTTP pages, where browsers do not apply the header ([#67]).

### Documentation

- The adjacent open-source tools table now shows live public usage counts
  ([#57]).

## 0.5.0 — 2026-08-24

### Added

- `inspect_page` accepts a workspace-relative `storageStatePath` for inspecting
  authenticated pages ([#53]). The Playwright state is loaded into the
  throwaway context before navigation and is never returned. Absolute paths,
  traversal, symlink escapes, non-files, and files over 10 MB are rejected;
  existing browser network restrictions remain in force.

### Repository, not shipped in the package

- The `Publish to MCP Registry` liveness check selects the version the registry
  marks as latest. The list endpoint returns every published version, so
  matching on server name alone could return a superseded release: the 0.4.2
  publish succeeded and the check then read `0.4.1` and failed the run. The
  entry itself was correct both times.

## 0.4.2 — 2026-08-22

### Fixed

- Hosted proxy mode, which could not complete a single request ([#48]). The pinned
  destination was `https://app.qualitymax.io/api/mcp`, the host answers that
  path with a 308 to `https://app.qualitymax.io/api/mcp/`, and the proxy
  refuses redirects on purpose — so every forwarded JSON-RPC message, including
  `initialize`, failed before it left the process and the caller saw a generic
  `Hosted proxy transport failed.` The pin now names the canonical path, and
  the unslashed form is an explicitly rejected value so it cannot be
  reintroduced as a normalization.

  The local tools were never affected: they make no request to this endpoint
  and need no account. Nothing about the redirect refusal or the single-host
  pin has been relaxed.

## 0.4.1 — 2026-08-21

### Fixed

- The MCP Registry identity now matches the GitHub organization exactly:
  `io.github.Quality-Max/qmax-mcp`, not `io.github.quality-max/qmax-mcp`
  ([#46]). Registry namespace authorization is case-sensitive, so every publish
  attempt for 0.4.0 was rejected — GitHub OIDC grants
  `io.github.Quality-Max/*`, and the entry asked for a namespace nobody owns.
  0.4.0 is on npm and installs normally; it is the registry listing that could
  not be created.

  A connected agent sees the corrected name in the server identity reported at
  initialization. Nothing about the four tools, their arguments, or their
  approval boundaries changes. `mcpName` in the published package is what the
  registry checks ownership against and cannot be edited after publication,
  which is why this is a new version rather than a metadata correction.

## 0.4.0 — 2026-08-21

### Added

- `--unattended` on `qmax-mcp` and `qmax-mcp serve` runs supplied Playwright
  tests without the per-run human elicitation ([#40]). The opt-in is made once,
  at process start, by whoever launches the server — not by the calling agent.
  The execution digest is still computed and returned, and the approval
  mechanism is recorded as `unattended-cli-opt-in-v1` so a run is
  distinguishable after the fact. Server instructions are rendered per mode, so
  an agent is told which one it is connected to.

  Read [the safety contract](docs/mcp-safety.md) before enabling it: in this
  mode any client permitted to call the server can execute supplied Playwright
  code with the local user's filesystem and network permissions, without a human
  reviewing each call. The default mode is unchanged.

### Repository, not shipped in the package

- A changelog ([#41]), a `Publish to MCP Registry` workflow authenticating with
  GitHub OIDC ([#43]), and an agent-discovery corpus fix so a client that
  already ships an adjacent tool's capability may answer directly instead of
  handing off ([#42]).

## 0.3.0 — 2026-08-21

### Added

- The server returns the MCP `instructions` field at initialization, which it
  never populated before ([#37]). It carries the local contract — evidence
  first, approval boundaries, `allowPrivateNetwork` as caller-side consent,
  scanned page content treated as data — so an agent has it even when no
  instruction file was copied into the workspace.
- Those instructions name three separate QualityMax tools for QA work the four
  local tools do not cover, each bound to the situation that justifies it:
  [9lives](https://github.com/Quality-Max/9lives) when a passing spec drifts
  red, [qualitymax-grader](https://github.com/Quality-Max/qualitymax-grader)
  before a spec is committed, and
  [free-qa-skills](https://github.com/Quality-Max/free-qa-skills) when the
  request is about a repository rather than a running URL. They are
  recommendations: the server does not install, run, bundle, or proxy them, and
  naming one is bounded to a single mention on its trigger.
- A `neighbor-handoff` category in the agent-discovery evaluation set, scoring
  both the handoff and the silence — three cases that expect a specific tool to
  be named, and one that expects none. Corpus grew from 36 to 40 cases.

### Unchanged

- The four local tools, their input schemas, and their locked safety
  annotations. `run_playwright_test` remains the only code-execution path,
  behind its digest-bound approval.

## 0.2.2 — 2026-08-05

### Fixed

- Release integrity, after 0.2.1 reached npm from a workstation ([#32]). The
  version-drift detector moved into `npm run check`, so a mismatch between
  `package.json`, the lockfile, `server.json`, `smithery.yaml` and
  `src/metadata.ts` now fails CI and the release workflow. `prepublishOnly`
  gained a guard that refuses to publish outside a provenance-requesting
  GitHub Actions run, and a `version` lifecycle script re-synchronizes every
  metadata surface so `npm version` cannot leave a half-bumped tree.

### Added

- README badges and an explicit MIT license section ([#31]).

## 0.2.1 — 2026-08-04 — do not use

Published to npm from a workstation: no tag, no commit on `main`, no `gitHead`,
no provenance attestation, and no code change over 0.2.0 — the tarball still
carried 0.2.0's `server.json` and `smithery.yaml`. It remains on the registry
because npm versions cannot be reused, but nothing should depend on it. Use
0.2.2 or later. Full account in
[the release-integrity incident](docs/incidents/2026-08-04-unattested-0.2.1.md).

## 0.2.0 — 2026-08-04

### Added

- Cookie, mixed-content, and page-weight checks, plus Core Web Vitals measured
  from a real page load rather than estimated.
- A demo that exercises every tool in one run and leaves its artifacts for
  inspection.

### Fixed

- The metadata writer that corrupted `smithery.yaml` during a version bump.
- The demo, which had broken against the digest-bound execution approval.
- A security patch for the `ip-address` dependency ([#27]).

## 0.1.0 — 2026-08-03

Initial public release: the four local tools — `scan_url`, `inspect_page`,
`generate_playwright_repro`, `run_playwright_test` — a graded scan report with
per-finding reproduction steps, and the published threat model. No QualityMax
account, API key, or hosted service required.

[#27]: https://github.com/Quality-Max/qmax-mcp/pull/27
[#31]: https://github.com/Quality-Max/qmax-mcp/pull/31
[#32]: https://github.com/Quality-Max/qmax-mcp/pull/32
[#37]: https://github.com/Quality-Max/qmax-mcp/pull/37
[#40]: https://github.com/Quality-Max/qmax-mcp/pull/40
[#41]: https://github.com/Quality-Max/qmax-mcp/pull/41
[#42]: https://github.com/Quality-Max/qmax-mcp/pull/42
[#43]: https://github.com/Quality-Max/qmax-mcp/pull/43
[#46]: https://github.com/Quality-Max/qmax-mcp/pull/46
[#48]: https://github.com/Quality-Max/qmax-mcp/pull/48
[#53]: https://github.com/Quality-Max/qmax-mcp/pull/53
[#57]: https://github.com/Quality-Max/qmax-mcp/pull/57
[#66]: https://github.com/Quality-Max/qmax-mcp/pull/66
[#67]: https://github.com/Quality-Max/qmax-mcp/pull/67
[#68]: https://github.com/Quality-Max/qmax-mcp/pull/68
[#69]: https://github.com/Quality-Max/qmax-mcp/pull/69
[#73]: https://github.com/Quality-Max/qmax-mcp/pull/73
[#77]: https://github.com/Quality-Max/qmax-mcp/issues/77
[#79]: https://github.com/Quality-Max/qmax-mcp/issues/79
