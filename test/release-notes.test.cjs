const assert = require('node:assert/strict');
const test = require('node:test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const { releaseNotes, headingAnchor } = require('../scripts/release-notes.cjs');

const CHANGELOG = `# Changelog

## Unreleased

## 1.2.0 — 2026-10-12

Lead paragraph ([#7]).

### Fixed

- A fix ([#8]). An inline [link](https://example.com) stays as written.

## 1.1.0 — 2026-09-01

- Older ([#6]).

[#6]: https://github.com/Quality-Max/qmax-mcp/pull/6
[#7]: https://github.com/Quality-Max/qmax-mcp/pull/7
[#8]: https://github.com/Quality-Max/qmax-mcp/issues/8
`;

test('notes carry only the version\'s own section and the link definitions it uses', () => {
  const notes = releaseNotes(CHANGELOG, '1.2.0', { sha: 'abcdef0123456789' });

  assert.match(notes, /^Lead paragraph \(\[#7\]\)\./);
  assert.match(notes, /### Fixed/);
  assert.doesNotMatch(notes, /Older/, 'the next version\'s entry is not included');
  assert.match(notes, /npx -y @qualitymax\/qmax-mcp@1\.2\.0/);
  assert.match(notes, /commit `abcdef0`/);
  assert.match(notes, /blob\/v1\.2\.0\/CHANGELOG\.md#120--2026-10-12\)/);

  // Without the definitions every PR link renders as literal brackets.
  assert.match(notes, /^\[#7\]: https:\/\/github\.com\/Quality-Max\/qmax-mcp\/pull\/7$/m);
  assert.match(notes, /^\[#8\]: https:\/\/github\.com\/Quality-Max\/qmax-mcp\/issues\/8$/m);
  assert.doesNotMatch(notes, /^\[#6\]:/m);
});

test('a version with no CHANGELOG entry fails rather than publishing empty notes', () => {
  assert.throws(() => releaseNotes(CHANGELOG, '9.9.9'), /no "## 9\.9\.9" section/);
});

test('the anchor matches the one GitHub generates for a dated heading', () => {
  assert.equal(headingAnchor('0.9.0 — 2026-08-28'), '090--2026-08-28');
});

test('the shipped CHANGELOG yields notes for the current package version', async () => {
  const root = path.join(__dirname, '..');
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(releaseNotes(changelog, version), new RegExp(`@qualitymax/qmax-mcp@${version.replace(/\./g, '\\.')}`));
});
