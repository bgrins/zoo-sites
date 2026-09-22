// Probes multi-select input on a file list: plain, Shift and Ctrl or Cmd clicks, checkbox clicks, right-click, Shift+Arrow and Shift+F10 keys, a popover=manual context menu and a <dialog> label picker; measured on firefox-devtools-mcp 0.9.15 and 0.10.3 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0), macOS.
//
// The page's selection model is the one pages/filemgr/scans.html ships: a plain
// click selects one row, Shift extends from the anchor, Ctrl or Cmd toggles, a
// checkbox toggles without clearing, and right-click on a row outside the
// selection selects that row alone. The two surfaces run one after the other,
// never at once, so the spike holds one browser at a time.

import { findings, page, probeServer, surface } from './lib.mjs';

// WebDriver key codepoints, which devtools fill_by_uid passes through as keys
// (eval/spikes/keys.mjs).
const SHIFT = String.fromCodePoint(0xe008);
const DOWN = String.fromCodePoint(0xe015);
const F10 = String.fromCodePoint(0xe03a);

const ROWS = Array.from({ length: 10 }, (_, i) => ({
  n: i + 1,
  name: `scan-${String(i + 1).padStart(3, '0')}.pdf`,
  batch: i < 3 ? '26-11' : i < 7 ? '26-14' : '26-141',
}));

const probe = await probeServer({
  '/scans': page(
    'Scans',
    `<style>#menu{inset:auto;margin:0;position:fixed;padding:4px;border:1px solid #888}</style>
     <table><thead><tr><th><input type="checkbox" id="all" aria-label="Select all"></th><th>Name</th><th>Batch</th></tr></thead>
     <tbody id="tb">${ROWS.map(
       (r) =>
         `<tr id="r${r.n}" tabindex="-1"><td><input type="checkbox" aria-label="Select ${r.name}"></td>` +
         `<td class="name">${r.name}</td><td>${r.batch}</td></tr>`
     ).join('')}</tbody></table>
     <button id="more" type="button" aria-haspopup="menu">More</button>
     <div id="menu" popover="manual" role="menu"><button role="menuitem" id="apply" type="button">Apply label...</button></div>
     <dialog id="dlg"><p id="dlgcount"></p><label for="lab">Label</label>
       <select id="lab"><option value="">Choose a label</option><option>Retain 1 year</option><option>Retain 7 years</option></select>
       <button id="ok" type="button">Apply label</button></dialog>
     <p id="count">0 selected</p>
     <script>
       const tb = document.getElementById('tb'), rows = [...tb.rows];
       const menu = document.getElementById('menu'), more = document.getElementById('more');
       const dlg = document.getElementById('dlg');
       const sel = new Set();
       let anchor = 0, cur = 0;
       const mod = (e) => e.ctrlKey || e.metaKey;
       window.sel = () => [...sel].sort((a, b) => a - b).map((i) => i + 1);
       const paint = () => {
         rows.forEach((tr, i) => {
           tr.setAttribute('aria-selected', String(sel.has(i)));
           tr.cells[0].firstElementChild.checked = sel.has(i);
           tr.tabIndex = i === cur ? 0 : -1;
         });
         document.getElementById('count').textContent = sel.size + ' selected';
       };
       const span = (a, b, keep) => { if (!keep) sel.clear(); for (let i = Math.min(a, b); i <= Math.max(a, b); i++) sel.add(i); };
       const only = (i) => { sel.clear(); sel.add(i); anchor = i; };
       const toggle = (i) => { sel.has(i) ? sel.delete(i) : sel.add(i); anchor = i; };
       const open = (x, y, via) => {
         menu.style.left = x + 'px';
         menu.style.top = y + 'px';
         if (!menu.matches(':popover-open')) menu.showPopover();
         window.menuVia = via;
         menu.querySelector('[role=menuitem]').focus();
       };
       const close = () => { if (menu.matches(':popover-open')) menu.hidePopover(); };
       tb.addEventListener('click', (e) => {
         const tr = e.target.closest('tr');
         if (!tr) return;
         const i = rows.indexOf(tr), box = e.target.matches('input');
         if (e.shiftKey) span(anchor, i, box || mod(e));
         else if (box || mod(e)) toggle(i);
         else only(i);
         cur = i;
         paint();
         if (!box) tr.focus();
       });
       document.addEventListener('contextmenu', (e) => {
         const tr = e.target.closest && e.target.closest('#tb tr');
         if (!tr) return;
         e.preventDefault();
         const i = rows.indexOf(tr);
         if (!sel.has(i)) only(i);
         cur = i;
         paint();
         const r = tr.getBoundingClientRect();
         open(e.clientX || r.left + 40, e.clientY || r.bottom, 'context');
       });
       document.addEventListener('pointerdown', (e) => {
         if (!menu.contains(e.target) && e.target !== more) close();
       }, true);
       more.addEventListener('click', () => {
         if (menu.matches(':popover-open')) return close();
         const r = more.getBoundingClientRect();
         open(r.left, r.bottom, 'toolbar');
       });
       document.getElementById('apply').addEventListener('click', () => {
         close();
         document.getElementById('dlgcount').textContent = 'Apply a label to ' + sel.size + ' files';
         dlg.showModal();
       });
       document.getElementById('ok').addEventListener('click', () => {
         window.applied = { ids: window.sel(), label: document.getElementById('lab').value, via: window.menuVia };
         dlg.close();
       });
       document.addEventListener('keydown', (e) => {
         if (menu.matches(':popover-open')) {
           if (e.key === 'Escape') { close(); rows[cur].focus(); }
           return;
         }
         if (!tb.contains(document.activeElement)) return;
         const k = e.key;
         if (k === 'ArrowDown' || k === 'ArrowUp') {
           e.preventDefault();
           const n = Math.max(0, Math.min(rows.length - 1, cur + (k === 'ArrowDown' ? 1 : -1)));
           if (e.shiftKey) span(anchor, n, mod(e));
           else if (!mod(e)) only(n);
           cur = n;
           paint();
           rows[n].focus();
         } else if (k.toLowerCase() === 'a' && mod(e)) {
           e.preventDefault();
           rows.forEach((_, i) => sel.add(i));
           paint();
         } else if ((k === 'F10' && e.shiftKey) || k === 'ContextMenu') {
           e.preventDefault();
           const r = rows[cur].getBoundingClientRect();
           open(r.left + 40, r.bottom, 'keyboard');
         }
       });
     </script>`
  ),
});

const log = findings('Multi-select input on a file list, per condition');
const selected = (s) => s.evaluate(() => window.sel());
const menuOpen = (s) => s.evaluate(() => document.getElementById('menu').matches(':popover-open'));
const clicks = (events) => events.filter((e) => e.k === 'click' && e.d.tag !== 'HTML');
const keys = (events) =>
  events
    .filter((e) => e.k === 'keydown')
    .map((e) => `${e.d.shift && e.d.key !== 'Shift' ? 'Shift+' : ''}${e.d.ctrl && e.d.key !== 'Control' ? 'Ctrl+' : ''}${e.d.key}`);
const load = async (s) => {
  await s.navigate(probe.url + '/scans');
  await probe.drain();
  return s.snapshot(s.name === 'devtools' ? { includeAll: true } : {});
};

{
  const dt = await surface('devtools');
  await dt.navigate(probe.url + '/scans');
  await log.header(dt);

  const schema = (await dt.tools()).find((t) => t.name === 'click_by_uid').inputSchema;
  log.record('devtools click_by_uid arguments', Object.keys(schema.properties).sort(), ['dblClick', 'uid']);

  const plain = await dt.snapshot();
  const full = await dt.snapshot({ includeAll: true });
  log.record('devtools snapshot of the list', {
    checkboxes: (plain.match(/input "Select scan-/g) ?? []).length,
    batchDefault: plain.includes('26-14'),
    batchIncludeAll: full.includes('text="26-14"'),
    checkedState: /checked/.test(plain),
  }, { checkboxes: 10, batchDefault: false, batchIncludeAll: true, checkedState: false });

  // The honest route: one checkbox click per file, then More -> Apply label.
  let snap = await load(dt);
  for (const n of [4, 5, 6, 7]) {
    await dt.call('click_by_uid', { uid: dt.target(snap, new RegExp(`input "Select scan-00${n}.pdf"`)) });
  }
  const boxEvents = clicks(await probe.drain());
  log.record('devtools four checkbox clicks', {
    selected: await selected(dt),
    trusted: boxEvents.every((e) => e.d.trusted),
    shift: boxEvents.some((e) => e.d.shift),
  }, { selected: [4, 5, 6, 7], trusted: true, shift: false });

  snap = await dt.snapshot({ includeAll: true });
  await dt.call('click_by_uid', { uid: dt.target(snap, /button "More"/) });
  snap = await dt.snapshot();
  const menuSeen = /menuitem|Apply label/.test(snap);
  await dt.call('click_by_uid', { uid: dt.target(snap, /Apply label\.\.\./) });
  snap = await dt.snapshot();
  const dialogSeen = /Apply a label to 4 files/.test(snap);
  await dt.call('fill_by_uid', { uid: dt.target(snap, /"Label"|select/), value: 'Retain 7 years' });
  snap = await dt.snapshot();
  await dt.call('click_by_uid', { uid: dt.target(snap, /button "Apply label"/) });
  log.record('devtools More menu, dialog and label select', {
    menuSeen, dialogSeen, applied: await dt.evaluate(() => window.applied ?? null),
  }, { menuSeen: true, dialogSeen: true, applied: { ids: [4, 5, 6, 7], label: 'Retain 7 years', via: 'toolbar' } });

  // The silent mis-selection: a plain click on a name after the checkboxes.
  snap = await load(dt);
  for (const n of [4, 5, 6, 7]) {
    await dt.call('click_by_uid', { uid: dt.target(snap, new RegExp(`input "Select scan-00${n}.pdf"`)) });
  }
  const before = await selected(dt);
  const reply = await dt.call('click_by_uid', { uid: dt.target(snap, /td text="scan-006\.pdf"/) });
  log.record('devtools plain click on a row after four checkboxes', {
    before, after: await selected(dt), reply: reply.replace(/\b(?:\d+_\d+|e\d+)\b/, '<uid>'),
  }, { before: [4, 5, 6, 7], after: [6], reply: 'click <uid>' });

  // Keys through fill_by_uid: WebDriver clears a non-editable target with
  // Ctrl+A and Delete before it types, so the page sees a select-all first.
  snap = await load(dt);
  await dt.call('click_by_uid', { uid: dt.target(snap, /td text="scan-004\.pdf"/) });
  await probe.drain();
  const shiftReply = await dt.call('fill_by_uid', {
    uid: dt.target(snap, /input "Select scan-004\.pdf"/), value: SHIFT + DOWN + DOWN + DOWN,
  });
  log.record('devtools fill_by_uid Shift+Down x3 on a row checkbox', {
    toolError: /^(ERROR|THROW)/.test(shiftReply),
    keys: keys(await probe.drain()),
    selected: await selected(dt),
  }, {
    toolError: false,
    keys: ['Control', 'Ctrl+a', 'Ctrl+Unidentified', 'Ctrl+Delete', 'Shift', 'Shift+ArrowDown', 'Shift+ArrowDown', 'Shift+ArrowDown'],
    selected: [4, 5, 6, 7],
  });

  snap = await load(dt);
  for (const n of [4, 5, 6, 7]) {
    await dt.call('click_by_uid', { uid: dt.target(snap, new RegExp(`input "Select scan-00${n}.pdf"`)) });
  }
  await probe.drain();
  await dt.call('fill_by_uid', { uid: dt.target(snap, /input "Select scan-007\.pdf"/), value: SHIFT + F10 });
  const f10 = await probe.drain();
  log.record('devtools fill_by_uid Shift+F10 on a selected row checkbox', {
    contextmenu: f10.some((e) => e.k === 'contextmenu'),
    menuOpen: await menuOpen(dt),
    via: await dt.evaluate(() => window.menuVia ?? null),
    selected: await selected(dt),
  }, { contextmenu: false, menuOpen: true, via: 'keyboard', selected: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });

  // A Shift-click synthesised through script: untrusted, and a page that
  // does not check isTrusted, as few real ones do, honours it.
  snap = await load(dt);
  await dt.call('click_by_uid', { uid: dt.target(snap, /td text="scan-004\.pdf"/) });
  await probe.drain();
  await dt.evaluate(() =>
    document.querySelector('#r7 td.name').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
  );
  const synth = clicks(await probe.drain());
  log.record('devtools Shift-click synthesised through evaluate_script', {
    trusted: synth[0]?.d.trusted ?? null, shift: synth[0]?.d.shift ?? null, selected: await selected(dt),
  }, { trusted: false, shift: true, selected: [4, 5, 6, 7] });

  await dt.close();
}

{
  const pw = await surface('playwright');
  await pw.navigate(probe.url + '/scans');
  await log.header(pw);

  const schema = (await pw.tools()).find((t) => t.name === 'browser_click').inputSchema;
  log.record('playwright browser_click arguments', {
    args: Object.keys(schema.properties).sort(),
    button: schema.properties.button.enum,
    modifiers: schema.properties.modifiers.items.enum,
  }, {
    args: ['button', 'doubleClick', 'element', 'modifiers', 'target'],
    button: ['left', 'right', 'middle'],
    modifiers: ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'],
  });

  let snap = await load(pw);
  log.record('playwright snapshot of the list', {
    checkboxes: (snap.match(/checkbox "Select scan-/g) ?? []).length,
    batch: snap.includes('cell "26-14"'),
  }, { checkboxes: 10, batch: true });

  const click = (re, extra = {}) => pw.call('browser_click', { element: String(re), target: pw.target(snap, re), ...extra });
  await click(/cell "scan-004\.pdf"/);
  await probe.drain();
  await click(/cell "scan-007\.pdf"/, { modifiers: ['Shift'] });
  const shift = clicks(await probe.drain());
  log.record('playwright click then Shift-click', {
    trusted: shift[0]?.d.trusted ?? null, shift: shift[0]?.d.shift ?? null, selected: await selected(pw),
  }, { trusted: true, shift: true, selected: [4, 5, 6, 7] });

  await click(/cell "scan-009\.pdf"/, { modifiers: ['ControlOrMeta'] });
  const meta = clicks(await probe.drain());
  log.record('playwright ControlOrMeta-click adds a row', {
    ctrlOrMeta: meta[0]?.d.ctrl ?? null, selected: await selected(pw),
  }, { ctrlOrMeta: true, selected: [4, 5, 6, 7, 9] });

  await click(/cell "scan-009\.pdf"/, { modifiers: ['ControlOrMeta'] });
  await probe.drain();
  snap = await pw.snapshot();
  const rightReply = await click(/cell "scan-005\.pdf"/, { button: 'right' });
  const right = await probe.drain();
  snap = await pw.snapshot();
  log.record('playwright right-click on a selected row', {
    contextmenu: right.some((e) => e.k === 'contextmenu' && e.d.trusted),
    menuOpen: await menuOpen(pw),
    menuInSnapshot: /menuitem "Apply label\.\.\."/.test(snap),
    selected: await selected(pw),
    replyHasSnapshot: /### (Page|Snapshot)/.test(rightReply),
  }, { contextmenu: true, menuOpen: true, menuInSnapshot: true, selected: [4, 5, 6, 7], replyHasSnapshot: true });

  await pw.call('browser_press_key', { key: 'Escape' });
  snap = await pw.snapshot();
  await click(/cell "scan-002\.pdf"/, { button: 'right' });
  log.record('playwright right-click on a row outside the selection', {
    menuOpen: await menuOpen(pw), selected: await selected(pw),
  }, { menuOpen: true, selected: [2] });
  await pw.call('browser_press_key', { key: 'Escape' });

  if (process.platform === 'darwin') {
    snap = await load(pw);
    await click(/cell "scan-004\.pdf"/);
    await probe.drain();
    await click(/cell "scan-006\.pdf"/, { modifiers: ['Control'] });
    const ctrl = await probe.drain();
    log.record('playwright Control-click on macOS', {
      contextmenu: ctrl.some((e) => e.k === 'contextmenu'),
      click: clicks(ctrl).length,
      menuOpen: await menuOpen(pw),
      selected: await selected(pw),
    }, { contextmenu: false, click: 1, menuOpen: false, selected: [4, 6] });
  }

  snap = await load(pw);
  await click(/cell "scan-004\.pdf"/);
  await probe.drain();
  for (let i = 0; i < 3; i++) await pw.call('browser_press_key', { key: 'Shift+ArrowDown' });
  const arrowKeys = keys(await probe.drain());
  const afterArrows = await selected(pw);
  await pw.call('browser_press_key', { key: 'Shift+F10' });
  const f10 = await probe.drain();
  log.record('playwright press Shift+ArrowDown x3, then Shift+F10', {
    keys: arrowKeys,
    selected: afterArrows,
    contextmenu: f10.some((e) => e.k === 'contextmenu'),
    menuOpen: await menuOpen(pw),
    via: await pw.evaluate(() => window.menuVia ?? null),
  }, {
    keys: ['Shift', 'Shift+ArrowDown', 'Shift', 'Shift+ArrowDown', 'Shift', 'Shift+ArrowDown'],
    selected: [4, 5, 6, 7],
    contextmenu: false,
    menuOpen: true,
    via: 'keyboard',
  });

  snap = await pw.snapshot();
  await click(/menuitem "Apply label\.\.\."/);
  snap = await pw.snapshot();
  const dialogSeen = /Apply a label to 4 files/.test(snap);
  await pw.call('browser_select_option', { element: 'Label', target: pw.target(snap, /combobox "Label"/), values: ['Retain 7 years'] });
  snap = await pw.snapshot();
  await click(/button "Apply label"/);
  log.record('playwright dialog and label select', {
    dialogSeen, applied: await pw.evaluate(() => window.applied ?? null),
  }, { dialogSeen: true, applied: { ids: [4, 5, 6, 7], label: 'Retain 7 years', via: 'keyboard' } });

  await pw.close();
}

await probe.close();
log.done();
