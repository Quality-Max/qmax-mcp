# Release-integrity incident: unattested 0.2.1 on npm

**Date published:** 2026-08-04T12:43:54Z
**Detected:** 2026-08-05, during the P0 launch audit
**Severity:** P0 — broke the provenance chain the public-launch gate depends on
**Code impact:** none. The published code is byte-identical to 0.2.0.

## What happened

`@qualitymax/qmax-mcp@0.2.1` became npm's `latest` without passing through the
release workflow. It was published from a workstation under the personal npm
account `qualitymax`, from a working tree where `npm version patch` had bumped
`package.json` and `package-lock.json` and nothing else.

## Evidence

From the npm registry metadata for the package:

| | 0.2.0 | 0.2.1 |
|---|---|---|
| `_npmUser` | `GitHub Actions` (trusted publisher `github`) | `qualitymax` |
| `gitHead` | `a99e681…` (on `main`) | absent |
| `dist.attestations` | SLSA provenance v1 | absent |
| Git tag | `v0.2.0` | none |
| Commit on `main` | yes | none |

The attestation endpoint for 0.2.1 returns 404. The 0.2.1 tarball's
`server.json` and `smithery.yaml` both still declare `0.2.0`, so an agent
reading the packaged MCP manifest saw a different version than the registry.

This was a release-process failure, not a code compromise: unpacking both
tarballs shows identical code, with `package.json`'s version string as the only
difference.

## Why the existing controls did not catch it

The repository already had a correct drift detector, `scripts/sync-version.cjs
--check`, and a correct release workflow that publishes only from an annotated
tag reachable from `main`, using trusted publishing with provenance.

Neither was in the path of the failure:

- **The drift detector was documentation-only.** `npm run check` was
  `lint && test && validate:registry`. `validate:registry` validates
  `server.json` against the MCP Registry schema, which says nothing about
  whether its version matches `package.json`. The only instructions to run the
  detector lived in `README.md` and `docs/release.md`, addressed to a human.
- **Nothing stopped a direct publish.** `prepublishOnly` was `npm run build`, so
  `npm publish` from a laptop worked, and the npm package accepted a personal
  credential rather than requiring the trusted publisher.

A single command — `npm version patch && npm publish` — therefore bypassed every
gate at once.

## Remediation

- 0.2.2 is released through the workflow, with all five metadata surfaces
  synchronized, an annotated `v0.2.2` tag on `main`, and npm provenance.
- 0.2.1 is deprecated on npm pointing at 0.2.2. It cannot be reissued; npm
  permanently retires a published version number.
- `npm run check` now runs the drift detector first, so both the Quality and
  release workflows fail on drift.
- `prepublishOnly` now runs `scripts/guard-publish.cjs`, which requires a
  GitHub Actions run that asked for `--provenance`.
- A `version` npm lifecycle script re-synchronizes and stages every surface, so
  the exact command that caused this — `npm version patch` — can no longer
  produce a half-bumped tree.
- `test/release-integrity.test.cjs` covers all of the above.

## Still required (npm account settings, not code)

Set the package's publishing access to **require a trusted publisher** at
npmjs.com → `@qualitymax/qmax-mcp` → Settings → Publishing access. Until that is
set, the guard remains bypassable with `npm publish --ignore-scripts`, because
the registry still accepts workstation credentials for this package.
