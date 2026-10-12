# Release runbook

The release workflow is the only supported way to publish `@qualitymax/qmax-mcp`.
A publish that does not come from it has no provenance attestation and no
`gitHead`, which breaks the chain the launch gate depends on — see
[the 0.2.1 release-integrity incident](incidents/2026-08-04-unattested-0.2.1.md).

## Enforced gates

Two steps of this runbook are now checked by machine rather than trusted to a
human reading it:

- `npm run check` runs `npm run version:sync -- --check` first, so any drift
  between `package.json`, `package-lock.json`, `server.json`, `smithery.yaml`
  and `src/metadata.ts` fails both the Quality workflow and the release
  workflow's `verify-package` and `publish` jobs.
- `prepublishOnly` runs `scripts/guard-publish.cjs`, which refuses to publish
  unless the process is a GitHub Actions run that requested `--provenance`.
- The `version` npm lifecycle script re-synchronizes and stages every metadata
  surface, so `npm version <patch|minor|major>` cannot leave a half-bumped tree.

The publish guard is a speed bump, not a lock: `npm publish --ignore-scripts`
skips it. **The lock is npm's per-package publishing setting — require a trusted
publisher, so the registry itself rejects workstation credentials.** Configure it
at npmjs.com → the package → Settings → Publishing access.

## Steps

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
   with `release_tag` set to the same tag and `publish` enabled. The
   `npm-publish` environment only accepts `v*` tag runs. The workflow rejects a
   ref/input mismatch and tags whose commit is not reachable from `main`; it
   then resolves the tag once, verifies the package version, and uses the
   resulting SHA in every job. It uses npm trusted publishing with provenance;
   it does not use a long-lived npm token.

   One run publishes every surface, in order, each job only after the one
   before it succeeded:

   1. **npm**, with provenance.
   2. **Publish to MCP Registry**, called as a reusable workflow. It waits
      until `npm view` reports the exact version and a `mcpName` matching
      `server.json`, repeats the immutable-tag gate and the metadata and schema
      checks, publishes with GitHub OIDC (there is no registry token in this
      repository), and confirms the live entry.
   3. **GitHub Release**, created with
      `gh release create v<package-version> --verify-tag` and notes generated
      by `node scripts/release-notes.cjs <version>` from the version's
      CHANGELOG entry, plus an `npx -y @qualitymax/qmax-mcp@<version>` install
      line and a link to the CHANGELOG anchor at that tag. Preview them before
      tagging. A release that already exists is left untouched.

6. If the registry job fails after npm published, fix the cause and dispatch
   **Publish to MCP Registry** alone, with `release_tag` set to the tag (from
   the tag, or from `main` when the fix is to the workflow itself). It is safe
   to re-run: a version the registry already has is not published again, only
   confirmed. Then create the GitHub Release by hand:

   ```bash
   node scripts/release-notes.cjs <package-version> --sha <release-sha> > notes.md
   gh release create v<package-version> --verify-tag \
     --title "qmax-mcp <package-version>" --notes-file notes.md
   ```

7. Read the published GitHub Release. Say plainly when a change makes a result
   incomparable to the previous version, so nobody reads a scoring correction
   as an improvement in their own application. The CHANGELOG entry should
   already say it; edit the release notes if they need more.
8. Record the package version, SHA, provenance link, registry metadata, test
   results, rollback owner, and all evidence URLs in the Linear ticket.

The registry entry is a pointer, not a copy: it advertises an npm version and
carries no artifact of its own. Publishing it before npm has the version
advertises something nobody can install, which is why the registry job depends
on the npm job and then waits for npm to serve the version. The GitHub Release
comes last for the same reason: its notes advertise an installable version, so
publishing them first points readers at something they cannot yet install.

`--verify-tag` is not optional. Without it `gh release create` creates a missing
tag itself, which would attach the release to whatever `main` points at instead
of to the reviewed, published commit — and a lightweight tag created that way
would not satisfy the annotated-tag gate either workflow enforces.

## Rollback

If a published version needs to be withdrawn, stop further publication, record
the affected version and reason in Linear, deprecate only that npm version with
an upgrade message, and publish a tested patched version after a new security
review. Never overwrite an existing npm version. If registry metadata is wrong,
correct it through the registry workflow and preserve the incident evidence.

npm does not allow a version number to be reused once published, even after an
unpublish, so a withdrawn version is spent: recover by releasing the next patch,
not by reissuing the same number.
