const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: root, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

test('package, registry, Smithery, and MCP server identities remain synchronized', async () => {
  const [packageJson, manifest, smithery, metadata, readme] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'server.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'smithery.yaml'), 'utf8'),
    readFile(path.join(root, 'src', 'metadata.ts'), 'utf8'),
    readFile(path.join(root, 'README.md'), 'utf8'),
  ]);

  assert.equal(packageJson.mcpName, manifest.name);
  assert.equal(packageJson.version, manifest.version);
  assert.equal(packageJson.version, manifest.packages[0].version);
  assert.equal(manifest.packages[0].identifier, packageJson.name);
  assert.equal(manifest.packages[0].runtimeHint, 'npx');
  assert.equal(manifest.packages[0].transport.type, 'stdio');
  assert.equal(manifest.name, 'io.github.quality-max/qmax-mcp');
  assert.ok(manifest.description.length <= 100);
  assert.match(metadata, new RegExp(`PACKAGE_VERSION = '${packageJson.version}'`));
  assert.match(metadata, /MCP_SERVER_NAME = 'io\.github\.quality-max\/qmax-mcp'/);
  assert.match(smithery, /^name: qmax-mcp$/m);
  assert.match(smithery, new RegExp(`^version: ${packageJson.version}$`, 'm'));
  assert.match(smithery, /args: \["-y", "@qualitymax\/qmax-mcp"\]/);
  assert.match(readme, /npx -y @qualitymax\/qmax-mcp/);
  assert.equal(readme.includes('QUALITYMAX_API_KEY=qm_...'), false);
  assert.deepEqual(Object.keys(packageJson.bin), ['qmax-mcp']);
});

test('release version synchronization check and MCP Registry preview succeed', async () => {
  // Read the expected version rather than hardcoding it, so a release bump does not need a test edit.
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const versionCheck = await run(process.execPath, ['scripts/sync-version.cjs', '--check']);
  assert.match(versionCheck.stdout, new RegExp(`Version synchronization passed: ${version.replace(/\./g, '\\.')}$`, 'm'));

  const preview = await run(process.execPath, ['scripts/registry-preview.cjs']);
  assert.equal(JSON.parse(preview.stdout).invocation, 'npx -y @qualitymax/qmax-mcp');
});

test('supported Node runtime is consistent across package metadata, CI, and release guidance', async () => {
  const [packageJson, qualityWorkflow, releaseWorkflow, readme, releaseGuide] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, '.github', 'workflows', 'quality.yml'), 'utf8'),
    readFile(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8'),
    readFile(path.join(root, 'README.md'), 'utf8'),
    readFile(path.join(root, 'docs', 'release.md'), 'utf8'),
  ]);

  assert.equal(packageJson.engines.node, '>=22.13.0');
  assert.match(qualityWorkflow, /node: \["22\.13", "24"\]/);
  assert.match(releaseWorkflow, /node: \["22\.13", "24"\]/);
  assert.match(releaseWorkflow, /node-version: "24"/);
  assert.match(releaseWorkflow, /WORKFLOW_REF: \$\{\{ github\.ref \}\}/);
  assert.match(releaseWorkflow, /test "\$\{WORKFLOW_REF\}" = "refs\/tags\/\$\{RELEASE_TAG\}"/);
  assert.match(releaseWorkflow, /git merge-base --is-ancestor "\$\{release_sha\}" origin\/main/);
  assert.match(readme, /Node 22\.13\.0 or newer/);
  assert.match(releaseGuide, /Node 22\.13 and 24/);
});

test('packed artifact contains only the supported public package contract and starts on Node', async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'qmax-package-contract-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const packed = await run('npm', ['pack', '--json', '--ignore-scripts', `--pack-destination=${workspace}`]);
  const artifact = JSON.parse(packed.stdout)[0];
  const packagedFiles = artifact.files.map((file) => file.path);
  assert.ok(packagedFiles.includes('LICENSE'));
  assert.ok(packagedFiles.includes('README.md'));
  assert.ok(packagedFiles.includes('server.json'));
  assert.ok(packagedFiles.includes('smithery.yaml'));
  assert.ok(packagedFiles.every((file) => file === 'LICENSE' || file === 'README.md' || file === 'package.json' || file === 'server.json' || file === 'smithery.yaml' || file.startsWith('dist/')));

  const consumer = path.join(workspace, 'consumer');
  await mkdir(consumer, { recursive: true });
  await writeFile(path.join(consumer, 'package.json'), '{"name":"qmax-contract-consumer","private":true}\n');
  const tarball = path.join(workspace, artifact.filename);
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball], { cwd: consumer });

  const installedCli = path.join(consumer, 'node_modules', '@qualitymax', 'qmax-mcp', 'dist', 'index.js');
  const help = await run(process.execPath, [installedCli, '--help'], { cwd: consumer });
  assert.match(help.stdout, /Usage: qmax-mcp/);
});
