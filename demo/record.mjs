import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(root, 'run.mjs'), '--format', 'markdown'], {
  cwd: path.join(root, '..'),
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code) => resolve(code ?? 1));
});
if (exitCode !== 0) throw new Error(`Demo recording failed: ${stderr || `exit ${exitCode}`}`);

const command = '$ npm run demo -- --format markdown\r\n';
const cast = [
  JSON.stringify({ version: 2, width: 100, height: 30, timestamp: Math.floor(Date.now() / 1000), title: 'QualityMax scan to repro' }),
  JSON.stringify([0, 'o', command]),
  JSON.stringify([0.6, 'o', stdout]),
].join('\n');

await writeFile(path.join(root, 'scan-to-repro.cast'), `${cast}\n`, 'utf8');
process.stdout.write('Terminal recording written to demo/scan-to-repro.cast\n');
