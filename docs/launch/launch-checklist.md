# Agent-first launch checklist

Use this checklist for the exact release commit. Do not convert a pending control into launch copy.

## Proof and release gates

- [ ] Run `npm run check` on the release commit and retain the CI URL.
- [ ] Run `npm run demo -- --format json` and retain the generated receipt plus local artifacts.
- [ ] Complete the three independent, approval-visible agent/client evaluations required by [QUA-1734](../../evals/agent-discovery/v1/RESULTS.md).
- [ ] Complete QUA-1730’s exact-release-candidate security review. The proxy must stay endpoint-pinned with redirects disabled, and code execution must use a digest-bound MCP human-approval elicitation rather than a caller assertion.
- [ ] Confirm repository-admin controls from QUA-1731: branch protection and a protected `npm-publish` environment.
- [ ] Verify the dated first-party sources in the [capability comparison](competitor-comparison.md), or update/remove affected wording.

## Announcement copy and routes

- [ ] Publish a GitHub release/README update that leads with the independent-QA promise, canonical `npx -y @qualitymax/qmax-mcp` command, no-account local mode, and safety limits.
- [ ] Post a short Hacker News Show HN announcement that includes the demo, states the local/hosted boundary, and invites technical feedback. Do not coordinate voting or repost.
- [ ] Share only where the community rules permit it (for example an MCP, Playwright, or coding-agent community); tailor the post to the community and do not cross-post repetitively.
- [ ] Route non-sensitive questions to [GitHub Issues](https://github.com/Quality-Max/qmax-mcp/issues).
- [ ] Route vulnerabilities through [SECURITY.md](../../SECURITY.md), never a public issue. Before public release, verify GitHub Private Vulnerability Reporting as that policy requires.

Suggested factual one-liner: “QualityMax QA MCP gives coding agents a local, no-account QA loop—scan, inspect, generate a focused repro, and return evidence before a web change is called done.”
