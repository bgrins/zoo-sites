import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandMark, readRunReview, renderHtmlReport, tracePath } from './html-report.mjs';
import { readRun } from '../run-files.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const marker = '.zoo-sites-report-site';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function safeHref(href) {
  if (typeof href !== 'string' || !href.trim() || href.startsWith('//')) throw new Error(`unsafe link: ${href}`);
  const url = new URL(href, 'https://example.invalid/');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`unsafe link: ${href}`);
  return href;
}

const css = `
:root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #eef0ec; color: #303232; --ink: #303232; --blue: #507b9d; --mint: #c7ddcb; --line: #d5dad5; }
* { box-sizing: border-box; }
body { margin: 0; }
main { max-width: 1160px; margin: 0 auto; padding: 30px 28px 90px; }
header { padding: 10px 0 28px; }
.topbar, .brand, .demo-bar { display: flex; align-items: center; }
.topbar { justify-content: space-between; flex-wrap: wrap; gap: 18px; }
.brand { gap: 9px; margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: 1.35rem; font-weight: 700; letter-spacing: -.05em; white-space: nowrap; }
.brand-mark { width: 36px; height: 36px; flex: none; }
.brand small { font-family: system-ui, sans-serif; font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.repo-link { border: 1px solid var(--ink); border-radius: 999px; padding: 11px 17px; color: var(--ink); text-decoration: none; font-size: .84rem; font-weight: 700; white-space: nowrap; }
.repo-link:hover { background: var(--ink); color: #fff; }
h2, .entry h3 { font-family: Georgia, "Times New Roman", serif; }
header p { max-width: 60ch; margin: 0; color: #59635e; line-height: 1.5; }
section { margin-top: 50px; }
h2 { margin: 0 0 18px; font-size: 1.65rem; letter-spacing: -.035em; }
.list { display: grid; gap: 14px; }
.entry { display: block; padding: 25px 28px; border: 1px solid var(--line); border-left: 5px solid var(--blue); border-radius: 13px; background: #fff; color: inherit; text-decoration: none; box-shadow: 0 9px 28px #3032320c; transition: transform .16s, box-shadow .16s; }
.entry:hover { transform: translateY(-2px); box-shadow: 0 14px 32px #30323219; }
.entry h3 { margin: 0 0 8px; font-size: 1.35rem; letter-spacing: -.025em; }
.entry p { margin: 6px 0; color: #5e6964; line-height: 1.5; }
.demo { margin-top: 4px; border: 12px solid var(--ink); border-radius: 26px; overflow: hidden; background: var(--ink); box-shadow: 0 22px 45px #30323225; }
.demo-bar { gap: 9px; height: 40px; padding: 0 14px 10px; }
.window-dot { width: 12px; height: 12px; border-radius: 50%; background: #db766f; }
.window-dot:nth-child(2) { background: #ddb46b; }
.window-dot:nth-child(3) { background: #86b69a; }
.demo video { display: block; width: 100%; height: auto; border-radius: 14px; background: #fff; }
.meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; color: #42554c; font-size: .78rem; }
.meta span { background: #e8eee8; padding: 6px 10px; border-radius: 6px; }
:focus-visible { outline: 3px solid var(--blue); outline-offset: 3px; }
@media (max-width: 680px) { main { padding: 20px 16px 55px; } .repo-link { padding: 9px 12px; } .entry { padding: 20px; } .demo { border-width: 7px; border-radius: 17px; } .demo-bar { height: 33px; padding: 0 8px 7px; } }
`;

export function buildReportSite(configPath, outDir) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const reports = config.reports ?? [];
  const links = config.links ?? [];
  if (typeof config.title !== 'string' || !Array.isArray(reports) || !Array.isArray(links)) throw new Error('site config needs a title, reports array, and links array');
  if (config.repository != null) safeHref(config.repository);
  if (config.video != null && (typeof config.video !== 'string' || !config.video.endsWith('.mp4'))) throw new Error('video must name an MP4 file');
  const video = config.video ? resolve(dirname(configPath), config.video) : null;
  if (video && !existsSync(video)) throw new Error(`video not found: ${video}`);
  const slugs = new Set();
  const children = reports.map((entry) => {
    if (typeof entry.title !== 'string' || typeof entry.run !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.slug)) throw new Error('each report needs a title, run, and lowercase slug');
    if (slugs.has(entry.slug)) throw new Error(`duplicate report slug: ${entry.slug}`);
    slugs.add(entry.slug);
    const dir = resolve(dirname(configPath), entry.run);
    const run = readRun(dir);
    if (entry.diagnoses && (basename(entry.diagnoses) !== entry.diagnoses || !entry.diagnoses.endsWith('.json'))) throw new Error(`diagnoses must name a JSON file inside ${dir}`);
    if (entry.review && (basename(entry.review) !== entry.review || !entry.review.endsWith('.json'))) throw new Error(`review must name a JSON file inside ${dir}`);
    if (entry.traces != null && typeof entry.traces !== 'boolean') throw new Error('traces must be true or false');
    const diagnosesText = entry.diagnoses ? readFileSync(join(dir, entry.diagnoses), 'utf8') : null;
    const diagnoses = diagnosesText ? JSON.parse(diagnosesText) : null;
    const runReview = entry.review ? readRunReview(join(dir, entry.review), basename(dir), diagnosesText, readFileSync(join(dir, 'results.json'), 'utf8')) : null;
    const traces = new Map();
    const traceHref = entry.traces ? (row, type) => {
      const file = tracePath(dir, row, type);
      if (!file) return null;
      const target = `traces/${type === 'transcript' ? 'transcripts' : 'rollouts'}/${encodeURIComponent(basename(file))}`;
      traces.set(target, file);
      return target;
    } : null;
    const html = renderHtmlReport(run, basename(dir), { homeHref: '../../index.html', diagnoses, runReview, traceHref, title: entry.title });
    const models = [...new Set(run.results.map((row) => row.model).filter(Boolean))].join(', ');
    const surfaces = new Set(run.results.map((row) => row.condition)).size;
    const backends = new Set(run.results.map((row) => row.backend).filter(Boolean)).size;
    const tasks = new Set(run.results.map((row) => row.task)).size;
    return { title: entry.title, slug: entry.slug, intro: entry.intro, models, surfaces, backends, tasks, html, traces };
  });
  for (const link of links) {
    if (typeof link.title !== 'string') throw new Error('each link needs a title');
    safeHref(link.href);
  }
  const reportCards = children.map((entry) => `<a class="entry" href="reports/${entry.slug}/index.html"><h3>${escapeHtml(entry.title)}</h3>${entry.intro ? `<p>${escapeHtml(entry.intro)}</p>` : ''}<div class="meta">${entry.models ? `<span>${escapeHtml(entry.models)}</span>` : ''}<span>${entry.tasks} tasks</span><span>${entry.backends > 1 ? `${entry.backends} backends` : `${entry.surfaces} ${entry.surfaces === 1 ? 'surface' : 'surfaces'}`}</span></div></a>`).join('\n');
  const linkCards = links.map((entry) => `<a class="entry" href="${escapeHtml(safeHref(entry.href))}"><h3>${escapeHtml(entry.title)}</h3>${entry.intro ? `<p>${escapeHtml(entry.intro)}</p>` : ''}</a>`).join('\n');
  const index = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(config.title)}</title><style>${css}</style></head>
<body><main><header><div class="topbar"><h1 class="brand">${brandMark}<span>the_zoo <small>/ Evals</small></span></h1>${config.repository ? `<a class="repo-link" href="${escapeHtml(config.repository)}" target="_blank" rel="noopener noreferrer">GitHub repository</a>` : ''}</div>${config.intro ? `<p>${escapeHtml(config.intro)}</p>` : ''}</header>
${video ? `<section class="demo" aria-label="Browser evaluation demo"><div class="demo-bar" aria-hidden="true"><span class="window-dot"></span><span class="window-dot"></span><span class="window-dot"></span></div><video muted loop playsinline controls preload="auto" aria-label="Browser evaluation demo"><source src="media/${encodeURIComponent(basename(video))}" type="video/mp4">Your browser cannot play this video.</video></section><script>(() => { const demo = document.querySelector('.demo video'); const motion = matchMedia('(prefers-reduced-motion: reduce)'); if (!motion.matches) demo.play().catch(() => {}); motion.addEventListener('change', () => { if (motion.matches) demo.pause(); }); })();</script>` : ''}
${children.length ? `<section><h2>Reports</h2><div class="list">${reportCards}</div></section>` : ''}
${links.length ? `<section><h2>Links</h2><div class="list">${linkCards}</div></section>` : ''}
</main></body></html>\n`;
  if (existsSync(outDir)) {
    if (!existsSync(join(outDir, marker)) || readFileSync(join(outDir, marker), 'utf8') !== 'zoo-sites report site\n') throw new Error(`refusing to overwrite unmanaged directory: ${outDir}`);
    rmSync(outDir, { recursive: true });
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, marker), 'zoo-sites report site\n');
  writeFileSync(join(outDir, 'index.html'), index);
  if (video) {
    mkdirSync(join(outDir, 'media'), { recursive: true });
    copyFileSync(video, join(outDir, 'media', basename(video)));
  }
  for (const entry of children) {
    const childDir = join(outDir, 'reports', entry.slug);
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, 'index.html'), entry.html);
    for (const [target, source] of entry.traces) {
      const destination = join(childDir, target);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
  }
  return { home: join(outDir, 'index.html'), reports: children.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node eval/scripts/report-site.mjs [--config eval/report-site.json] [--out eval/results/gallery]\nOnly reports listed in the config are included in the static site.');
  } else {
    let configPath = join(here, '..', 'report-site.json');
    let outDir = join(here, '..', 'results', 'gallery');
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (!['--config', '--out'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('use --config <file> and --out <directory>');
      if (flag === '--config') configPath = args[++index];
      else outDir = args[++index];
    }
    configPath = resolve(configPath);
    outDir = resolve(outDir);
    const result = buildReportSite(configPath, outDir);
    console.log(`wrote ${result.home} with ${result.reports} report(s)`);
  }
}
