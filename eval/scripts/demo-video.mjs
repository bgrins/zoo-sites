import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGINS, originUrls } from '../../manifest.mjs';
import { basicTasks } from '../tasks/basic.mjs';
import { devtoolsTasks } from '../tasks/devtools.mjs';
import { webTasks } from '../tasks/web.mjs';
import { DRIVERS } from '../verify-drivers/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
};
const limit = Number(option('limit', '3'));
const seconds = Number(option('seconds', '25'));
if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(seconds) || seconds < 1 || seconds > 120) {
  throw new Error('--limit must be positive and --seconds must be between 1 and 120');
}
const sites = option('sites', null)?.split(',') ?? ORIGINS.map((origin) => origin.key);
const selectedSites = sites.slice(0, limit);
if (new Set(selectedSites).size !== selectedSites.length || selectedSites.some((site) => !ORIGINS.some((origin) => origin.key === site))) {
  throw new Error('--sites must contain distinct origin keys from manifest.mjs');
}
const dryRun = args.includes('--dry-run');
const known = new Set(['--limit', '--seconds', '--sites']);
for (let index = 0; index < args.length; index++) {
  if (known.has(args[index])) index++;
  else if (args[index] !== '--dry-run') throw new Error(`unknown argument: ${args[index]}`);
}

const base = 'http://127.0.0.1:8907';
const urls = originUrls(base);
const tasks = [...await webTasks(base), ...await devtoolsTasks(base), ...basicTasks(base)];
const timings = JSON.parse(readFileSync(join(root, 'eval/verify-drivers/timings.json'), 'utf8')).ms;
const chosen = [];
const used = new Set();
for (const site of selectedSites) {
  const candidates = tasks.filter((task) =>
    DRIVERS[task.id] && !used.has(task.id) &&
    (task.ask.includes(`${urls[site]}/`) || (site === 'gadgetron-mirror' && task.id === 'mirror-reroute'))
  );
  candidates.sort((left, right) =>
    Math.abs((timings[left.id] ?? 0) - 1000) - Math.abs((timings[right.id] ?? 0) - 1000)
  );
  const task = candidates[0];
  if (!task) throw new Error(`no distinct scripted task for ${site}; use --sites to choose a supported pilot`);
  used.add(task.id);
  chosen.push({ site, task: task.id, measuredMs: timings[task.id] ?? null });
}
console.log(chosen.map(({ site, task, measuredMs }) => `${site}: ${task} (${measuredMs ?? '?'} ms golden path)`).join('\n'));
if (dryRun) process.exit(0);

const runArgs = [
  'eval/run.mjs', '--suite', 'all', '--backend', 'scripted', '--conditions', 'firefox-devtools-mcp',
  '--no-tap', '--record-video', '--retries', '0', '--task', chosen.map((entry) => entry.task).join(','),
];
const run = spawn(process.execPath, runArgs, { cwd: root, stdio: ['inherit', 'pipe', 'inherit'] });
let output = '';
run.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  output = (output + chunk).slice(-8192);
});
const exit = await new Promise((resolve, reject) => {
  run.once('error', reject);
  run.once('close', resolve);
});
if (exit !== 0) throw new Error(`eval exited ${exit}`);
const runDir = output.match(/run dir: ([^\n]+)/)?.[1];
if (!runDir) throw new Error('eval did not report a run directory');
const results = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8'));
const videos = chosen.map((entry) => {
  const row = results.results.find((result) => result.task === entry.task && result.success);
  if (!row?.transcript) throw new Error(`no passing row for ${entry.task}`);
  return { ...entry, path: join(runDir, 'videos', row.transcript.replace(/\.jsonl$/, '.webm')) };
});
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
  throw new Error('ffmpeg must be installed to stitch the videos');
}
const cellWidth = videos.length <= 9 ? 600 : videos.length <= 25 ? 360 : 240;
const cellHeight = cellWidth / 2;
const columns = Math.ceil(Math.sqrt(videos.length * 8 / 9));
const labels = Array.from(videos.keys(), (index) => `[v${index}]`).join('');
const filters = Array.from(videos.keys(), (index) =>
  `[${index}:v]fps=12,scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,` +
  `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:black,` +
  `tpad=stop_mode=clone:stop_duration=${seconds},trim=duration=${seconds},setpts=PTS-STARTPTS[v${index}]`
);
const layout = Array.from(videos.keys(), (index) => `${index % columns * cellWidth}_${Math.floor(index / columns) * cellHeight}`).join('|');
filters.push(videos.length === 1 ? '[v0]format=yuv420p[out]' : `${labels}xstack=inputs=${videos.length}:layout=${layout}:fill=black,format=yuv420p[out]`);
const mp4 = join(runDir, 'demo.mp4');
const ffmpeg = spawn('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', ...videos.flatMap((video) => ['-i', video.path]),
  '-filter_complex', filters.join(';'), '-map', '[out]', '-an', '-t', String(seconds),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '28', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', mp4,
], { stdio: 'inherit' });
const ffmpegExit = await new Promise((resolve, reject) => {
  ffmpeg.once('error', reject);
  ffmpeg.once('close', resolve);
});
if (ffmpegExit !== 0) throw new Error(`ffmpeg exited ${ffmpegExit}`);
writeFileSync(join(runDir, 'demo.json'), JSON.stringify({
  seconds, columns, cellWidth, cellHeight,
  videos: videos.map(({ site, task, measuredMs, path }) => ({ site, task, measuredMs, file: `videos/${basename(path)}` })),
}, null, 2));
console.log(`demo: ${mp4}`);
