// Probes every firefox-devtools-mcp limit and behaviour the docs, the drivers and the devtools-mcp roadmap rely on, one bare page each, and says per build whether the documented behaviour HOLDS or CHANGED, with the value measured; measured on firefox-devtools-mcp 0.10.3 (Firefox 156.0). The six probes whose claims name 0.9.15, and the two of close_firefox_session, which 0.9.15 lacks, print CHANGED on that build.
//
//   node eval/spikes/probes.mjs [--build [<label>=]<root|dep>]... [--only <ids>]
//                               [--out <json>] [--compare <baseline.json>]
//
// With no --build it probes the build the gate would use (FIREFOX_DEVTOOLS_MCP,
// else the dependency), and every build runs the Firefox the gate would
// (EVAL_DEVTOOLS_FIREFOX, else the installed one). Each --build adds a column,
// so a patched checkout reads against the release in one run:
// `--build base=dep --build caps=../fdm`.
// `--compare` reads an earlier --out file and prints each probe whose value
// moved, so a build's own before and after sit side by side.
//
// The drivers do not assert these limits (the text cap in news-extract, table
// cells in fee-schedule and formula-repair, the confirm dead end in
// registrar-purge, the missing response body in body-only-ref): each driver
// holds either way, so a tool change shows up here as CHANGED rather than as a
// red gate.
//
// Exit status is 1 when any probe CHANGED or failed to run on any build.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { devtoolsMcpInfo, downloadPrefs, PINNED_PREFS, prefArgs } from '../mcp-stdio.mjs';
import { page, probeServer, sleep, surface } from './lib.mjs';

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
const only = flag('only') ? new Set(flag('only').split(',')) : null;

// The cap probes' strings run past 3000 characters, longer than any cap a build
// is likely to set, so a raised cap measures as itself rather than as the
// string's length. Each <p> carries an id, which keeps the walker from dropping
// it as a long paragraph (the long-paragraph probe).
const LONG = 'Your price for this item is $274.50 after the loyalty discount. '.repeat(48).trim();
const WALKER = 'Terms of carriage, section four. '.repeat(92).trim();
const HREF = `/catalogue/${'outdoor-tents-four-season-summit-2p/'.repeat(84)}`;
const PARAGRAPH = 'Filler sentence about the account terms. '.repeat(13) + 'NEEDLE-LONGP-5519';

const probe = await probeServer({
  '/text': page('Text', `<p id="p">${LONG}</p><button aria-label="${LONG}">b</button>`),
  '/walker': page('Walker', `<p id="w">${WALKER}</p>`),
  '/paragraph': page('Paragraph', `<p>${PARAGRAPH}</p>`),
  '/href': page('Href', `<a href="${HREF}">Summit tent</a>`),
  '/depth': page(
    'Depth',
    `${'<div class="d">'.repeat(14)}<button>deep-button</button>${'</div>'.repeat(14)}<button>shallow-button</button>`
  ),
  '/nodes': page('Nodes', Array.from({ length: 1500 }, (_, i) => `<button>n${i}</button>`).join('')),
  '/lines': page('Lines', Array.from({ length: 700 }, (_, i) => `<button>L${i}</button>`).join('')),
  '/table': page('Table', '<table><tr><th>Form</th><td>cell-value-4471</td></tr></table>'),
  '/empty': page('Empty', '<ul><li>alpha</li><li></li><li>gamma</li></ul>'),
  '/inline': page('Inline', '<p>Your total is <strong>$274.50</strong> today</p>'),
  '/shadow': page(
    'Shadow',
    `<div id="host"></div><script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button>inside-shadow</button>';</script>`
  ),
  '/iframe': page('Frame', '<iframe title="Inner" src="/iframe-inner"></iframe>'),
  '/iframe-inner': page('Inner', '<button>frame-button</button>'),
  '/label': page('Label', '<label>Wrapped email <input id="a"></label> <label for="b">For email</label> <input id="b">'),
  '/checkbox': page(
    'Checkbox',
    '<input id="c" type="checkbox" checked aria-label="Newsletter"> <input id="u" type="checkbox" aria-label="Offers">'
  ),
  '/select': page(
    'Select',
    '<label for="s">Plan</label> <select id="s"><option>Basic</option><option>Pro annual</option><option>Pro monthly</option></select>'
  ),
  '/confirm': page('Confirm', `<button onclick="document.body.dataset.r = String(confirm('Delete?'))">Delete</button>`),
  '/alert': page('Alert', `<button onclick="alert('hi'); document.body.dataset.r = 'after-alert'">Alert</button>`),
  '/prompt': page('Prompt', `<button onclick="document.body.dataset.r = String(prompt('Name?'))">Prompt</button>`),
  '/dnd': page(
    'Drag',
    `<div id="src" draggable="true" role="button" aria-label="src">drag me</div>
     <div id="dst" role="region" aria-label="dst" style="width:200px;height:100px">drop here</div>
     <script>window.__log = []; dst.addEventListener('dragover', (e) => e.preventDefault());
     dst.addEventListener('drop', (e) => { e.preventDefault(); __log.push('drop@' + e.clientX + ',' + e.clientY); });</script>`
  ),
  '/pointerdrag': page(
    'Pointer drag',
    `<div id="src" role="button" aria-label="src" style="width:80px;height:40px;background:#ccc">drag me</div>
     <div id="dst" role="region" aria-label="dst" style="width:200px;height:100px;margin-top:40px;background:#eee">drop here</div>
     <script>let down = false; window.__log = [];
     src.addEventListener('pointerdown', () => { down = true; });
     document.addEventListener('pointerup', (e) => { if (down && dst.contains(document.elementFromPoint(e.clientX, e.clientY))) __log.push('dropped'); down = false; });</script>`
  ),
  '/inputs': page(
    'Inputs',
    '<label for="d">Date</label> <input id="d" type="date"> <label for="r">Range</label> <input id="r" type="range" min="0" max="100" value="10">'
  ),
  '/net': page('Network', `<p>net</p><script>
    fetch('/api/body').then((r) => r.text());
    const x = new XMLHttpRequest(); x.open('GET', '/api/xhr'); x.send();</script>`),
  '/api/body': (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"secret":"BODY-ONLY-7731"}');
  },
  '/api/xhr': (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  },
  '/cards': page(
    'Cards',
    [1, 2, 3]
      .map((n) => `<section aria-label="Card ${n}"><h2>Card ${n}</h2><button data-testid="add" onclick="document.body.dataset.r = 'card-${n}'">Add</button></section>`)
      .join('')
  ),
  '/hover': page('Hover', `<button onmouseover="document.body.dataset.r = 'hovered'">Hover me</button>`),
  // pointer-drag's desk: every move empties the list and builds it again.
  '/rerender': page(
    'Re-render',
    `<ul id="list"></ul><script>
     let order = ['ALPHA', 'BRAVO', 'CHARLIE'];
     const list = document.getElementById('list');
     function render() {
       list.textContent = '';
       order.forEach((name, i) => {
         const li = document.createElement('li');
         const up = document.createElement('button');
         up.textContent = 'Up';
         up.setAttribute('aria-label', 'Move up ' + name);
         up.onclick = () => { if (i) { order.splice(i - 1, 0, order.splice(i, 1)[0]); render(); } };
         const more = document.createElement('button');
         more.textContent = 'More';
         more.setAttribute('aria-label', 'More actions for ' + name);
         more.onclick = () => { document.body.dataset.r = 'menu-' + name; };
         li.append(name, up, more);
         list.append(li);
       });
     }
     render();</script>`
  ),
  '/link': page('Link', '<a href="/landed">Go to landing</a>'),
  '/landed': page('Landed', '<h1>landed-page</h1>'),
  // Sets a cookie that outlives a browser restart, so a later load shows
  // whether the browser kept its profile.
  '/keep': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': 'keep=1; Path=/; Max-Age=3600' });
    res.end(page('Keep', '<p>keep</p><a href="/attach">get the file</a>'));
  },
  '/attach': (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="probe.bin"' });
    res.end('probe');
  },
  // Says it is leaving, the way a page that saves on leave sends its draft.
  '/leave': page('Leave', `<p>leave</p><script>addEventListener('pagehide', () => navigator.sendBeacon('/left', 'pagehide'));</script>`),
  '/left': (req, res) => {
    res.writeHead(204);
    res.end();
  },
  '/console': page('Console', `<p>console</p><script>function inner() { throw new Error('boom-8812'); } setTimeout(() => inner(), 10);</script>`),
});

// Each probe: the behaviour as the docs state it for 0.10.3, a measurement
// against its probe page, and whether the measurement still shows that
// behaviour. `holds` returning null marks a probe that only measures.
const count = (s, re) => (s.match(re) ?? []).length;
// How much of a `source`-character string a snapshot showed: `whole` means no
// cap applied at all.
const cut = (shown, source) => {
  const kept = shown?.replace(/\.\.\.$/, '').length ?? null;
  return { source, kept, whole: kept === source, ellipsis: /\.\.\.$/.test(shown ?? '') };
};
const PROBES = [
  {
    id: 'text-cap',
    claim: 'about 27 characters of a text node survive, then "..."',
    async measure({ go, snap }) {
      await go('/text');
      return cut((await snap()).match(/p text="([^"]*)"/)?.[1] ?? null, LONG.length);
    },
    holds: (v) => v.kept === 27 && v.ellipsis,
  },
  {
    id: 'name-cap',
    claim: 'an accessible name takes the same 27-character cut',
    async measure({ go, snap }) {
      await go('/text');
      return cut((await snap()).match(/button "([^"]*)"/)?.[1] ?? null, LONG.length);
    },
    holds: (v) => v.kept === 27 && v.ellipsis,
  },
  {
    id: 'href-cap',
    claim: 'an href is absolutized and then cut at 27 characters',
    async measure({ go, snap }) {
      await go('/href');
      const href = (await snap()).match(/href="([^"]*)"/)?.[1] ?? null;
      return { absolute: /^http:/.test(href ?? ''), ...cut(href, (probe.url + HREF).length) };
    },
    holds: (v) => v.absolute && v.kept === 27 && v.ellipsis,
  },
  {
    id: 'walker-text-cap',
    claim: 'the walker keeps at most 100 characters of a text node, whatever the formatter allows',
    async measure({ go, snap, evaluate }) {
      await go('/walker');
      const shown = (await snap()).match(/p text="([^"]*)"/)?.[1] ?? null;
      // The formatter cuts shorter than the walker on 0.9.15 and 0.10.3, so the snapshot
      // text cannot show the walker's cap. take_snapshot leaves the walker on
      // the page as window.__createSnapshot, and its own tree can.
      const walker = await evaluate(() => {
        const tree = window.__createSnapshot?.('probe', {})?.tree;
        const find = (n) => (n?.tag === 'p' ? n : (n?.children ?? []).map(find).find(Boolean));
        return tree ? (find(tree)?.text?.length ?? null) : null;
      });
      return { walker: typeof walker === 'number' ? walker : null, shown: cut(shown, WALKER.length) };
    },
    // Without the page global the walker's cap is not observable: measure only.
    holds: (v) => (v.walker === null ? null : v.walker <= 100),
  },
  {
    id: 'long-paragraph',
    claim: 'a plain <p> with 500 or more characters of its own text is dropped from the snapshot',
    async measure({ go, snap }) {
      await go('/paragraph');
      const s = await snap();
      return { present: /Filler sentence/.test(s) };
    },
    holds: (v) => !v.present,
  },
  {
    id: 'depth-cap',
    claim: 'the walker stops at depth 10 and flags the tree as truncated without saying where',
    async measure({ go, snap }) {
      await go('/depth');
      const s = await snap();
      return { deep: s.includes('deep-button'), shallow: s.includes('shallow-button'), flagged: s.includes('[DOM truncated]') };
    },
    holds: (v) => !v.deep && v.shallow && v.flagged,
  },
  {
    id: 'node-cap',
    claim: 'the walker bails past 1000 nodes',
    async measure({ go, call, scratch }) {
      await go('/nodes');
      // A relative path lands in the server's cwd, the scratch dir surface()
      // removes on close. `true` would leave a file under
      // ~/.firefox-devtools-mcp/output/, and both builds refuse an absolute path
      // outside ~/.firefox-devtools-mcp (0.10.3 outside its output/).
      const saved = await call('take_snapshot', { saveTo: 'node-cap-snapshot.txt' });
      const path = saved.match(/saved to:?\s*(\S+)/i)?.[1];
      const full = path ? readFileSync(resolve(scratch, path), 'utf8') : saved;
      const buttons = [...full.matchAll(/button "n(\d+)"/g)];
      return { nodes: buttons.length, last: buttons.at(-1)?.[1] ?? null, flagged: /\[DOM truncated\]/.test(full + saved) };
    },
    holds: (v) => v.nodes <= 1000 && v.flagged,
  },
  {
    id: 'line-window',
    claim: 'a snapshot shows 100 lines by default and at most 500 whatever maxLines asks',
    async measure({ go, snap }) {
      await go('/lines');
      const d = await snap();
      const big = await snap({ maxLines: 2000 });
      return { defaultLines: count(d, /button "L\d+"/g), maxLines2000: count(big, /button "L\d+"/g) };
    },
    holds: (v) => v.defaultLines <= 100 && v.maxLines2000 <= 500,
  },
  {
    id: 'table-cells',
    claim: 'table cell text does not reach the default snapshot (includeAll shows it)',
    async measure({ go, snap }) {
      await go('/table');
      return {
        default: (await snap()).includes('cell-value-4471'),
        includeAll: (await snap({ includeAll: true })).includes('cell-value-4471'),
      };
    },
    holds: (v) => !v.default,
  },
  {
    id: 'empty-element',
    claim: 'an empty element contributes no snapshot node, so a list closes up around it',
    async measure({ go, snap }) {
      await go('/empty');
      return { li: count(await snap(), /\bli\b/g) };
    },
    holds: (v) => v.li === 2,
  },
  {
    id: 'inline-text',
    claim: "an inline child's text (<strong>) is dropped from its parent's text",
    async measure({ go, snap }) {
      await go('/inline');
      const s = await snap();
      return { present: s.includes('274.50'), parent: s.match(/p text="([^"]*)"/)?.[1] ?? null };
    },
    holds: (v) => !v.present,
  },
  {
    id: 'shadow-root',
    claim: 'the walker never descends into shadow roots',
    async measure({ go, snap }) {
      await go('/shadow');
      await sleep(100);
      return { present: (await snap()).includes('inside-shadow') };
    },
    holds: (v) => !v.present,
  },
  {
    id: 'iframe-same-origin',
    claim: 'a same-origin frame is walked only under includeAll (0.9.15 walked it in the default snapshot)',
    async measure({ go, snap }) {
      await go('/iframe');
      await sleep(300);
      return { present: (await snap()).includes('frame-button'), includeAll: (await snap({ includeAll: true })).includes('frame-button') };
    },
    holds: (v) => !v.present && v.includeAll,
  },
  {
    id: 'wrapping-label',
    claim: 'a wrapping <label> does not name its input; label[for] does',
    async measure({ go, snap }) {
      await go('/label');
      const inputs = (await snap()).split('\n').filter((l) => / input/.test(l)).map((l) => l.replace(/uid=\S+ /, '').trim());
      return { inputs };
    },
    holds: (v) => !v.inputs.some((l) => /Wrapped email/.test(l)) && v.inputs.some((l) => /For email/.test(l)),
  },
  {
    id: 'checkbox-state',
    claim: 'a checked and an unchecked checkbox read the same in the default snapshot',
    async measure({ go, snap }) {
      await go('/checkbox');
      const line = (s, name) => s.split('\n').find((l) => l.includes(`"${name}"`))?.replace(/uid=\S+ /, '').replace(name, '').trim();
      const s = await snap();
      return { checked: line(s, 'Newsletter'), unchecked: line(s, 'Offers') };
    },
    holds: (v) => v.checked != null && v.checked === v.unchecked,
  },
  {
    id: 'select-options',
    claim: "a select's options do not reach the default snapshot",
    async measure({ go, snap }) {
      await go('/select');
      return { present: /Pro annual/.test(await snap()) };
    },
    holds: (v) => !v.present,
  },
  {
    id: 'confirm-auto-dismiss',
    claim: 'window.confirm() is dismissed before the click returns (it returns false) and accept_dialog finds nothing',
    async measure({ go, snap, call, evaluate, uid }) {
      await go('/confirm');
      const click = await call('click_by_uid', { uid: uid(await snap(), /button "Delete"/) });
      const returned = await evaluate(() => document.body.dataset.r ?? null);
      const accept = await call('accept_dialog', {});
      await call('dismiss_dialog', {});
      return { clickError: click.startsWith('ERROR'), returned, acceptError: accept.startsWith('ERROR') };
    },
    holds: (v) => v.returned === 'false' && v.acceptError,
  },
  {
    id: 'alert-auto-dismiss',
    claim: 'alert() does not block the click that raised it',
    async measure({ go, snap, call, evaluate, uid }) {
      await go('/alert');
      const click = await call('click_by_uid', { uid: uid(await snap(), /button "Alert"/) });
      const after = await evaluate(() => document.body.dataset.r ?? null);
      await call('dismiss_dialog', {});
      return { clickError: click.startsWith('ERROR'), after };
    },
    holds: (v) => v.after === 'after-alert',
  },
  {
    id: 'prompt-auto-dismiss',
    claim: 'prompt() is dismissed at once and returns null',
    async measure({ go, snap, call, evaluate, uid }) {
      await go('/prompt');
      await call('click_by_uid', { uid: uid(await snap(), /button "Prompt"/) });
      const returned = await evaluate(() => document.body.dataset.r ?? null);
      await call('dismiss_dialog', {});
      return { returned };
    },
    holds: (v) => v.returned === 'null',
  },
  {
    id: 'drag-html5',
    claim: 'drag_by_uid_to_uid fires an HTML5 drop, at clientX/Y 0',
    async measure({ go, snap, call, evaluate, uid }) {
      await go('/dnd');
      const s = await snap();
      const r = await call('drag_by_uid_to_uid', { fromUid: uid(s, /button "src"/), toUid: uid(s, /region "dst"/) });
      return { toolError: r.startsWith('ERROR'), drops: await evaluate(() => window.__log) };
    },
    holds: (v) => JSON.stringify(v.drops) === '["drop@0,0"]',
  },
  {
    id: 'drag-pointer',
    claim: 'drag_by_uid_to_uid reports success while a pointer-event drag never lands',
    async measure({ go, snap, call, evaluate, uid }) {
      await go('/pointerdrag');
      const s = await snap();
      const r = await call('drag_by_uid_to_uid', { fromUid: uid(s, /button "src"/), toUid: uid(s, /region "dst"/) });
      return { toolError: r.startsWith('ERROR'), landed: await evaluate(() => window.__log) };
    },
    holds: (v) => !v.toolError && Array.isArray(v.landed) && v.landed.length === 0,
  },
  {
    id: 'fill-range',
    claim: 'fill_by_uid on type=range does not land the value asked for',
    async measure({ go, snap, call, evaluate, uid }) {
      await go('/inputs');
      const r = await call('fill_by_uid', { uid: uid(await snap(), /input "Range"/), value: '75' });
      return { toolError: r.startsWith('ERROR'), value: await evaluate(() => document.getElementById('r').value) };
    },
    holds: (v) => v.value !== '75',
  },
  {
    id: 'fill-date',
    claim: 'fill_by_uid on type=date takes an ISO value',
    async measure({ go, snap, call, evaluate, uid }) {
      await go('/inputs');
      const r = await call('fill_by_uid', { uid: uid(await snap(), /input "Date"/), value: '2026-09-19' });
      return { toolError: r.startsWith('ERROR'), value: await evaluate(() => document.getElementById('d').value) };
    },
    holds: (v) => v.value === '2026-09-19',
  },
  {
    id: 'viewport-clamp',
    claim: 'set_viewport_size sizes the window and clamps a narrow one to about 500 px',
    async measure({ call, evaluate, go }) {
      await go('/text');
      const inner = {};
      for (const width of [480, 320]) {
        await call('set_viewport_size', { width, height: 768 });
        inner[width] = await evaluate(() => window.innerWidth);
      }
      await call('set_viewport_size', { width: 1366, height: 768 });
      return inner;
    },
    holds: (v) => v[480] >= 490 && v[320] >= 490,
  },
  {
    id: 'is-xhr',
    claim: 'list_network_requests with isXHR true matches a fetch and an XHR (0.9.15 matched neither)',
    async measure({ go, call }) {
      await go('/net');
      await sleep(400);
      const all = await call('list_network_requests', {});
      const xhr = await call('list_network_requests', { isXHR: true });
      return { listed: count(all, /\/api\/(?:body|xhr)/g), isXHR: count(xhr, /\/api\/(?:body|xhr)/g) };
    },
    holds: (v) => v.listed >= 2 && v.isXHR === v.listed,
  },
  {
    id: 'network-body',
    claim: 'get_network_request returns the response body (0.9.15 returned none)',
    async measure({ go, call }) {
      await go('/net');
      await sleep(400);
      const list = await call('list_network_requests', {});
      // Each line reads "<id> | GET <url> [<status>]".
      const line = list.split('\n').find((l) => l.includes('/api/body')) ?? '';
      const id = line.includes(' | ') ? line.split(' | ')[0].trim() : null;
      const detail = id ? await call('get_network_request', { id }) : '';
      return { found: id != null && !detail.startsWith('ERROR'), body: /BODY-ONLY-7731/.test(list + detail) };
    },
    holds: (v) => v.found && v.body,
  },
  {
    id: 'evaluate-timeout',
    claim: 'evaluate_script times out at 5 s by default, and at 10 s whatever timeout it is given',
    async measure({ go, call }) {
      await go('/text');
      // Both at once, so the probe costs one wait rather than two.
      const timed = async (fnArgs) => {
        const started = performance.now();
        const r = await call('evaluate_script', fnArgs);
        return { error: r.startsWith('ERROR') || r.startsWith('THROW'), s: Math.round((performance.now() - started) / 100) / 10 };
      };
      const [byDefault, asked20s] = await Promise.all([
        timed({ function: '() => new Promise((r) => setTimeout(() => r("slow"), 5600))' }),
        timed({ function: '() => new Promise((r) => setTimeout(() => r("slow"), 11500))', timeout: 20000 }),
      ]);
      return { byDefault, asked20s };
    },
    holds: (v) => v.byDefault.error && v.byDefault.s < 5.6 && v.asked20s.error && v.asked20s.s < 11.5,
  },
  {
    id: 'uid-repeated-selector',
    claim: 'a uid resolves to its own node, so the third of three same-data-testid buttons clicks the third (0.9.15 resolved it by CSS path and clicked the first)',
    async measure({ go, snap, call, evaluate }) {
      await go('/cards');
      const uids = [...(await snap()).matchAll(/uid=(\S+) button "Add"/g)].map((m) => m[1]);
      await call('click_by_uid', { uid: uids[2] });
      return { buttons: uids.length, clicked: await evaluate(() => document.body.dataset.r ?? null) };
    },
    holds: (v) => v.buttons === 3 && v.clicked === 'card-3',
  },
  {
    id: 'stale-uid',
    claim: 'a uid still works after a later take_snapshot (0.9.15 invalidated every uid of the snapshot before)',
    async measure({ go, snap, call, evaluate, uid }) {
      await go('/hover');
      const before = uid(await snap(), /button "Hover me"/);
      await snap();
      const r = await call('hover_by_uid', { uid: before });
      return { error: r.startsWith('ERROR'), hovered: (await evaluate(() => document.body.dataset.r ?? null)) === 'hovered' };
    },
    holds: (v) => !v.error && v.hovered,
  },
  {
    // pointer-drag, Haiku fdm r1: click_by_uid 30_91, "More actions for
    // CABLE" in snapshot 30, opened DREDGING's menu once a move had rebuilt
    // the list, and stale_uid stayed 0.
    id: 'uid-after-rerender',
    claim: "a uid whose node a re-render replaced replies stale (0.9.15 clicked whatever element held its place in the rebuilt list, and replied success)",
    async measure({ go, snap, call, evaluate, uid }) {
      await go('/rerender');
      const s = await snap();
      await call('click_by_uid', { uid: uid(s, /button "Move up CHARLIE"/) });
      const order = await evaluate(() => [...document.querySelectorAll('#list li')].map((li) => li.firstChild.textContent));
      const r = await call('click_by_uid', { uid: uid(s, /button "More actions for CHARLIE"/) });
      return { order, reply: r.slice(0, 60), error: r.startsWith('ERROR'), clicked: await evaluate(() => document.body.dataset.r ?? null) };
    },
    holds: (v) => v.error && v.clicked === null,
  },
  {
    id: 'click-reply',
    claim: 'a click replies with its uid alone: no URL, title or dialog state',
    async measure({ go, snap, call, uid }) {
      await go('/link');
      const reply = await call('click_by_uid', { uid: uid(await snap(), /(?:link|a) "Go to landing"/) });
      return { reply: reply.slice(0, 60), chars: reply.length };
    },
    holds: (v) => /^click \S+$/.test(v.reply),
  },
  {
    id: 'click-navigation',
    claim: 'click_by_uid on a link can return before the navigation lands',
    async measure({ go, snap, call, evaluate, uid }) {
      let landed = 0;
      for (let i = 0; i < 5; i++) {
        await go('/link');
        await call('click_by_uid', { uid: uid(await snap(), /(?:link|a) "Go to landing"/) });
        if ((await evaluate(() => location.pathname)) === '/landed') landed++;
      }
      return { landedByNextCall: `${landed}/5` };
    },
    holds: () => null,
  },
  {
    id: 'console-stack',
    claim: 'an uncaught error reaches the console list without its stack',
    async measure({ go, call }) {
      await go('/console');
      await sleep(300);
      const list = await call('list_console_messages', {});
      return { message: list.includes('boom-8812'), frame: /\binner\b/.test(list) };
    },
    holds: (v) => v.message && !v.frame,
  },
  {
    // Its own browser, launched as a headless paid attempt launches one: the
    // attempt's user-agent tag, window size and download directory, and no
    // --profile-path.
    id: 'close-relaunch',
    claim:
      'close_firefox_session closes the browser it launched, and the next call launches another from the same flags ' +
      '(user agent, window size, download directory) in a fresh profile when the server has no --profile-path (0.9.15 has no such tool)',
    async measure() {
      const tag = 'zoo-probe-close';
      const s = await surface('devtools', {
        args: (scratch) => [
          '--viewport',
          '1366x768',
          ...prefArgs({ ...PINNED_PREFS, ...downloadPrefs(join(scratch, 'downloads')), 'general.useragent.override': `Mozilla/5.0 ${tag}` }),
        ],
      });
      try {
        const browser = () => s.evaluate(() => [navigator.userAgent, innerWidth, innerHeight].join(' '));
        const cookie = () => probe.requests.filter((r) => r.path === '/keep').at(-1)?.headers.cookie ?? null;
        const download = async () => {
          await s.navigate(probe.url + '/keep');
          await s.call('click_by_uid', { uid: s.target(await s.snapshot(), /(?:link|a) "get the file"/) });
          await sleep(1500);
          try {
            return readdirSync(join(s.scratch, 'downloads')).filter((f) => !f.endsWith('.part')).length;
          } catch {
            return 0;
          }
        };
        await s.navigate(probe.url + '/keep');
        await s.navigate(probe.url + '/keep');
        await s.evaluate(() => {
          localStorage.setItem('keep', '1');
          return 1;
        });
        const cookieBefore = cookie();
        const before = await browser();
        const downloadsBefore = await download();
        const reply = await s.call('close_firefox_session', {});
        const t0 = performance.now();
        await s.navigate(probe.url + '/keep');
        const relaunchS = Math.round((performance.now() - t0) / 100) / 10;
        const cookieAfter = cookie();
        const storedAfter = await s.evaluate(() => localStorage.getItem('keep'));
        const after = await browser();
        return {
          reply: reply.slice(0, 60),
          tagged: before.includes(tag) && after.includes(tag),
          sameWindow: after === before,
          cookieBefore,
          cookieAfter,
          storedAfter,
          downloads: `${downloadsBefore} then ${await download()}`,
          relaunchS,
        };
      } finally {
        await s.close();
      }
    },
    holds: (v) =>
      /^Closed/.test(v.reply) && v.tagged && v.sameWindow && v.cookieBefore === 'keep=1' && v.cookieAfter === null &&
      v.storedAfter === null && v.downloads === '1 then 2',
  },
  {
    id: 'close-pagehide',
    claim:
      "close_firefox_session fires the open page's pagehide handlers, as the server's own shutdown on its client closing does (0.9.15 has no such tool)",
    async measure() {
      const s = await surface('devtools');
      const left = () => probe.requests.filter((r) => r.path === '/left').length;
      let onShutdown = null;
      let reply;
      let onClose;
      try {
        await s.navigate(probe.url + '/leave');
        await sleep(300);
        const n0 = left();
        reply = await s.call('close_firefox_session', {});
        await sleep(1500);
        onClose = left() - n0;
        await s.navigate(probe.url + '/leave');
        await sleep(300);
      } finally {
        const n1 = left();
        await s.close();
        await sleep(1500);
        onShutdown = left() - n1;
      }
      return { reply: reply.slice(0, 40), onClose, onShutdown };
    },
    holds: (v) => /^Closed/.test(v.reply) && v.onClose === 1 && v.onShutdown === 1,
  },
];

async function runBuild(build) {
  if (build.root) process.env.FIREFOX_DEVTOOLS_MCP = build.root;
  else delete process.env.FIREFOX_DEVTOOLS_MCP;
  const s = await surface('devtools');
  const info = devtoolsMcpInfo();
  const firefox = await s.firefox();
  const call = async (tool, toolArgs) => s.call(tool, toolArgs);
  const ctx = {
    call,
    scratch: s.scratch,
    go: (path) => s.navigate(probe.url + path),
    snap: (opts) => s.snapshot(opts),
    evaluate: (fn) => s.evaluate(fn),
    uid: (snap, re) => s.target(snap, re),
  };
  const results = {};
  const started = performance.now();
  for (const p of PROBES) {
    if (only && !only.has(p.id)) continue;
    const t0 = performance.now();
    try {
      const value = await p.measure(ctx);
      const holds = p.holds(value);
      results[p.id] = { status: holds === null ? 'MEASURE' : holds ? 'HOLDS' : 'CHANGED', value };
    } catch (error) {
      results[p.id] = { status: 'ERROR', value: String(error.message).slice(0, 160) };
    }
    results[p.id].ms = Math.round(performance.now() - t0);
  }
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  await s.close();
  const { binary, buildID } = s.browser ?? {};
  return { label: build.label, root: build.root, version: info.version, source: info.source, firefox, binary, buildID, seconds, results };
}

const runs = [];
for (const build of builds) runs.push(await runBuild(build));
await probe.close();

const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
console.log(
  `firefox-devtools-mcp probes\nrunning on: ${runs
    .map((r) => `${r.label} = ${r.version} (${r.source}${r.root ? ` ${r.root}` : ''}, Firefox ${r.firefox}), ${r.seconds}s`)
    .join('; ')}\n`
);
for (const p of PROBES) {
  if (only && !only.has(p.id)) continue;
  const cells = runs.map((r) => r.results[p.id]);
  if (runs.length === 1) {
    console.log(`${cells[0].status.padEnd(8)}${p.id.padEnd(23)}${p.claim}\n${''.padEnd(31)}measured: ${show(cells[0].value)}`);
  } else {
    console.log(`${p.id.padEnd(23)}${p.claim}`);
    runs.forEach((r, i) => console.log(`${''.padEnd(4)}${r.label.padEnd(12)}${cells[i].status.padEnd(8)}${show(cells[i].value)}`));
  }
}

const baselinePath = flag('compare');
if (baselinePath) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const base = baseline.builds[0];
  console.log(`\nagainst ${baselinePath} (${base.label} = ${base.version}, ${base.source}, Firefox ${base.firefox} ${base.buildID ?? ''}):`);
  for (const r of runs) {
    if (r.firefox !== base.firefox || (base.buildID && r.buildID !== base.buildID)) {
      console.log(`  ${r.label} ran Firefox ${r.firefox} ${r.buildID ?? ''}, the baseline Firefox ${base.firefox} ${base.buildID ?? ''}, so a move below may be the browser's`);
    }
    const moved = PROBES.filter((p) => r.results[p.id] && base.results[p.id])
      .filter((p) => show(r.results[p.id].value) !== show(base.results[p.id].value) || r.results[p.id].status !== base.results[p.id].status)
      .map((p) => `  ${r.label} ${p.id}: ${base.results[p.id].status} ${show(base.results[p.id].value)} -> ${r.results[p.id].status} ${show(r.results[p.id].value)}`);
    console.log(moved.length ? moved.join('\n') : `  ${r.label}: every probe measured the same`);
  }
}

const out = flag('out');
if (out) {
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), builds: runs, claims: Object.fromEntries(PROBES.map((p) => [p.id, p.claim])) }, null, 1) + '\n');
  console.log(`\nwrote ${out}`);
}
const tally = runs.flatMap((r) => Object.values(r.results).map((x) => x.status));
console.log(
  `\n${tally.length} probe results: ${['HOLDS', 'CHANGED', 'MEASURE', 'ERROR']
    .map((k) => `${tally.filter((t) => t === k).length} ${k.toLowerCase()}`)
    .join(', ')}`
);
process.exitCode = tally.some((t) => t === 'CHANGED' || t === 'ERROR') ? 1 : 0;
