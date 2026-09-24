import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGINS, originUrls } from '../../manifest.mjs';
import { devtoolsTasks } from '../tasks/devtools.mjs';
import { webTasks } from '../tasks/web.mjs';
import { DRIVERS } from '../verify-drivers/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const excludedSites = new Set(['basic', 'caldmoor-bank-login', 'northmarsh']);
const demoSites = ORIGINS.map((origin) => origin.key).filter((site) => !excludedSites.has(site));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
};
const seconds = Number(option('seconds', '12'));
const fromRun = option('from-run', null);
const requestedSites = option('sites', null);
const sites = requestedSites?.split(',') ?? demoSites;
const limit = Number(option('limit', String(requestedSites ? sites.length : 3)));
if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(seconds) || seconds < 1 || seconds > 120) {
  throw new Error('--limit must be positive and --seconds must be between 1 and 120');
}
const selectedSites = sites.slice(0, limit);
if (new Set(selectedSites).size !== selectedSites.length || selectedSites.some((site) => !demoSites.includes(site))) {
  throw new Error('--sites must contain distinct demo site keys (excluding basic, caldmoor-bank-login and northmarsh)');
}
const dryRun = args.includes('--dry-run');
const known = new Set(['--from-run', '--limit', '--seconds', '--sites']);
for (let index = 0; index < args.length; index++) {
  if (known.has(args[index])) index++;
  else if (args[index] !== '--dry-run') throw new Error(`unknown argument: ${args[index]}`);
}

const base = 'http://127.0.0.1:8907';
const urls = originUrls(base);
const tasks = [...await webTasks(base), ...await devtoolsTasks(base)];
const timings = JSON.parse(readFileSync(join(root, 'eval/verify-drivers/timings.json'), 'utf8')).ms;
const chosen = [];
const used = new Set();
for (const site of selectedSites) {
  const candidates = tasks.filter((task) =>
    DRIVERS[task.id] &&
    (task.ask.includes(`${urls[site]}/`) || (site === 'gadgetron-mirror' && task.id === 'mirror-reroute'))
  );
  candidates.sort((left, right) =>
    Number(used.has(left.id)) - Number(used.has(right.id)) ||
    Math.abs((timings[left.id] ?? 0) - 1000) - Math.abs((timings[right.id] ?? 0) - 1000)
  );
  const task = candidates[0];
  if (!task) throw new Error(`no scripted task for ${site}; use --sites to choose a supported pilot`);
  const shared = used.has(task.id);
  used.add(task.id);
  chosen.push({ site, task: task.id, measuredMs: timings[task.id] ?? null, shared });
}
console.log(chosen.map(({ site, task, measuredMs, shared }) =>
  `${site}: ${task} (${measuredMs ?? '?'} ms golden path${shared ? ', shared recording' : ''})`
).join('\n'));
if (dryRun) process.exit(0);

let runDir = fromRun ? resolve(root, fromRun) : null;
if (!runDir) {
  const runArgs = [
    'eval/run.mjs', '--suite', 'all', '--backend', 'scripted', '--conditions', 'firefox-devtools-mcp',
    '--no-tap', '--record-video', '--retries', '0', '--task', [...used].join(','),
  ];
  const run = spawn(process.execPath, runArgs, { cwd: root, stdio: ['inherit', 'pipe', 'inherit'] });
  let output = '';
  run.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    output = (output + chunk).slice(-8192);
  });
  const exit = await new Promise((resolveExit, reject) => {
    run.once('error', reject);
    run.once('close', resolveExit);
  });
  if (exit !== 0) throw new Error(`eval exited ${exit}`);
  runDir = output.match(/run dir: ([^\n]+)/)?.[1];
  if (!runDir) throw new Error('eval did not report a run directory');
}
const results = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8'));
const videos = chosen.map((entry) => {
  const row = results.results.find((result) => result.task === entry.task && result.success);
  if (!row?.transcript) throw new Error(`no passing row for ${entry.task}`);
  return { ...entry, path: join(runDir, 'videos', row.transcript.replace(/\.jsonl$/, '.webm')) };
});
if (['ffmpeg', 'ffprobe'].some((command) => spawnSync(command, ['-version'], { stdio: 'ignore' }).status !== 0)) {
  throw new Error('ffmpeg and ffprobe must be installed to stitch the videos');
}
const playSeconds = Math.max(1, seconds - 2);
for (const video of videos) {
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time',
    '-of', 'csv=p=0', video.path,
  ], { encoding: 'utf8' });
  const lastFrame = Number(probe.stdout?.trim().split('\n').at(-1));
  if (probe.status !== 0 || !probe.stdout?.trim() || !Number.isFinite(lastFrame) || lastFrame < 0) {
    throw new Error(`cannot measure video duration: ${video.path}`);
  }
  video.speed = lastFrame ? Number((lastFrame / (playSeconds - 1 / 12)).toFixed(5)) : 1;
}
const cellWidth = videos.length <= 9 ? 600 : videos.length <= 25 ? 360 : 240;
const cellHeight = cellWidth / 2;
const columns = Math.ceil(Math.sqrt(videos.length * 8 / 9));
const rows = Math.ceil(videos.length / columns);
const labelsPath = join(runDir, 'labels.png');
const mcpRequire = createRequire(createRequire(import.meta.url).resolve('@playwright/mcp/package.json'));
const { firefox } = mcpRequire('playwright-core');
const labelBrowser = await firefox.launch({ headless: true });
try {
  const page = await labelBrowser.newPage({ viewport: { width: columns * cellWidth, height: rows * cellHeight } });
  const png = await page.evaluate(({ entries, width, height, cols, cell }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const fontSize = cell <= 240 ? 13 : 18;
    entries.forEach(({ site, task }, index) => {
      context.font = `600 ${fontSize}px sans-serif`;
      const siteWidth = context.measureText(site).width;
      context.font = `${Math.round(fontSize * .7)}px sans-serif`;
      const taskWidth = context.measureText(task).width;
      const labelWidth = Math.min(cell - 16, Math.ceil(Math.max(siteWidth, taskWidth)) + 20);
      const left = index % cols * cell + 8;
      const top = Math.floor(index / cols) * cell / 2 + 8;
      context.fillStyle = '#111';
      context.beginPath();
      context.roundRect(left, top, labelWidth, fontSize * 2.1 + 14, 4);
      context.fill();
      context.fillStyle = '#fff';
      context.font = `600 ${fontSize}px sans-serif`;
      context.fillText(site, left + 10, top + fontSize + 4, labelWidth - 20);
      context.fillStyle = '#ddd';
      context.font = `${Math.round(fontSize * .7)}px sans-serif`;
      context.fillText(task, left + 10, top + fontSize * 2 + 4, labelWidth - 20);
    });
    return canvas.toDataURL('image/png');
  }, { entries: videos.map(({ site, task }) => ({ site, task })), width: columns * cellWidth,
    height: rows * cellHeight, cols: columns, cell: cellWidth });
  writeFileSync(labelsPath, Buffer.from(png.split(',')[1], 'base64'));
} finally {
  await labelBrowser.close();
}
const labels = Array.from(videos.keys(), (index) => `[v${index}]`).join('');
const filters = videos.map((video, index) =>
  `[${index}:v]setpts=(PTS-STARTPTS)/${video.speed},` +
  `tpad=stop_mode=clone:stop_duration=${seconds},fps=12,` +
  `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,` +
  `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:black,` +
  `trim=duration=${seconds},setpts=PTS-STARTPTS[v${index}]`
);
const layout = Array.from(videos.keys(), (index) => `${index % columns * cellWidth}_${Math.floor(index / columns) * cellHeight}`).join('|');
filters.push(videos.length === 1 ? '[v0]format=yuv420p[grid]' : `${labels}xstack=inputs=${videos.length}:layout=${layout}:fill=black[grid]`);
filters.push(`[grid][${videos.length}:v]overlay=shortest=1,format=yuv420p[out]`);
const mp4 = join(runDir, 'demo.mp4');
const ffmpeg = spawn('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', '-filter_complex_threads', '1',
  ...videos.flatMap((video) => ['-threads', '1', '-i', video.path]),
  '-loop', '1', '-framerate', '12', '-i', labelsPath,
  '-filter_complex', filters.join(';'), '-map', '[out]', '-an', '-t', String(seconds),
  '-c:v', 'libx264', '-threads', '2', '-preset', 'medium', '-crf', '28', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', mp4,
], { stdio: 'inherit' });
const ffmpegExit = await new Promise((resolve, reject) => {
  ffmpeg.once('error', reject);
  ffmpeg.once('close', resolve);
});
if (ffmpegExit !== 0) throw new Error(`ffmpeg exited ${ffmpegExit}`);
writeFileSync(join(runDir, 'demo.json'), JSON.stringify({
  seconds, playSeconds, columns, rows, cellWidth, cellHeight,
  videos: videos.map(({ site, task, measuredMs, shared, path, speed }) =>
    ({ site, task, measuredMs, shared, speed, file: `videos/${basename(path)}` })),
}, null, 2));
console.log(`demo: ${mp4}`);
