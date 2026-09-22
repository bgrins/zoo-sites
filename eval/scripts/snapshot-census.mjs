// How much of a page's rendered text a take_snapshot delivers, and at what
// size, over the entry page of every web task (about 74 distinct pages), per
// build of firefox-devtools-mcp. Free: no agent, one browser per build.
//
//   node eval/scripts/snapshot-census.mjs [--build [<label>=]<root|dep>]...
//        [--snapshot '<take_snapshot args as JSON>'] [--limit <n>]
//        [--out <json>] [--compare <baseline.json>]
//
// A rendered line counts as delivered when the snapshot contains it verbatim,
// case- and whitespace-insensitively; lines under 4 characters are skipped.
// Char coverage weights each line by its length, so a cut paragraph costs more
// than a missing button label. Pages are served with a fixed seed, so two
// builds meet the same layouts, and a rerun of one build lands within about
// 0.1%. With no --build it measures the build the gate would use
// (FIREFOX_DEVTOOLS_MCP, else the dependency), and every build runs the Firefox
// the gate would (EVAL_DEVTOOLS_FIREFOX, else the installed one); `--compare`
// reads an earlier --out file and prints what moved.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { startPagesServer } from '../../server.mjs';
import { webTasks } from '../tasks/web.mjs';
import { agentEnv } from '../agent-env.mjs';
import {
  DEVTOOLS_SERVER_ENV, devtoolsFirefox, devtoolsFirefoxLaunch, devtoolsMcpEntry, devtoolsMcpInfo, firefoxBuild, startMcpServer,
} from '../mcp-stdio.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const builds = args
  .flatMap((a, i) => (a === '--build' ? [args[i + 1]] : []))
  .map((spec) => {
    const [label, root] = spec.includes('=') ? spec.split(/=(.*)/s) : [null, spec];
    return root === 'dep'
      ? { label: label ?? 'dep', root: null }
      : { label: label ?? basename(resolve(root)), root: resolve(root) };
  });
if (!builds.length) {
  const root = process.env.FIREFOX_DEVTOOLS_MCP ? resolve(process.env.FIREFOX_DEVTOOLS_MCP) : null;
  builds.push({ label: root ? basename(root) : 'dep', root });
}
const FIREFOX = devtoolsFirefox();
const snapshotArgs = JSON.parse(flag('snapshot') ?? '{}');
const limit = Number(flag('limit') ?? Infinity);

const text = (r) => (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const round = (n, places = 3) => Number(n.toFixed(places));

async function census(build, pages, entries) {
  if (build.root) process.env.FIREFOX_DEVTOOLS_MCP = build.root;
  else delete process.env.FIREFOX_DEVTOOLS_MCP;
  const info = devtoolsMcpInfo();
  const launch = devtoolsFirefoxLaunch(FIREFOX, {}, null);
  const server = await startMcpServer({
    args: [devtoolsMcpEntry(), '--enable-script', '--headless', '--viewport', '1366x768', ...launch.args],
    env: DEVTOOLS_SERVER_ENV,
    baseEnv: agentEnv(null),
  });
  const started = performance.now();
  const rows = [];
  try {
    for (const { task, path } of entries) {
      await server.call('navigate_page', { url: pages.url + path });
      await new Promise((r) => setTimeout(r, 500));
      const snap = text(await server.call('take_snapshot', snapshotArgs));
      const raw = text(await server.call('evaluate_script', { function: '() => document.body.innerText' }));
      const inner = raw.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? raw;
      let body;
      try {
        body = JSON.parse(inner);
      } catch {
        body = inner;
      }
      const hay = norm(snap);
      const row = { task, path, lines: 0, hitLines: 0, chars: 0, hitChars: 0, snapChars: snap.length };
      for (const line of String(body).split('\n').map(norm).filter((l) => l.length >= 4)) {
        row.lines++;
        row.chars += line.length;
        if (hay.includes(line)) {
          row.hitLines++;
          row.hitChars += line.length;
        }
      }
      row.lineCut = /\[\+\d+ lines/.test(snap);
      row.domTruncated = snap.includes('[DOM truncated]');
      rows.push(row);
    }
  } finally {
    await server.close();
  }
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  const browser = firefoxBuild(FIREFOX?.binary ?? null, launch);
  return {
    label: build.label,
    root: build.root,
    version: info.version,
    source: info.source,
    firefox: { binary: browser?.binary ?? null, version: browser?.version ?? null, buildID: browser?.buildID ?? null },
    seconds: round((performance.now() - started) / 1000, 1),
    pages: rows.length,
    lineCoverage: round(sum('hitLines') / sum('lines')),
    charCoverage: round(sum('hitChars') / sum('chars')),
    lines: sum('lines'),
    chars: sum('chars'),
    snapChars: sum('snapChars'),
    lineCutPages: rows.filter((r) => r.lineCut).length,
    domTruncatedPages: rows.filter((r) => r.domTruncated).length,
    rows,
  };
}

const pages = await startPagesServer({ seed: 'census' });
const entries = [];
const seen = new Set();
for (const t of await webTasks(pages.url)) {
  const url = t.ask.match(/https?:\/\/[^\s)"'`]+/)?.[0]?.replace(/[.,;:]$/, '');
  if (!url || !url.startsWith(pages.url)) continue;
  const path = url.slice(pages.url.length) || '/';
  if (seen.has(path) || entries.length >= limit) continue;
  seen.add(path);
  entries.push({ task: t.id, path });
}
const runs = [];
try {
  for (const build of builds) runs.push(await census(build, pages, entries));
} finally {
  await pages.close();
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(
  `snapshot census over ${entries.length} task entry pages` +
    (Object.keys(snapshotArgs).length ? `, take_snapshot ${JSON.stringify(snapshotArgs)}` : '')
);
const firefoxOf = (r) => (r.firefox ? `Firefox ${r.firefox.version ?? '?'} ${r.firefox.buildID ?? '?'}` : 'Firefox not recorded');
for (const r of runs) {
  console.log(
    `  ${r.label} (${r.version}, ${r.source}, ${firefoxOf(r)}): ${pct(r.charCoverage)} of rendered chars, ` +
      `${pct(r.lineCoverage)} of lines, ${r.snapChars} snapshot chars; ` +
      `${r.lineCutPages} pages cut at the line window, ${r.domTruncatedPages} DOM-truncated; ${r.seconds}s`
  );
  const lowest = [...r.rows]
    .map((row) => [row.task, row.chars ? row.hitChars / row.chars : 1])
    .sort((a, b) => a[1] - b[1])
    .slice(0, 5);
  console.log(`    lowest char coverage: ${lowest.map(([t, v]) => `${t} ${pct(v)}`).join(', ')}`);
}
if (runs.length > 1) {
  const [a, ...rest] = runs;
  for (const b of rest) {
    console.log(
      `  ${b.label} against ${a.label}: chars ${pct(a.charCoverage)} -> ${pct(b.charCoverage)}, ` +
        `snapshot size ${((b.snapChars / a.snapChars - 1) * 100).toFixed(1)}%`
    );
  }
}

const baselinePath = flag('compare');
if (baselinePath) {
  const base = JSON.parse(readFileSync(baselinePath, 'utf8')).builds[0];
  const byPath = new Map(base.rows.map((row) => [row.path, row]));
  console.log(`\nagainst ${baselinePath} (${base.label}, ${base.version}, ${firefoxOf(base)}):`);
  for (const r of runs) {
    if (!base.firefox) {
      console.log(`  the baseline recorded no Firefox, so whether it ran ${r.label}'s ${firefoxOf(r)} is unknown`);
    } else if (firefoxOf(r) !== firefoxOf(base)) {
      console.log(`  ${r.label} ran ${firefoxOf(r)}, the baseline ${firefoxOf(base)}, so a move below may be the browser's`);
    }
    console.log(
      `  ${r.label}: chars ${pct(base.charCoverage)} -> ${pct(r.charCoverage)}, lines ` +
        `${pct(base.lineCoverage)} -> ${pct(r.lineCoverage)}, snapshot size ${base.snapChars} -> ${r.snapChars} ` +
        `(${((r.snapChars / base.snapChars - 1) * 100).toFixed(1)}%)`
    );
    const moved = r.rows
      .filter((row) => byPath.has(row.path))
      .map((row) => {
        const old = byPath.get(row.path);
        const cov = (x) => (x.chars ? x.hitChars / x.chars : 1);
        return { task: row.task, from: cov(old), to: cov(row) };
      })
      .filter((m) => Math.abs(m.to - m.from) >= 0.05)
      .sort((x, y) => Math.abs(y.to - y.from) - Math.abs(x.to - x.from));
    for (const m of moved.slice(0, 12)) console.log(`    ${m.task}: ${pct(m.from)} -> ${pct(m.to)}`);
    if (moved.length > 12) console.log(`    ...and ${moved.length - 12} more pages moved 5 points or more`);
  }
}

const out = flag('out');
if (out) {
  writeFileSync(
    out,
    JSON.stringify({ at: new Date().toISOString(), snapshotArgs, builds: runs }, null, 1) + '\n'
  );
  console.log(`\nwrote ${out}`);
}
