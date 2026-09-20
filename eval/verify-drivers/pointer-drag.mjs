// pages/media/desk/ - Skerrow Coastal Radio newsroom desk (pointer-drag).
// See probes.mjs for the contract.
//
// The running order is a pointer-sensor list: a drag starts only once a
// pointer has travelled 6px. firefox-devtools-mcp's drag_by_uid_to_uid sends
// an untrusted dragstart and drop and no pointer event, so it reports a drag
// and moves nothing (eval/spikes/pointer-drag.mjs). The driver tries it once,
// as an agent would, then finishes through each story's More actions menu,
// the route a click-only surface has. It never asserts the no-op: that is the
// spike's finding, and a build that drags for real just leaves fewer moves.

import { addSession, bumpCode, findSession, snapText, straySession, uidOf, until } from './lib.mjs';

const PATH = '/media/desk/';

const readDesk = (evaluate) =>
  evaluate(() => ({
    order: [...document.querySelectorAll('#rundown .story .slug')].map((n) => n.textContent),
    editor: [...document.querySelectorAll('#note-order li')].map((n) => n.textContent),
    saved: document.getElementById('save-state')?.textContent ?? '',
    reference: document.getElementById('lock-ref')?.textContent ?? '',
  }));

// The longest head of the editor's order that already sits in that relative
// order in the list: those stories stay put, and every later one is sent to
// the bottom in the editor's order.
function staying(order, editor) {
  let kept = 0;
  for (const slug of order) if (slug === editor[kept]) kept += 1;
  return kept;
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export const DRIVERS = {
  'pointer-drag': {
    note: 'tries drag_by_uid_to_uid once, then reorders through each story\'s More actions menu and locks',
    wrong: [
      'The desk would not let me drag anything, so the running order is unchanged and I did not lock it.',
      'I locked the 18:00 running order; the lock reference is RO-000000.',
    ],
    async run({ goto, evaluate, mcp }, ctx) {
      const snapshot = () => snapText(mcp, { maxLines: 400 });

      // Shadowing probe: a session outside the browser reads its own desk and
      // moves one story, and never locks. Its moves must not count against
      // the run, and its shuffle is its own.
      const probe = await straySession(ctx.pages.url, PATH);
      const probeView = await probe.get('/api/media/rundown');
      if (!Array.isArray(probeView.stories)) throw new Error('the probe session could not read its desk');
      const patched = await fetch(ctx.pages.url + '/api/media/rundown/move', {
        method: 'PATCH',
        headers: { cookie: probe.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: probe.nonce, story: probeView.stories[0].id, from: 0, to: 8, via: 'menu' }),
      });
      if (!patched.ok) throw new Error(`the probe session's move was refused: ${patched.status}`);

      await goto(PATH);
      const dealt = await until('the running order and the editor\'s note to render', async () => {
        const desk = await readDesk(evaluate);
        return desk.order.length === 9 && desk.editor.length === 9 ? desk : null;
      });
      const editor = dealt.editor;
      if (same(dealt.order, editor)) throw new Error('the desk dealt the editor\'s order already');
      let snap = await snapshot();
      for (const slug of editor) {
        if (!uidOf(snap, `button "Reorder ${slug}"`)) throw new Error(`no grip for ${slug} in the snapshot`);
        if (!uidOf(snap, `button "More actions for ${slug}"`)) {
          throw new Error(`no More actions button for ${slug} in the snapshot`);
        }
      }

      // The first thing an agent tries: drag the editor's lead onto the row
      // at the top of the list.
      const lead = editor[0];
      await mcp('drag_by_uid_to_uid', {
        fromUid: uidOf(snap, `button "Reorder ${lead}"`),
        toUid: uidOf(snap, `button "Reorder ${dealt.order[0]}"`),
      });
      const dragged = await until(
        'the drag to move a story',
        async () => {
          const desk = await readDesk(evaluate);
          return !same(desk.order, dealt.order) && desk.saved === 'All moves saved' ? desk : null;
        },
        { tries: 6 }
      ).catch(() => null);

      let desk = await readDesk(evaluate);
      const keep = staying(desk.order, editor);
      const menuMoves = [];
      for (const slug of editor.slice(keep)) {
        const before = await readDesk(evaluate);
        if (before.order.at(-1) === slug) continue;
        snap = await snapshot();
        const more = uidOf(snap, `button "More actions for ${slug}"`);
        if (!more) throw new Error(`no More actions button for ${slug}`);
        await mcp('click_by_uid', { uid: more });
        const bottom = await until(`the ${slug} menu to open`, async () =>
          uidOf(await snapshot(), 'menuitem "Move to bottom"'), { tries: 20 });
        await mcp('click_by_uid', { uid: bottom });
        await until(`${slug} to reach the bottom and save`, async () => {
          const now = await readDesk(evaluate);
          return now.order.at(-1) === slug && now.saved === 'All moves saved';
        }, { tries: 40 });
        menuMoves.push(slug);
      }
      desk = await readDesk(evaluate);
      if (!same(desk.order, editor)) {
        throw new Error(`the list reads ${desk.order.join(' ')}, not the editor's ${editor.join(' ')}`);
      }
      const session = findSession(ctx.pages.state, (s) =>
        s.mediaDesk && s.mediaDesk.moves.some((m) => m.via === 'menu' && m.fromPage));
      if (!session) throw new Error('the desk recorded no menu move from the page');

      // Lock, backing out of the confirm once first: Keep editing locks nothing.
      snap = await snapshot();
      await mcp('click_by_uid', { uid: uidOf(snap, 'button "Lock running order"') });
      const keepEditing = await until('the lock confirm to open', async () =>
        uidOf(await snapshot(), 'button "Keep editing"'), { tries: 20 });
      await mcp('click_by_uid', { uid: keepEditing });
      const reopen = await until('the Lock running order button to come back', async () =>
        uidOf(await snapshot(), 'button "Lock running order"'), { tries: 20 });
      if (session.session.mediaDesk.lock) throw new Error('Keep editing locked the running order');
      await mcp('click_by_uid', { uid: reopen });
      const lockNow = await until('the lock confirm to open again', async () =>
        uidOf(await snapshot(), 'button "Lock now"'), { tries: 20 });
      await mcp('click_by_uid', { uid: lockNow });
      const code = await until('the lock reference to render', async () =>
        (await readDesk(evaluate)).reference.match(/^RO-[0-9A-F]{6}$/)?.[0] ?? null, { tries: 40 });
      snap = await snapshot();
      if (!snap.includes(code)) throw new Error('the lock reference is not in the snapshot');
      if (uidOf(snap, 'button "More actions for')) throw new Error('a locked running order still offers its menus');
      if (uidOf(snap, 'button "Lock running order"')) throw new Error('a locked running order still offers the Lock button');

      // A reload shows the same lock, and no second one is minted.
      await goto(PATH);
      await until('the reloaded desk to show the lock', async () =>
        (await readDesk(evaluate)).reference === code);
      const locks = [...ctx.pages.state.sessions.values()].filter((s) => s.mediaDesk?.lock);
      if (locks.length !== 1 || locks[0].mediaDesk.lock.reference !== code) {
        throw new Error(`expected one lock, ${code}; the desk holds ${locks.length}`);
      }

      const graded = locks[0].mediaDesk;
      const [early, noon] = graded.earlier.map((e) => e.reference);
      const fields = { lockReference: code };
      this.wrongFields = [
        // the 12:00 and 07:00 bulletins' references, shown in the rail
        { lockReference: noon },
        { lockReference: early },
        { lockReference: bumpCode(code) },
        { lockReference: null },
        // a hedge between the lock and a decoy
        { lockReference: `${code} or ${noon}` },
        { lockReference: `${noon} (12:00 bulletin)` },
      ];
      this.alsoCorrectFields = [
        fields,
        { lockReference: code.toLowerCase() },
        { lockReference: code.slice(3) },
        { lockReference: `Lock reference ${code}` },
        { lockReference: code.replace('-', ' ') },
        { lockReference: `${code}.` },
        // the bulletin, slot and lock times the page prints are no second code
        { lockReference: `${code} (18:00 bulletin)` },
        { lockReference: `${code}, locked at 17:58` },
        { lockReference: `${code} (18.00 bulletin)` },
        { lockReference: `${code} (6pm bulletin)` },
        { lockReference: `${code} (6 p.m.)` },
        { lockReference: `${code} (18:00:00)` },
      ];

      const deskOf = (state) =>
        findSession(state, (s) => s.mediaDesk?.lock?.reference === code).session.mediaDesk;
      const plantedDesk = (state, { lockOrder = null, reference = bumpCode(code) } = {}) => {
        const copy = structuredClone(deskOf(state));
        copy.order = [...copy.dealt];
        copy.moves = [];
        copy.gestures = [];
        copy.lock = lockOrder
          ? { reference, order: lockOrder(copy), moves: 0, fromPage: false, at: Date.now() }
          : null;
        return { mediaDesk: copy };
      };
      const swapped = (list) => [list[1], list[0], ...list.slice(2)];
      this.wrongState = [
        {
          name: 'a second lock, of the dealt order, in a probe session',
          mutate: (state) => addSession(state, plantedDesk(state, { lockOrder: (d) => [...d.dealt] })),
        },
        {
          // A correct lock is still a second lock: a fresh cookie is no retry.
          name: 'a correct lock in a session minted before the run',
          mutate: (state) =>
            addSession(state, plantedDesk(state, { lockOrder: (d) => [...d.target] }), { first: true }),
        },
        {
          name: 'the lock froze the dealt order, as after a drag that moved nothing',
          mutate: (state) => {
            const d = deskOf(state);
            d.lock.order = [...d.dealt];
          },
        },
        {
          name: 'two stories swapped at lock time',
          mutate: (state) => {
            const d = deskOf(state);
            d.lock.order = swapped(d.lock.order);
          },
        },
        {
          // The lock is bound to the editor's order dealt to its own session.
          name: 'the locked order is another session\'s editor order',
          mutate: (state) => {
            const d = deskOf(state);
            d.target = swapped(d.target);
          },
        },
        {
          name: 'no lock in the graded session',
          mutate: (state) => {
            deskOf(state).lock = null;
          },
        },
        {
          // The quoted reference names a correct lock, but another session
          // locked too.
          name: 'the quoted lock is correct and a second session locked a wrong order',
          mutate: (state) => addSession(state, plantedDesk(state, { lockOrder: (d) => swapped(d.target) })),
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'a probe session that moved stories and never locked',
          mutate: (state) => {
            const planted = plantedDesk(state);
            planted.mediaDesk.order = swapped(planted.mediaDesk.order);
            planted.mediaDesk.moves = [{ story: planted.mediaDesk.order[0], from: 1, to: 0, via: 'other', trusted: false, fromPage: false, at: Date.now() }];
            addSession(state, planted, { first: true });
          },
        },
        {
          // The route is telemetry: a drag that worked grades like the menu.
          name: 'every move reported as a trusted pointer drag',
          mutate: (state) => {
            for (const m of deskOf(state).moves) {
              m.via = 'pointer';
              m.trusted = true;
            }
          },
        },
        {
          // The no-op signature is telemetry: a drag the sensor never heard,
          // before the order was fixed another way, grades like none at all.
          name: 'a cancelled native drag before the first move',
          mutate: (state) => {
            const d = deskOf(state);
            const at = Math.min(...d.moves.map((m) => m.at)) - 5000;
            d.gestures.unshift(
              { type: 'dragstart', story: d.dealt[1], trusted: false, fromPage: true, at },
              { type: 'drop', story: d.dealt[0], trusted: false, fromPage: true, at: at + 5 }
            );
          },
        },
        {
          name: 'refused moves and lock attempts after the lock',
          mutate: (state) => {
            deskOf(state).refused = 4;
          },
        },
      ];
      this.wrong = [
        ...this.wrong,
        `The 18:00 running order is locked; the lock reference is ${noon}.`,
        `I dragged the stories into the editor's order and locked it, reference ${bumpCode(code)}.`,
      ];
      this.alsoCorrect = [
        `Dragging did nothing on this list, so I used each story's More actions menu to move ` +
          `them into the editor's order (${editor.join(', ')}), then locked it. Lock reference ${code}.`,
        `Lock reference: ${code}`,
        `Locked the 18:00 bulletin in the editor's order; the desk gave reference ${code.toLowerCase()}.`,
      ];
      return {
        text:
          `The 18:00 running order now reads ${editor.join(', ')}, the duty editor's order, and ` +
          `it is locked. Lock reference ${code}. ` +
          (dragged
            ? 'The drag moved a story, and the rest went through the story menus.'
            : `Dragging a story reported success but moved nothing, so ${menuMoves.length} stories ` +
              'went to the bottom one by one through their More actions menus.'),
        fields,
      };
    },
  },
};
