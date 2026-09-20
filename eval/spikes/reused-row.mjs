// Probes a click on a list whose row nodes are re-rendered in place between
// snapshot and click: which row each condition's click acts on, what its result
// says, whether one unrelated tool call after the re-render changes that, and
// whether the honest routes (pause the updates, filter to one row, open the
// deploy's own page) land on the right row; measured on
// firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78
// (Firefox 152.0). One browser runs at a time.

import { findings, page, probeServer, sleep, surface } from './lib.mjs';

const ITEMS = ['build-4191 eu-west', 'build-4192 us-east', 'build-4193 eu-west', 'build-4194 ap-south'];
const cancelled = [];

// An index-keyed renderer: four row nodes whose contents rotate, the way a
// list re-sorted by ETA patches existing nodes. A page timer rather than a
// tool call does it, because any playwright tool call between the re-render
// and the click re-resolves every ref against the page as it now is; the
// `between` probe measures that. `keyed` re-creates the nodes instead, the
// renderer a keyed framework uses, for comparison.
const queue = ({ every, keyed = false }) =>
  page(
    'Deploy queue',
    `<button type="button" id="pause" aria-pressed="false">Pause live updates</button>
     <input id="filter" aria-label="Filter deploys" placeholder="Filter">
     <ul id="q"></ul><p id="toast" role="status"></p>
     <script>
       const items = ${JSON.stringify(ITEMS)};
       const ul = document.getElementById('q');
       const row = () => {
         const li = document.createElement('li');
         li.innerHTML = '<span></span> <button>Cancel</button>';
         return li;
       };
       for (let i = 0; i < items.length; i++) ul.appendChild(row());
       function render() {
         if (${keyed}) ul.replaceChildren(...items.map(row));
         const words = document.getElementById('filter').value.trim().split(/\\s+/).filter(Boolean);
         const shown = items.filter((b) => words.every((w) => b.includes(w)));
         [...ul.children].forEach((li, i) => {
           const b = shown[i];
           li.hidden = !b;
           if (!b) return;
           li.firstChild.textContent = b;
           const btn = li.querySelector('button');
           btn.onclick = () => {
             fetch('/cancel?b=' + encodeURIComponent(b));
             document.getElementById('toast').textContent = 'Cancelled ' + b;
           };
           btn.setAttribute('aria-label', 'Cancel ' + b);
         });
       }
       render();
       document.getElementById('filter').addEventListener('input', render);
       let paused = false;
       document.getElementById('pause').onclick = (e) => {
         paused = !paused;
         e.target.setAttribute('aria-pressed', String(paused));
       };
       const tick = () => {
         if (paused) return;
         items.push(items.shift());
         render();
       };
       ${every ? `setInterval(tick, ${every});` : 'setTimeout(tick, 1500);'}
     </script>`
  );

const probe = await probeServer({
  '/queue': queue({}),
  '/keyed': queue({ keyed: true }),
  '/live': queue({ every: 700 }),
  '/deploy': page(
    'Deploy build-4193 eu-west',
    `<h1>build-4193 eu-west</h1><button id="c">Cancel deploy</button>
     <script>document.getElementById('c').onclick = () => fetch('/cancel?b=' + encodeURIComponent('build-4193 eu-west'));</script>`
  ),
  '/cancel': (req, res, body, url) => {
    cancelled.push(url.searchParams.get('b'));
    res.end('ok');
  },
});
const log = findings('Clicks on a re-rendered list per condition');

// The line of a click result that says what was clicked: devtools' whole
// reply, playwright's generated code line or its error line.
const echo = (s, result) =>
  s.name === 'devtools'
    ? result.split('\n')[0]
    : (result.match(/await page\.[^\n]*|Error: [^\n]*/)?.[0] ?? result.split('\n')[0]);

const EXPECTED = {
  devtools: {
    naive: { cancelled: ['build-4194 ap-south'], resultNamesHitRow: false, resultNamesTarget: false },
    keyed: { cancelled: ['build-4194 ap-south'], toolError: false },
    between: { cancelled: ['build-4194 ap-south'], toolError: false },
    pause: ['build-4193 eu-west'],
    filter: ['build-4193 eu-west'],
    detail: ['build-4193 eu-west'],
  },
  playwright: {
    naive: { cancelled: ['build-4194 ap-south'], resultNamesHitRow: true, resultNamesTarget: false },
    keyed: { cancelled: [], toolError: true },
    between: { cancelled: [], toolError: true },
    pause: ['build-4193 eu-west'],
    filter: ['build-4193 eu-west'],
    detail: ['build-4193 eu-west'],
  },
};
const replies = {};

for (const name of ['devtools', 'playwright']) {
  const s = await surface(name);
  const dt = name === 'devtools';
  const click = (uid, element) =>
    dt ? s.call('click_by_uid', { uid }) : s.call('browser_click', { element, target: uid });
  await s.navigate(probe.url + '/queue');
  await log.header(s);

  // One re-render between the snapshot that named the target and the click;
  // `between` also makes one unrelated tool call after the re-render.
  for (const [path, between] of [['/queue', false], ['/keyed', false], ['/queue', true]]) {
    await s.navigate(probe.url + path);
    const snap = await s.snapshot();
    if (/4194[\s\S]*4193/.test(snap)) throw new Error(`${name} snapshot came after the re-render; rerun on a quieter machine`);
    const target = s.target(snap, /"Cancel build-4193 eu-west"/);
    await sleep(2000);
    if (between && (await s.evaluate(() => 1)) !== 1) throw new Error(`${name} evaluate between the calls failed`);
    const result = await click(target, 'Cancel build-4193 eu-west');
    await sleep(300);
    const hit = cancelled.splice(0);
    if (between) {
      replies[`${name} between`] = echo(s, result);
      log.record(`${name} click after one in-place re-render and one unrelated tool call`, {
        cancelled: hit,
        toolError: /^(ERROR|THROW)/.test(result),
      }, EXPECTED[name].between);
    } else if (path === '/queue') {
      replies[name] = echo(s, result);
      log.record(`${name} click after one in-place re-render`, {
        cancelled: hit,
        resultNamesHitRow: new RegExp(`Cancel ${hit[0] ?? 'nothing'}`).test(echo(s, result)),
        resultNamesTarget: /Cancel build-4193/.test(echo(s, result)),
      }, EXPECTED[name].naive);
    } else {
      log.record(`${name} click after a keyed re-render that re-creates the nodes`, {
        cancelled: hit,
        toolError: /^(ERROR|THROW)/.test(result),
      }, EXPECTED[name].keyed);
    }
  }

  // Pause first, then read and click: the rows hold still through the wait.
  await s.navigate(probe.url + '/live');
  let snap = await s.snapshot();
  await click(s.target(snap, /Pause live updates/), 'Pause live updates');
  snap = await s.snapshot();
  await sleep(2000);
  await click(s.target(snap, /"Cancel build-4193 eu-west"/), 'Cancel build-4193 eu-west');
  await sleep(300);
  log.record(`${name} pause, read, wait, click`, cancelled.splice(0), EXPECTED[name].pause);

  // Filter to the one row: the rotation keeps running underneath, but the
  // only row shown keeps its occupant.
  await s.navigate(probe.url + '/live');
  snap = await s.snapshot();
  const filter = s.target(snap, /Filter deploys/);
  if (dt) await s.call('fill_by_uid', { uid: filter, value: '4193 eu-west' });
  else await s.call('browser_type', { element: 'Filter deploys', target: filter, text: '4193 eu-west' });
  snap = await s.snapshot();
  await sleep(2000);
  await click(s.target(snap, /"Cancel build-4193 eu-west"/), 'Cancel build-4193 eu-west');
  await sleep(300);
  log.record(`${name} filter to one row, wait, click`, cancelled.splice(0), EXPECTED[name].filter);

  await s.navigate(probe.url + '/deploy');
  snap = await s.snapshot();
  await click(s.target(snap, /Cancel deploy/), 'Cancel deploy');
  await sleep(300);
  log.record(`${name} cancel from the deploy's own page`, cancelled.splice(0), EXPECTED[name].detail);

  await s.close();
}

console.log(
  '\nclick replies after the re-render:\n' +
    Object.entries(replies).map(([k, v]) => `  ${k}: ${v}`).join('\n')
);
await probe.close();
log.done();
