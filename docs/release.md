# Release runbook

This repository remains private until the security-go ticket explicitly approves
the exact candidate commit. This runbook does not authorize publication,
registry submission, or a repository visibility change.

1. Start from a clean, reviewed candidate commit and record its SHA in Linear.
2. Synchronize public metadata atomically:

   ```bash
   npm run version:sync -- <semver>
   npm run version:sync -- --check
   npm run check
   npm run registry:preview
   ```

3. Build the package, run `npm pack --json --ignore-scripts`, and review the
   resulting file allowlist. Install that tarball in clean Node 22.13 and 24
   environments; `qmax-mcp --help` must start successfully in each.
4. Review dependency changes, the SPDX license field and `LICENSE`,
   `SECURITY.md`, `server.json`, Smithery metadata, and the registry preview.
5. Create a protected, immutable annotated tag named `v<package-version>` for
   the recorded candidate SHA. Dispatch the release workflow **from that tag**,
   with `release_tag` set to the same tag. The `npm-publish` environment only
   accepts `v*` tag runs. The workflow rejects a ref/input mismatch and tags
   whose commit is not reachable from `main`; it then resolves the tag once,
   verifies the package version, and uses the resulting SHA in every job. It
   uses npm trusted publishing with provenance; it does not use a long-lived
   npm token.
6. Record the package version, SHA, provenance link, registry metadata, test
   results, rollback owner, and all evidence URLs in the Linear ticket.

## Rollback

If a published version needs to be withdrawn, stop further publication, record
the affected version and reason in Linear, deprecate only that npm version with
an upgrade message, and publish a tested patched version after a new security
review. Never overwrite an existing npm version. If registry metadata is wrong,
correct it through the registry workflow and preserve the incident evidence.
