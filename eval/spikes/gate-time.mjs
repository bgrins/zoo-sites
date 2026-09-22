// Probes how long the free gate takes, parallel at its default --jobs and serial, with machine load recorded; measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0), 14 cores.
//
//   node eval/spikes/gate-time.mjs [jobs...]    default: the gate's own default, then 1
//
// Other gates running on the same machine inflate every figure, so read the
// load averages printed beside each run before quoting one.

import { spawn } from 'node:child_process';
import { availableParallelism, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageVersions } from './lib.mjs';

const VERIFY = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify.mjs');
const runs = process.argv.slice(2).length ? process.argv.slice(2) : ['default', '1'];
const load = () => loadavg().map((n) => n.toFixed(1)).join(' ');

console.log(
  `gate wall time\nrunning on: firefox-devtools-mcp ${packageVersions().devtools}, ` +
    `${availableParallelism()} cores\n`
);
for (const jobs of runs) {
  const args = [VERIFY, ...(jobs === 'default' ? [] : ['--jobs', jobs])];
  const before = load();
  const started = Date.now();
  let last = started;
  const tasks = [];
  const summary = [];
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let buffered = '';
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        const now = Date.now();
        const m = line.match(/^(ok|FAIL)\s+(\S+)/);
        if (m) tasks.push({ id: m[2], ms: now - last });
        else if (/ ok, \d+ failed|^cases exercised|^static truth/.test(line)) summary.push(line);
        last = now;
      }
    });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`--jobs ${jobs}: ${seconds}s wall, load ${before} before, ${load()} after`);
  for (const line of summary) console.log(`  ${line}`);
  // Serial output is one result line per task, so the gap between lines is
  // that task's time; parallel lines interleave and the gaps mean nothing.
  if (jobs === '1') {
    const slowest = tasks.sort((a, b) => b.ms - a.ms).slice(0, 5);
    console.log(`  slowest: ${slowest.map((t) => `${t.id} ${(t.ms / 1000).toFixed(0)}s`).join(', ')}`);
  }
}
