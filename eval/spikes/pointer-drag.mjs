// Probes a pointer-sensor running order (T138, pointer-drag): each surface's drag tool, its keyboard route and the overflow-menu fallback; measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).
//
// One browser at a time: devtools first, then playwright.

import { findings, packageVersions, page, probeServer, surface } from './lib.mjs';

const ROWS = ['LIFEBOAT', 'FERRY', 'DREDGING', 'QUOTA', 'FOGHORN', 'REGATTA'];

// A bare copy of the widget pages/media/desk/ ships, without its server: a
// dnd-kit style pointer sensor (a drag starts only once the pointer has moved
// 6px, move and up are heard on the document, the drop lands in the slot of
// the row whose centre is nearest the pointer), a keyboard sensor on each
// row's grip, and a per-row overflow menu. No HTML5 draggable anywhere.
const WIDGET = `
<p id="dnd-desc" hidden>Press Space or Enter on a grip to pick the story up, the arrow keys to move it, Space or Enter to drop it.</p>
<div id="live" aria-live="assertive" role="status" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"></div>
<ol id="rundown" style="list-style:none;padding:0;width:560px"></ol>
<script>
const box = document.getElementById('rundown');
const live = document.getElementById('live');
let order = ${JSON.stringify(ROWS)};
window.moves = [];
window.maxMove = 0;
function render() {
  box.textContent = '';
  order.forEach((id, i) => {
    const li = document.createElement('li');
    li.dataset.id = id;
    li.style.cssText = 'display:flex;gap:12px;align-items:center;padding:12px;margin:0 0 4px;border:1px solid #889;user-select:none;touch-action:none;background:#fff';
    li.innerHTML =
      '<button type="button" class="grip" aria-roledescription="sortable" aria-describedby="dnd-desc" aria-pressed="false" aria-label="Reorder ' + id + '">::</button>' +
      '<span class="pos">' + (i + 1) + '</span><span class="slug" style="flex:1">' + id + '</span>' +
      '<button type="button" class="more" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ' + id + '">...</button>' +
      '<div class="menu" role="menu" hidden>' +
      ['Move up', 'Move down', 'Move to top', 'Move to bottom'].map((m) => '<button type="button" role="menuitem">' + m + '</button>').join('') +
      '</div>';
    box.appendChild(li);
  });
}
function move(id, to, via, trusted) {
  const from = order.indexOf(id);
  to = Math.max(0, Math.min(order.length - 1, to));
  if (from < 0 || from === to) return;
  order.splice(from, 1);
  order.splice(to, 0, id);
  window.moves.push({ via, trusted });
  render();
  live.textContent = id + ' moved to position ' + (to + 1) + ' of ' + order.length + '.';
}
render();
let press = null, active = false, rects = [];
box.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !e.isPrimary) return;
  const li = e.target.closest('li');
  if (!li || e.target.closest('.more, .menu')) return;
  press = { id: li.dataset.id, x: e.clientX, y: e.clientY, li };
  active = false;
});
const nearest = (y) => {
  let best = 0, gap = Infinity;
  rects.forEach((r, i) => { const d = Math.abs((r.top + r.bottom) / 2 - y); if (d < gap) { gap = d; best = i; } });
  return best;
};
document.addEventListener('pointermove', (e) => {
  if (!press) return;
  const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y);
  window.maxMove = Math.max(window.maxMove, dist);
  if (!active && dist >= 6) {
    active = true;
    rects = [...box.children].map((li) => li.getBoundingClientRect());
  }
  if (active) press.li.style.transform = 'translateY(' + (e.clientY - press.y) + 'px)';
});
document.addEventListener('pointerup', (e) => {
  if (!press) return;
  const p = press;
  press = null;
  p.li.style.transform = '';
  if (!active) return;
  active = false;
  move(p.id, nearest(e.clientY), 'pointer', e.isTrusted);
});
let held = null;
box.addEventListener('keydown', (e) => {
  const grip = e.target.closest('.grip');
  if (!grip) return;
  const id = grip.closest('li').dataset.id;
  if (!held && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    held = { id, at: order.indexOf(id) };
    grip.setAttribute('aria-pressed', 'true');
    return;
  }
  if (!held) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    held.at = Math.max(0, Math.min(order.length - 1, held.at + (e.key === 'ArrowDown' ? 1 : -1)));
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    const h = held;
    held = null;
    move(h.id, h.at, 'keyboard', e.isTrusted);
    box.querySelector('li[data-id="' + h.id + '"] .grip')?.focus();
  }
});
box.addEventListener('click', (e) => {
  const more = e.target.closest('.more');
  if (more) {
    const menu = more.nextElementSibling;
    const open = menu.hidden;
    box.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
    menu.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
    return;
  }
  const item = e.target.closest('[role=menuitem]');
  if (!item) return;
  const id = item.closest('li').dataset.id;
  const at = order.indexOf(id);
  const to = { 'Move up': at - 1, 'Move down': at + 1, 'Move to top': 0, 'Move to bottom': order.length - 1 }[item.textContent];
  move(id, to, 'menu', e.isTrusted);
});
</script>`;

const probe = await probeServer({ '/desk': page('Running order', WIDGET) });
const log = findings('Pointer-sensor running order per condition');
const kinds = (events) =>
  [...new Set(events.filter((e) => !/move|over|enter/.test(e.k)).map((e) => `${e.k}${e.d.trusted ? '' : '(untrusted)'}`))].sort();
const readOrder = (s) => s.evaluate(() => [...document.querySelectorAll('#rundown li')].map((li) => li.dataset.id));
const readMoves = (s) => s.evaluate(() => window.moves);
const without = (list, id, at) => {
  const out = list.filter((x) => x !== id);
  out.splice(at, 0, id);
  return out;
};

const versions = packageVersions();
const running = [];

async function probeSurface(name) {
  const s = await surface(name);
  const devtools = name === 'devtools';
  try {
    await s.navigate(probe.url + '/desk');
    running.push(
      `${devtools ? `firefox-devtools-mcp ${versions.devtools}` : `@playwright/mcp ${versions.playwright}`} (Firefox ${await s.firefox()})`
    );
    const load = async () => {
      await s.navigate(probe.url + '/desk');
      await probe.drain();
      return s.snapshot();
    };
    const click = (snap, re) =>
      devtools
        ? s.call('click_by_uid', { uid: s.target(snap, re) })
        : s.call('browser_click', { element: String(re), target: s.target(snap, re) });
    const drag = (snap, from, to) =>
      devtools
        ? s.call('drag_by_uid_to_uid', { fromUid: s.target(snap, from), toUid: s.target(snap, to) })
        : s.call('browser_drag', {
            startElement: String(from), startTarget: s.target(snap, from),
            endElement: String(to), endTarget: s.target(snap, to),
          });
    // The reply an agent reads after a drag, with the uids taken out.
    const replyOf = (r) =>
      devtools
        ? r.replace(/\d+_\d+/g, 'uid')
        : { ranDragTo: /\.dragTo\(/.test(r), inlineSnapshot: /```yaml/.test(r), linksSnapshot: /\[Snapshot\]\(/.test(r) };

    // Row onto row, downward: arrayMove puts LIFEBOAT in QUOTA's slot.
    let snap = await load();
    let reply = await drag(snap, devtools ? /uid=\S+ li$/ : /- listitem \[ref=/, /(span|generic) .*"?QUOTA"?/);
    log.record(
      `${name} drag a row onto a row`,
      {
        toolError: /^(ERROR|THROW)/.test(reply),
        reply: replyOf(reply),
        events: kinds(await probe.drain()),
        order: await readOrder(s),
        crossedThreshold: (await s.evaluate(() => window.maxMove)) >= 6,
      },
      devtools
        ? { toolError: false, reply: 'drag uid→uid', events: ['dragstart(untrusted)', 'drop(untrusted)'], order: ROWS, crossedThreshold: false }
        : {
            toolError: false,
            reply: { ranDragTo: true, inlineSnapshot: false, linksSnapshot: true },
            events: ['mousedown', 'mouseup', 'pointerdown', 'pointerup'],
            order: without(ROWS, 'LIFEBOAT', 3),
            crossedThreshold: true,
          }
    );

    // Grip onto grip, upward: FOGHORN lands in FERRY's slot.
    snap = await load();
    reply = await drag(snap, /Reorder FOGHORN/, /Reorder FERRY/);
    log.record(
      `${name} drag a grip onto a grip`,
      { toolError: /^(ERROR|THROW)/.test(reply), order: await readOrder(s), moves: await readMoves(s) },
      devtools
        ? { toolError: false, order: ROWS, moves: [] }
        : { toolError: false, order: without(ROWS, 'FOGHORN', 1), moves: [{ via: 'pointer', trusted: true }] }
    );

    // The honest fallback: More actions, then Move to bottom.
    snap = await load();
    await click(snap, /More actions for FERRY/);
    snap = await s.snapshot();
    await click(snap, /menuitem "Move to bottom"/);
    snap = await s.snapshot();
    log.record(
      `${name} overflow menu Move to bottom`,
      { order: await readOrder(s), moves: await readMoves(s) },
      { order: without(ROWS, 'FERRY', 5), moves: [{ via: 'menu', trusted: true }] }
    );
    log.record(
      `${name} live announcement in the next snapshot`,
      snap.match(/FERRY moved[^"\n]*/)?.[0] ?? null,
      devtools ? 'FERRY moved to position 6 o...' : 'FERRY moved to position 6 of 6.'
    );

    if (devtools) {
      // No key-press tool, but fill_by_uid passes WebDriver key codepoints
      // through as trusted keys (keys.mjs): Space, ArrowDown twice, Space.
      snap = await load();
      const key = (c) => String.fromCodePoint(c);
      await s.call('fill_by_uid', {
        uid: s.target(snap, /Reorder LIFEBOAT/),
        value: key(0xe00d) + key(0xe015) + key(0xe015) + key(0xe00d),
      });
      log.record(
        'devtools fill_by_uid Space, ArrowDown x2, Space on a grip',
        { order: await readOrder(s), moves: await readMoves(s) },
        { order: without(ROWS, 'LIFEBOAT', 2), moves: [{ via: 'keyboard', trusted: true }] }
      );

      // A pointer drag synthesised in page script: the sensor, like dnd-kit's,
      // does not check isTrusted.
      await load();
      await s.evaluate(() => {
        const rows = [...document.querySelectorAll('#rundown li')];
        const a = rows[0].getBoundingClientRect();
        const b = rows[3].getBoundingClientRect();
        const fire = (type, target, x, y) =>
          target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, isPrimary: true, pointerId: 1 }));
        const x = a.left + 40;
        const y0 = (a.top + a.bottom) / 2;
        const y1 = (b.top + b.bottom) / 2;
        fire('pointerdown', rows[0].querySelector('.slug'), x, y0);
        fire('pointermove', document, x, y0 + 10);
        fire('pointermove', document, x, y1);
        fire('pointerup', document, x, y1);
        return true;
      });
      log.record(
        'devtools evaluate_script synthetic pointer drag',
        { order: await readOrder(s), moves: await readMoves(s) },
        { order: without(ROWS, 'LIFEBOAT', 3), moves: [{ via: 'pointer', trusted: false }] }
      );
    } else {
      snap = await load();
      await click(snap, /Reorder LIFEBOAT/);
      for (const key of [' ', 'ArrowDown', 'ArrowDown', ' ']) await s.call('browser_press_key', { key });
      log.record(
        'playwright click a grip, then press Space, ArrowDown x2, Space',
        { order: await readOrder(s), moves: await readMoves(s) },
        { order: without(ROWS, 'LIFEBOAT', 2), moves: [{ via: 'keyboard', trusted: true }] }
      );
    }
  } finally {
    await s.close();
  }
}

console.log('Pointer-sensor running order per condition');
await probeSurface('devtools');
await probeSurface('playwright');
console.log(`running on: ${running.join(', ')}\n`);
await probe.close();
log.done();
