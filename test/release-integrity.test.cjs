/**
 * 0.2.1 was published to npm as `latest` without a tag, a commit, a `gitHead` or an attestation,
 * carrying 0.2.0 metadata inside the tarball. Two holes let that happen: nothing in `npm run check`
 * ever ran the drift detector, so CI could not have caught the half-bumped tree, and nothing stopped
 * `npm publish` from a workstation. These tests hold both holes shut.
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const syncScript = path.join(root, 'scripts', 'sync-version.cjs');
const guardScript = path.join(root, 'scripts', 'guard-publish.cjs');

/** Returns { status, stdout, stderr } instead of throwing, so failure cases are assertable. */
function run(script, args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

/**
 * A fixture tree the sync script accepts as a repository root. The script resolves its root as
 * `<script>/..`, so the copied script has to live in a `scripts/` directory inside the fixture.
 */
function makeFixture(versions = {}) {
  const {
    package: packageVersion = '1.0.0',
    lockfile = packageVersion,
    manifest = packageVersion,
    smithery = packageVersion,
    metadata = packageVersion,
  } = versions;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmax-release-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.copyFileSync(syncScript, path.join(dir, 'scripts', 'sync-version.cjs'));

  const write = (file, contents) => fs.writeFileSync(path.join(dir, file), contents);
  write('package.json', `${JSON.stringify({ name: 'fixture', version: packageVersion }, null, 2)}\n`);
  write(
    'package-lock.json',
    `${JSON.stringify({ name: 'fixture', version: lockfile, packages: { '': { version: lockfile } } }, null, 2)}\n`
  );
  write(
    'server.json',
    `${JSON.stringify({ name: 'fixture', version: manifest, packages: [{ version: manifest }] }, null, 2)}\n`
  );
  write('smithery.yaml', `name: fixture\nversion: ${smithery}\nhomepage: https://qualitymax.io\n`);
  write(path.join('src', 'metadata.ts'), `export const PACKAGE_VERSION = '${metadata}';\n`);

  return dir;
}

function readFixtureVersions(dir) {
  const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8');
  return {
    package: JSON.parse(read('package.json')).version,
    lockfile: JSON.parse(read('package-lock.json')).packages[''].version,
    manifest: JSON.parse(read('server.json')).packages[0].version,
    smithery: read('smithery.yaml').match(/^version:\s*(.+)$/m)[1],
    metadata: read(path.join('src', 'metadata.ts')).match(/PACKAGE_VERSION = '([^']+)'/)[1],
  };
}

test('the committed tree has no version drift', () => {
  const result = run(syncScript, ['--check']);
  assert.equal(result.status, 0, `--check failed on the real repository: ${result.stderr}`);
});

test('npm run check runs the drift detector, so CI can fail on drift', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  // The 0.2.1 tarball shipped stale manifests because `check` only linted, tested and validated
  // server.json against its schema — none of which compares versions across surfaces.
  assert.match(scripts.check, /version:sync\s+--\s+--check/, '`check` must run the drift detector');
});

test('--check fails when any single surface drifts', () => {
  for (const surface of ['lockfile', 'manifest', 'smithery', 'metadata']) {
    const dir = makeFixture({ package: '1.0.1', [surface]: '1.0.0' });
    const result = run(path.join(dir, 'scripts', 'sync-version.cjs'), ['--check']);

    assert.equal(result.status, 1, `drift in ${surface} was not detected`);
    assert.match(result.stderr, /Version drift detected/);
  }
});

test('--current pulls every surface up to the version npm already bumped', () => {
  // Exactly the 0.2.1 shape: `npm version patch` moved package.json and the lockfile, nothing else.
  const dir = makeFixture({ package: '0.2.1', lockfile: '0.2.1', manifest: '0.2.0', smithery: '0.2.0', metadata: '0.2.0' });
  const fixtureScript = path.join(dir, 'scripts', 'sync-version.cjs');

  assert.equal(run(fixtureScript, ['--check']).status, 1, 'fixture should start drifted');

  const result = run(fixtureScript, ['--current']);
  assert.equal(result.status, 0, result.stderr);

  const versions = readFixtureVersions(dir);
  for (const [surface, version] of Object.entries(versions)) {
    assert.equal(version, '0.2.1', `${surface} was left behind at ${version}`);
  }
  assert.equal(run(fixtureScript, ['--check']).status, 0, '--current must leave the tree synchronized');
});

test('the version lifecycle hook stages every surface it rewrites', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(scripts.version, 'npm version must synchronize the remaining surfaces');
  assert.match(scripts.version, /version:sync\s+--\s+--current/);
  // An unstaged surface is a half-bumped commit, which is the drift the hook exists to prevent.
  for (const surface of ['package.json', 'package-lock.json', 'server.json', 'smithery.yaml', 'src/metadata.ts']) {
    assert.ok(scripts.version.includes(surface), `${surface} is rewritten but never staged`);
  }
});

test('the publish guard rejects a workstation publish', () => {
  const result = run(guardScript, [], { GITHUB_ACTIONS: undefined, npm_config_provenance: 'true' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub Actions/);
});

test('the publish guard rejects a publish without provenance', () => {
  const result = run(guardScript, [], { GITHUB_ACTIONS: 'true', npm_config_provenance: undefined });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--provenance/);
});

test('the publish guard allows the release workflow through', () => {
  const result = run(guardScript, [], { GITHUB_ACTIONS: 'true', npm_config_provenance: 'true' });
  assert.equal(result.status, 0, result.stderr);
});

test('prepublishOnly runs the publish guard before building', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(scripts.prepublishOnly, /^node scripts\/guard-publish\.cjs &&/);
});
