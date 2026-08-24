# Distribution channel inventory

Where `@qualitymax/qmax-mcp` is listed, where it deliberately is not, and what
each channel actually accepts. Verified 2026-08-23 against the live services;
every row says how it was checked so a stale claim is visible rather than
inherited.

This covers the **local stdio server** only. Hosted QualityMax is a different
product with a different transport and auth model; see
[the hosted note](#hosted-connectors-are-a-different-product) below.

## Status

| Channel | Accepts a local stdio server? | Status | Evidence |
| --- | --- | --- | --- |
| [Official MCP Registry](https://registry.modelcontextprotocol.io) | Yes, npm package metadata | **Listed** | `io.github.Quality-Max/qmax-mcp` @ 0.4.2, `status: active`, `isLatest: true` |
| npm | Yes | **Published** | 0.4.2 with provenance attestation, `latest` tag |
| Smithery | Only as an `.mcpb` bundle | **Deferred, deliberately** | See [the decision](#smithery-deferred) |
| GitHub MCP Registry / VS Code gallery | Yes — but onboarding is manual curation | **Not listed; prerequisites met, request not yet sent** | `github.com/mcp/quality-max/qmax-mcp` → 404 |
| cursor.directory | Reported yes | **Not listed, needs verification** | Probe returned 429; not confirmed |
| Claude Connectors Directory | No — hosted remote connectors only | **Out of scope here** | Tracked in the hosted epic |
| Claude Code / Codex | No directory exists | **N/A** | Configured per-project; fixtures ship in `examples/agent-setup/` |

## Channel notes

### Official MCP Registry — done

The one that matters for agent discovery. Publication is automated by the
`Publish to MCP Registry` workflow, authenticating with GitHub OIDC, dispatched
from the release tag after npm has the version. The registry stores metadata
only and points at the npm package.

Two things learned the hard way and worth not relearning: namespace
authorization is **case-sensitive** and must match the GitHub organization
exactly (`io.github.Quality-Max/…`), and the registry validates ownership
against `mcpName` inside the published tarball — which is immutable, so a
namespace correction requires a new version.

### GitHub MCP Registry / VS Code gallery — process established, request outstanding

`code.visualstudio.com/mcp` redirects to `github.com/mcp`, a separately curated
catalog in public preview. It is **not** fed by the official MCP Registry: our
entry is live there while `github.com/mcp/quality-max/qmax-mcp` returns 404.

The listing process, from first-party sources:

- **Onboarding a new server is manual curation.** GitHub staff, in
  [github/github-mcp-server#1257](https://github.com/github/github-mcp-server/discussions/1257):
  "right now the GitHub MCP registry is a curated list" (2025-11-10), and
  "the GitHub MCP Registry now has the ability to sync versions from the open
  source registry, but onboarding a new server is still a manual curation
  process today" (2026-05-19).
- **The request goes to `partnerships@github.com`.** From
  [GitHub's own guide](https://github.blog/ai-and-ml/generative-ai/how-to-find-install-and-manage-mcp-servers-with-the-github-mcp-registry/)
  (2025-10-24): "Once you've completed the steps above, email
  partnerships@github.com and request for your server to be included."
- **Once onboarded, versions sync automatically** from the official registry, so
  `server.json` remains the single source and no second manifest is needed.
- **Self-publication was projected for "the next couple months"** in that
  2025-10-24 post. Staff were still describing onboarding as manual in
  2026-05-19, so treat that projection as unmet rather than imminent.

**We already meet the stated prerequisites**: published to the official registry
under a GitHub-auth namespace, `io.github.Quality-Max/qmax-mcp`, live and
current. The only outstanding step is sending the request.

### cursor.directory — verify before acting

The `cursor/mcp-servers` GitHub repository is reported deprecated in favour of
`cursor.directory`, with submissions at `cursor.directory/plugins/new`. Probes
returned HTTP 429 on 2026-08-23, so neither the deprecation nor the submission
path is first-party confirmed here.

Note that `cursor.directory` appears to be community-operated rather than a
Cursor product surface. Confirm that before treating a listing there as an
official channel.

### Claude Code, Codex — nothing to submit

Neither has a directory. Both are configured per project, and copy-paste
fixtures already ship in `examples/agent-setup/`. There is no listing to chase.

## Smithery — deferred

Smithery's current publish paths are an external HTTPS URL, a hosted JS module,
or an `.mcpb` bundle for stdio servers. Only the bundle fits a local server, and
we are choosing not to build one yet:

- **It is a second distribution artifact with no provenance.** npm ships with an
  attestation; an uploaded bundle does not. After
  [the 0.2.1 release-integrity incident](incidents/2026-08-04-unattested-0.2.1.md)
  and the provenance-gated release workflow built in response, adding an
  unattested parallel artifact cuts against the grain of this project.
- **A fat bundle is not possible.** Playwright downloads Chromium after install;
  it is hundreds of megabytes and cannot ship inside a bundle. So the bundle
  degrades to a thin manifest whose command is `npx -y @qualitymax/qmax-mcp` —
  the same command users already get from npm and the MCP Registry.
- **It rots.** The bundle needs rebuilding and re-uploading every release, or the
  listing silently drifts from the published package.

**Revisit when** there is evidence of demand: the hosted connector
`qualitymax/qualitymax-mcp` is listed on Smithery, so its traffic gives a real
signal about whether Smithery users would install the local server too. If they
would, the work is a thin manifest generated and uploaded *by the release
workflow* — never by hand — so the artifact inherits the same gate as npm.

## Hosted connectors are a different product

Directories that accept only hosted remote connectors are out of scope for this
inventory. The hosted QualityMax connector is a separate listing with a separate
identity — `qualitymax/qualitymax-mcp` on Smithery, and the Claude Connectors
Directory submission — tracked in its own epic.

The naming is deliberate and should stay that way: `qmax-mcp` is the free,
account-free, four-tool local server. A hosted listing must never reuse that
name, or the two become indistinguishable to someone choosing between them.
