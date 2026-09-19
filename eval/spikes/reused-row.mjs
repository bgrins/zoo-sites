// Probes a click on a list whose row nodes are re-rendered in place between snapshot and click: which row each condition's click acts on, and what its result says; measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).

import { findings, page, probeServer, sleep, surface } from './lib.mjs';

const cancelled = [];
const probe = await probeServer({
  // An index-keyed renderer: four row nodes whose contents rotate once, 1.5s
  // after load, the way a list re-sorted by ETA patches existing nodes. A
  // page timer rather than a tool call does it, because a playwright tool
  // call between snapshot and click re-resolves every ref.
  '/queue': page(
    'Deploy queue',
    `<ul id="q"></ul>
     <script>
       const items = ['build-4191 eu-west', 'build-4192 us-east', 'build-4193 eu-west', 'build-4194 ap-south'];
       const ul = document.getElementById('q');
       for (let i = 0; i < items.length; i++) {
         const li = document.createElement('li');
         li.innerHTML = '<span></span> <button>Cancel</button>';
         ul.appendChild(li);
       }
       function render() {
         [...ul.children].forEach((li, i) => {
           li.firstChild.textContent = items[i];
           const b = li.querySelector('button');
           b.onclick = () => fetch('/cancel?b=' + encodeURIComponent(items[i]));
           b.setAttribute('aria-label', 'Cancel ' + items[i]);
         });
       }
       render();
       setTimeout(() => { items.push(items.shift()); render(); }, 1500);
     </script>`
  ),
  '/cancel': (req, res, body, url) => {
    cancelled.push(url.searchParams.get('b'));
    res.end('ok');
  },
});
const log = findings('Clicks on a re-rendered list per condition');

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/queue');
await pw.navigate(probe.url + '/queue');
await log.header(dt, pw);

for (const s of [dt, pw]) {
  await s.navigate(probe.url + '/queue');
  const snap = await s.snapshot();
  if (/4194[\s\S]*4193/.test(snap)) throw new Error(`${s.name} snapshot came after the re-render; rerun on a quieter machine`);
  const target = s.target(snap, /"Cancel build-4193 eu-west"/);
  await sleep(2000);
  const result =
    s.name === 'devtools'
      ? await s.call('click_by_uid', { uid: target })
      : await s.call('browser_click', { element: 'Cancel build-4193', target });
  await sleep(300);
  log.record(`${s.name} click after one re-render`, {
    cancelled: cancelled.splice(0),
    resultNamesActualRow: /build-4194/.test(result),
  }, s.name === 'devtools'
    ? { cancelled: ['build-4194 ap-south'], resultNamesActualRow: false }
    : { cancelled: ['build-4194 ap-south'], resultNamesActualRow: true });
}

await dt.close();
await pw.close();
await probe.close();
log.done();
