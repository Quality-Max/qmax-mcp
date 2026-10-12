#!/usr/bin/env node
/**
 * Print the GitHub Release notes for one version, built from its CHANGELOG
 * section.
 *
 * The release workflow creates the GitHub Release itself now, so the notes have
 * to come from something already reviewed: the CHANGELOG entry that shipped in
 * the release commit. The entry's reference-style links (`[#132]`) are defined
 * at the bottom of the CHANGELOG, not inside the section, so the definitions it
 * uses are carried along — otherwise every PR link renders as literal brackets.
 *
 * Usage: node scripts/release-notes.cjs <version> [--sha <commit>]
 */
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PACKAGE = '@qualitymax/qmax-mcp';
const REPOSITORY = 'https://github.com/Quality-Max/qmax-mcp';

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
function headingAnchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function releaseNotes(changelog, version, { sha } = {}) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${version} `) || line === `## ${version}`);
  if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section.`);
  const length = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  const end = length < 0 ? lines.length : start + 1 + length;
  const heading = lines[start].slice(3);
  const body = lines
    .slice(start + 1, end)
    .filter((line) => !/^\[[^\]]+\]:\s/.test(line))
    .join('\n')
    .trim();

  const definitions = new Map(
    lines
      .map((line) => line.match(/^\[([^\]]+)\]:\s*(\S+)/))
      .filter(Boolean)
      .map(([, label, url]) => [label, url])
  );
  const used = [...new Set([...body.matchAll(/\[([^\]]+)\](?![(:[])/g)].map(([, label]) => label))].filter((label) =>
    definitions.has(label)
  );

  const provenance = sha
    ? `Published with npm provenance from tag \`v${version}\`, commit \`${sha.slice(0, 7)}\`.`
    : `Published with npm provenance from tag \`v${version}\`.`;

  return [
    body,
    '',
    '## Install',
    '',
    '```bash',
    `npx -y ${PACKAGE}@${version}`,
    '```',
    '',
    provenance,
    '',
    `Full details: [CHANGELOG.md](${REPOSITORY}/blob/v${version}/CHANGELOG.md#${headingAnchor(heading)})`,
    ...(used.length > 0 ? ['', ...used.map((label) => `[${label}]: ${definitions.get(label)}`)] : []),
    '',
  ].join('\n');
}

if (require.main === module) {
  const [version, ...rest] = process.argv.slice(2);
  if (!version) {
    console.error('Usage: node scripts/release-notes.cjs <version> [--sha <commit>]');
    process.exit(2);
  }
  const shaIndex = rest.indexOf('--sha');
  const sha = shaIndex >= 0 ? rest[shaIndex + 1] : undefined;
  const changelog = readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  try {
    process.stdout.write(releaseNotes(changelog, version, { sha }));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { releaseNotes, headingAnchor };
