// Probes pointer input: drag on a pointer-event sortable list and on HTML5 draggable, hover and a hover-intent menu, right-click and Shift-click; measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).

import { findings, page, probeServer, surface } from './lib.mjs';

const ROWS = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
const probe = await probeServer({
  // A dnd-kit style sensor: pointerdown, then a drag only once the pointer
  // has moved 6px, then a drop on pointerup. No HTML5 draggable anywhere.
  '/sort': page(
    'Running order',
    `<ul id="list" style="list-style:none;padding:0">${ROWS.map(
      (n) => `<li id="i-${n}" style="padding:14px;margin:4px;border:1px solid #888;user-select:none">${n}</li>`
    ).join('')}</ul>
     <div id="h5" draggable="true" style="padding:10px;border:1px solid red">Card</div>
     <div id="h5dst" style="padding:20px;border:1px solid blue">Done column</div>
     <script>
       const list = document.getElementById('list');
       let drag = null, moved = 0, x0 = 0, y0 = 0;
       list.addEventListener('pointerdown', (e) => { drag = e.target.closest('li'); x0 = e.clientX; y0 = e.clientY; moved = 0; });
       document.addEventListener('pointermove', (e) => { if (drag) moved = Math.max(moved, Math.hypot(e.clientX - x0, e.clientY - y0)); });
       document.addEventListener('pointerup', (e) => {
         if (!drag) return;
         const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('li');
         if (moved >= 6 && over && over !== drag) list.insertBefore(drag, over.nextSibling);
         window.maxMove = moved;
         drag = null;
       });
       const h5 = document.getElementById('h5');
       h5.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'card'));
       const dst = document.getElementById('h5dst');
       dst.addEventListener('dragover', (e) => e.preventDefault());
       dst.addEventListener('drop', (e) => { e.preventDefault(); dst.textContent = 'dropped'; });
     </script>`
  ),
  '/hover': page(
    'Services',
    `<nav><a id="menu" href="#products">Products</a><div id="fly" hidden><a href="/deep">Cold-chain monitoring</a></div></nav>
     <p>Owners: <a id="user" href="/people/marra">@marra</a></p><div id="card" role="dialog" hidden></div>
     <script>
       const menu = document.getElementById('menu'), fly = document.getElementById('fly');
       let t;
       menu.addEventListener('mouseenter', () => { t = setTimeout(() => { fly.hidden = false; }, 250); });
       menu.addEventListener('mouseleave', () => clearTimeout(t));
       document.getElementById('user').addEventListener('mouseenter', () => {
         const card = document.getElementById('card');
         card.hidden = false;
         card.textContent = 'On call until 18:40, pager HX-4471';
       });
     </script>`
  ),
  '/files': page(
    'Scans',
    `<ul id="files">${[1, 2, 3, 4, 5, 6].map((n) => `<li id="f${n}"><button id="b${n}">scan-00${n}.tif</button></li>`).join('')}</ul>
     <div id="menu" popover>Apply label...</div><div id="plain" hidden>Apply label...</div>
     <script>
       const files = document.getElementById('files');
       files.addEventListener('contextmenu', (e) => {
         e.preventDefault();
         document.getElementById('menu').showPopover();
         document.getElementById('plain').hidden = false;
       });
     </script>`
  ),
});
const log = findings('Pointer input per condition');
const kinds = (events) => [...new Set(events.map((e) => `${e.k}${e.d.trusted ? '' : '(untrusted)'}`))].sort();
const order = (s) => s.evaluate(() => [...document.querySelectorAll('#list li')].map((li) => li.textContent));

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/sort');
await pw.navigate(probe.url + '/sort');
await log.header(dt, pw);

for (const s of [dt, pw]) {
  const devtools = s.name === 'devtools';
  const drag = (snap, from, to) =>
    devtools
      ? s.call('drag_by_uid_to_uid', { fromUid: s.target(snap, from), toUid: s.target(snap, to) })
      : s.call('browser_drag', {
          startElement: String(from), startTarget: s.target(snap, from),
          endElement: String(to), endTarget: s.target(snap, to),
        });

  await s.navigate(probe.url + '/sort');
  let snap = await s.snapshot();
  await probe.drain();
  const result = await drag(snap, /Alpha/, /Delta/);
  const events = (await probe.drain()).filter((e) => !/^(pointermove|mouseover|mouseenter|pointerenter)$/.test(e.k));
  log.record(
    `${s.name} drag on a pointer-sensor list`,
    { toolError: /^(ERROR|THROW)/.test(result), events: kinds(events), order: await order(s), crossedThreshold: (await s.evaluate(() => window.maxMove ?? 0)) >= 6 },
    devtools
      ? { toolError: false, events: ['dragstart(untrusted)', 'drop(untrusted)'], order: ROWS, crossedThreshold: false }
      : { toolError: false, events: ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'], order: ['Bravo', 'Charlie', 'Delta', 'Alpha'], crossedThreshold: true }
  );

  await s.navigate(probe.url + '/sort');
  snap = await s.snapshot();
  await drag(snap, /Card/, /Done column/);
  log.record(`${s.name} drag on HTML5 draggable`, await s.evaluate(() => document.getElementById('h5dst').textContent), 'dropped');

  await s.navigate(probe.url + '/hover');
  snap = await s.snapshot();
  await probe.drain();
  const hover = (re) =>
    devtools
      ? s.call('hover_by_uid', { uid: s.target(snap, re) })
      : s.call('browser_hover', { element: String(re), target: s.target(snap, re) });
  await hover(/"Products"/);
  await probe.drain(700);
  log.record(`${s.name} hover opens a 250ms hover-intent menu`, await s.evaluate(() => !document.getElementById('fly').hidden), true);
  await hover(/"@marra"/);
  await probe.drain(300);
  const after = await s.snapshot();
  log.record(`${s.name} hovercard text in the next snapshot`, after.match(/On call[^"\n]*/)?.[0] ?? null,
    devtools ? 'On call until 18:40, pager ...' : 'On call until 18:40, pager HX-4471');

  if (devtools) continue;
  await s.navigate(probe.url + '/files');
  snap = await s.snapshot();
  await probe.drain();
  await s.call('browser_click', { element: 'scan 3', target: s.target(snap, /scan-003/), button: 'right' });
  const right = await probe.drain();
  // A popover=auto menu opened from contextmenu is closed again by the time
  // the right-click returns, while a menu the same handler un-hides stays
  // open, so a context-menu fixture must not rely on popover=auto.
  log.record('playwright right-click', {
    contextmenu: right.some((e) => e.k === 'contextmenu' && e.d.trusted),
    autoPopoverOpen: await s.evaluate(() => document.getElementById('menu').matches(':popover-open')),
    plainMenuOpen: await s.evaluate(() => !document.getElementById('plain').hidden),
  }, { contextmenu: true, autoPopoverOpen: false, plainMenuOpen: true });
  snap = await s.snapshot();
  await s.call('browser_click', { element: 'scan 5', target: s.target(snap, /scan-005/), modifiers: ['Shift'] });
  const shift = (await probe.drain()).find((e) => e.k === 'click');
  log.record('playwright Shift-click', { trusted: shift?.d.trusted, shift: shift?.d.shift }, { trusted: true, shift: true });
}

await dt.close();
await pw.close();
await probe.close();
log.done();
