import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHtmlReport } from './html-report.mjs';
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
:root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f2; color: #172420; }
* { box-sizing: border-box; }
body { margin: 0; }
main { max-width: 1040px; margin: 0 auto; padding: 56px 28px 80px; }
.eyebrow { color: #3e6654; font-size: .78rem; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
h1 { font-size: clamp(2.2rem, 5vw, 3.8rem); letter-spacing: -.05em; line-height: 1.1; margin: 12px 0 8px; }
header p { margin: 0; color: #53675b; }
section { margin-top: 54px; }
h2 { font-size: 1.3rem; margin: 0 0 16px; letter-spacing: -.025em; }
.list { display: grid; gap: 13px; }
.entry { display: block; padding: 24px 26px; border: 1px solid #d5ddd5; border-radius: 11px; background: #fff; color: inherit; text-decoration: none; box-shadow: 0 3px 12px #173b2110; }
.entry:hover { border-color: #639174; background: #fcfdfa; }
.entry:focus-visible { outline: 3px solid #237c9a; outline-offset: 2px; }
.entry h3 { font-size: 1.13rem; margin: 0 0 8px; }
.entry p { margin: 6px 0; color: #52665a; line-height: 1.5; }
.meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; color: #42594b; font-size: .79rem; }
.meta span { background: #e9ede7; padding: 5px 9px; border-radius: 6px; }
@media (max-width: 680px) { main { padding: 34px 16px 55px; } .entry { padding: 18px; } }
`;

export function buildReportSite(configPath, outDir) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const reports = config.reports ?? [];
  const links = config.links ?? [];
  if (typeof config.title !== 'string' || !Array.isArray(reports) || !Array.isArray(links)) throw new Error('site config needs a title, reports array, and links array');
  const slugs = new Set();
  const children = reports.map((entry) => {
    if (typeof entry.title !== 'string' || typeof entry.run !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.slug)) throw new Error('each report needs a title, run, and lowercase slug');
    if (slugs.has(entry.slug)) throw new Error(`duplicate report slug: ${entry.slug}`);
    slugs.add(entry.slug);
    const dir = resolve(dirname(configPath), entry.run);
    const run = readRun(dir);
    if (entry.diagnoses && (basename(entry.diagnoses) !== entry.diagnoses || !entry.diagnoses.endsWith('.json'))) throw new Error(`diagnoses must name a JSON file inside ${dir}`);
    const diagnoses = entry.diagnoses ? JSON.parse(readFileSync(join(dir, entry.diagnoses), 'utf8')) : null;
    const html = renderHtmlReport(run, basename(dir), { homeHref: '../../index.html', diagnoses });
    const models = [...new Set(run.results.map((row) => row.model).filter(Boolean))].join(', ');
    const surfaces = new Set(run.results.map((row) => row.condition)).size;
    const backends = new Set(run.results.map((row) => row.backend).filter(Boolean)).size;
    const tasks = new Set(run.results.map((row) => row.task)).size;
    return { title: entry.title, slug: entry.slug, intro: entry.intro, models, surfaces, backends, tasks, html };
  });
  for (const link of links) {
    if (typeof link.title !== 'string') throw new Error('each link needs a title');
    safeHref(link.href);
  }
  const reportCards = children.map((entry) => `<a class="entry" href="reports/${entry.slug}/index.html"><h3>${escapeHtml(entry.title)}</h3>${entry.intro ? `<p>${escapeHtml(entry.intro)}</p>` : ''}<div class="meta">${entry.models ? `<span>${escapeHtml(entry.models)}</span>` : ''}<span>${entry.tasks} tasks</span><span>${entry.backends > 1 ? `${entry.backends} backends` : `${entry.surfaces} ${entry.surfaces === 1 ? 'surface' : 'surfaces'}`}</span></div></a>`).join('\n');
  const linkCards = links.map((entry) => `<a class="entry" href="${escapeHtml(safeHref(entry.href))}"><h3>${escapeHtml(entry.title)}</h3>${entry.intro ? `<p>${escapeHtml(entry.intro)}</p>` : ''}</a>`).join('\n');
  const index = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(config.title)}</title><style>${css}</style></head>
<body><main><header><div class="eyebrow">Zoo sites / evals</div><h1>${escapeHtml(config.title)}</h1>${config.intro ? `<p>${escapeHtml(config.intro)}</p>` : ''}</header>
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
  for (const entry of children) {
    const childDir = join(outDir, 'reports', entry.slug);
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, 'index.html'), entry.html);
  }
  return { home: join(outDir, 'index.html'), reports: children.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node eval/scripts/report-site.mjs [--config eval/report-site.json] [--out eval/results/intranet]\nOnly reports listed in the config are included in the static site.');
  } else {
    let configPath = join(here, '..', 'report-site.json');
    let outDir = join(here, '..', 'results', 'intranet');
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
