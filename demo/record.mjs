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

// The recording replays the real run's bytes, but paced like the run rather
// than pasted as one frame: the command types out, output arrives line by
// line, and section boundaries pause long enough to register. Content is
// never invented or reordered — only event timestamps are staged.
const command = 'npm run demo -- --format markdown';
const events = [];
let clock = 0.4;
for (const ch of command) {
  events.push([clock, 'o', ch]);
  clock += ch === ' ' ? 0.09 : 0.035;
}
clock += 0.5;
events.push([clock, 'o', '\r\n']);
clock += 0.7;

const lines = stdout.split('\n');
for (const [index, line] of lines.entries()) {
  // Breathe before a new section so the reader can finish the previous one.
  if (/^(#|## |---)/.test(line)) clock += 0.55;
  events.push([clock, 'o', index < lines.length - 1 ? `${line}\n` : line]);
  clock += line.trim() === '' ? 0.02 : 0.045;
}

const cast = [
  JSON.stringify({
    version: 2,
    width: 100,
    height: 30,
    timestamp: Math.floor(Date.now() / 1000),
    title: 'QualityMax scan to repro',
  }),
  ...events.map((event) => JSON.stringify(event)),
].join('\n');

// The site replays the same recording; writing both here is what keeps the
// deployed demo and the repository artifact from drifting apart.
const targets = [path.join(root, 'scan-to-repro.cast'), path.join(root, '..', 'site', 'demo.cast')];
await Promise.all(targets.map((target) => writeFile(target, `${cast}\n`, 'utf8')));
process.stdout.write(`Terminal recording written to ${targets.map((t) => path.relative(path.join(root, '..'), t)).join(' and ')}\n`);
