/**
 * The release metadata writer shipped broken because every test only ever exercised `--check`.
 * `--check` reads each surface with its own pattern, so it passes on a freshly cloned tree no
 * matter what the write path would produce. These tests cover the write path itself.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { METADATA_VERSION, SMITHERY_VERSION, replaceVersion } = require('../scripts/sync-version.cjs');

test('a single-capture-group pattern writes the bare version', () => {
  const smithery = 'name: qmax-mcp\nversion: 0.1.0\nhomepage: https://qualitymax.io\n';
  const next = replaceVersion(smithery, SMITHERY_VERSION, '0.2.0', 'Smithery');

  assert.match(next, /^version: 0\.2\.0$/m);
  // A `$1…$2` replacement template leaves a literal "$2"; a naive replacer writes the match offset.
  assert.equal(next.includes('$2'), false);
  assert.equal(next.includes('0.2.0$'), false);
  assert.match(next, /^homepage: https:\/\/qualitymax\.io$/m, 'surrounding lines are untouched');
});

test('a two-capture-group pattern preserves its suffix', () => {
  const metadata = "export const PACKAGE_VERSION = '0.1.0';\nexport const MCP_SERVER_NAME = 'x';\n";
  const next = replaceVersion(metadata, METADATA_VERSION, '0.2.0', 'source metadata');

  assert.match(next, /export const PACKAGE_VERSION = '0\.2\.0';/);
  assert.match(next, /MCP_SERVER_NAME = 'x'/, 'surrounding declarations are untouched');
});

test('every synchronized version is a bare semver, whatever the pattern shape', () => {
  const cases = [
    ['version: 0.1.0\n', SMITHERY_VERSION],
    ["export const PACKAGE_VERSION = '0.1.0';\n", METADATA_VERSION],
  ];
  for (const [source, pattern] of cases) {
    const next = replaceVersion(source, pattern, '9.9.9', 'surface');
    const written = next.match(/9\.9\.9[^\s';]*/)[0];
    assert.equal(written, '9.9.9', `expected a bare version, wrote ${written}`);
  }
});

test('a pattern that matches nothing is a hard failure, not a silent no-op', () => {
  assert.throws(
    () => replaceVersion('name: qmax-mcp\n', SMITHERY_VERSION, '0.2.0', 'Smithery'),
    /Could not find Smithery version to synchronize/
  );
});
