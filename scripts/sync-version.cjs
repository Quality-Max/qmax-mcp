#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const paths = {
  package: path.join(root, 'package.json'),
  lockfile: path.join(root, 'package-lock.json'),
  manifest: path.join(root, 'server.json'),
  smithery: path.join(root, 'smithery.yaml'),
  metadata: path.join(root, 'src', 'metadata.ts'),
};

/** Single capture group: the prefix. There is no suffix to preserve after the value. */
const SMITHERY_VERSION = /^(version:\s*)[^\n]+$/m;
/** Two capture groups: the declaration prefix and the closing quote/semicolon suffix. */
const METADATA_VERSION = /(export const PACKAGE_VERSION = ')[^']+(';)/;

/**
 * Rewrite the version between a pattern's prefix group and its optional suffix group.
 *
 * Not a `$1…$2` replacement template: a pattern with a single capture group has no second group,
 * so the template would write a literal "$2" into the file. The capture groups are sliced off the
 * replacer arguments instead, because the trailing arguments differ by pattern — a single-group
 * pattern passes the match offset where a two-group pattern passes its second capture.
 */
function replaceVersion(source, expression, version, label) {
  if (!expression.test(source)) {
    throw new Error(`Could not find ${label} version to synchronize.`);
  }
  return source.replace(expression, (_match, ...rest) => {
    // Trailing arguments are offset and source, preceded by a named-groups object when one exists.
    const trailing = typeof rest[rest.length - 1] === 'object' ? 3 : 2;
    const [prefix = '', suffix = ''] = rest.slice(0, -trailing);
    return `${prefix}${version}${suffix}`;
  });
}

async function writeAtomically(file, contents) {
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, contents);
  await fs.rename(temporary, file);
}

async function main() {
  const requestedVersion = process.argv[2];
  const checkOnly = requestedVersion === '--check';
  if (!checkOnly && (!requestedVersion || !versionPattern.test(requestedVersion))) {
    throw new Error('Usage: npm run version:sync -- <semver> | npm run version:sync -- --check');
  }

  const [packageSource, lockfileSource, manifestSource, smitherySource, metadataSource] = await Promise.all([
    fs.readFile(paths.package, 'utf8'),
    fs.readFile(paths.lockfile, 'utf8'),
    fs.readFile(paths.manifest, 'utf8'),
    fs.readFile(paths.smithery, 'utf8'),
    fs.readFile(paths.metadata, 'utf8'),
  ]);
  const packageJson = JSON.parse(packageSource);
  const lockfile = JSON.parse(lockfileSource);
  const manifest = JSON.parse(manifestSource);
  const versions = [
    packageJson.version,
    lockfile.version,
    lockfile.packages?.['']?.version,
    manifest.version,
    manifest.packages?.[0]?.version,
    (smitherySource.match(/^version:\s*(.+)$/m) || [])[1],
    (metadataSource.match(/export const PACKAGE_VERSION = '([^']+)';/) || [])[1],
  ];

  if (checkOnly) {
    if (versions.some((version) => version !== packageJson.version)) {
      throw new Error(`Version drift detected: ${versions.join(', ')}`);
    }
    console.log(`Version synchronization passed: ${packageJson.version}`);
    return;
  }

  packageJson.version = requestedVersion;
  lockfile.version = requestedVersion;
  if (!lockfile.packages?.['']) {
    throw new Error('package-lock.json is missing its root package entry.');
  }
  lockfile.packages[''].version = requestedVersion;
  manifest.version = requestedVersion;
  if (!manifest.packages?.[0]) {
    throw new Error('server.json is missing its npm package declaration.');
  }
  manifest.packages[0].version = requestedVersion;

  const nextSmithery = replaceVersion(smitherySource, SMITHERY_VERSION, requestedVersion, 'Smithery');
  const nextMetadata = replaceVersion(metadataSource, METADATA_VERSION, requestedVersion, 'source metadata');
  await Promise.all([
    writeAtomically(paths.package, `${JSON.stringify(packageJson, null, 2)}\n`),
    writeAtomically(paths.lockfile, `${JSON.stringify(lockfile, null, 2)}\n`),
    writeAtomically(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`),
    writeAtomically(paths.smithery, nextSmithery),
    writeAtomically(paths.metadata, nextMetadata),
  ]);
  console.log(`Synchronized release metadata to ${requestedVersion}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { SMITHERY_VERSION, METADATA_VERSION, replaceVersion };
