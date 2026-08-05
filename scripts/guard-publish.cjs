#!/usr/bin/env node

/**
 * Refuse any publish that is not the provenance-backed release workflow.
 *
 * 0.2.1 reached npm as `latest` from a workstation: `npm version patch` bumped package.json and the
 * lockfile, `npm publish` shipped the result under a personal npm account, and the tarball kept the
 * 0.2.0 `server.json` and `smithery.yaml`. There was no tag, no commit on `main`, no `gitHead` and
 * no attestation, so the provenance chain the launch gate depends on was broken by a release that
 * changed no code at all.
 *
 * This runs from `prepublishOnly`, which npm invokes on `npm publish` but not on `npm pack`.
 *
 * It is a speed bump, not a lock — `npm publish --ignore-scripts` skips it. The actual lock is npm's
 * per-package "require trusted publisher" setting, which rejects workstation credentials at the
 * registry. See docs/release.md.
 */

const checks = [
  {
    ok: process.env.GITHUB_ACTIONS === 'true',
    detail: 'not running in GitHub Actions (GITHUB_ACTIONS is not "true")',
  },
  {
    // npm exports `--provenance` to lifecycle scripts as npm_config_provenance.
    ok: process.env.npm_config_provenance === 'true',
    detail: 'publish was not invoked with --provenance',
  },
];

const failures = checks.filter((check) => !check.ok).map((check) => check.detail);

if (failures.length > 0) {
  console.error('Refusing to publish @qualitymax/qmax-mcp outside the release workflow.');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error('');
  console.error('Publish by dispatching .github/workflows/release.yml from an annotated v<version>');
  console.error('tag whose commit is reachable from main. See docs/release.md.');
  process.exit(1);
}

console.log('Publish guard passed: GitHub Actions run with provenance requested.');
