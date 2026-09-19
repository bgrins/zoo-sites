// Golden path for T001 kanban-triage (pages/kanban/). This is the only driver in
// the suite that calls `drag_by_uid_to_uid`, which is the whole reason the task
// exists: we ship the tool, and this is the only exercise it gets. The golden path
// moves every card by DRAGGING it, never with the per-card move buttons, and the
// route the server records (`route=drag` in the validator's detail) is what proves
// the drag really did the work rather than a click quietly doing it.
//
// Two measured properties of that drag:
//   - our drag is five synthetic DragEvents dispatched straight at the two
//     elements, so it works here only because the board's drop handler appends to
//     whichever lane received the event. clientX/clientY arrive as 0, so any board
//     that derived an insertion index from the pointer would land the card wrong;
//   - every move re-renders the board, and a re-render plus the fresh snapshot
//     invalidates every uid, so a four-card triage costs a snapshot per card.

import { snapText, until } from './lib.mjs';
import { probeSession } from './interaction-lib.mjs';

const PATH = '/kanban/';
const LANES = { backlog: 'Backlog', doing: 'Doing', done: 'Done' };

// The board is three <section>s of <article> cards; the snapshot keeps that
// nesting, so lane membership is recoverable from document order alone.
function readBoard(snap) {
  const lanes = {};
  const cards = [];
  let lane = null;
  for (const line of snap.split('\n')) {
    const laneMatch = line.match(/uid=(\S+) section "(Backlog|Doing|Done)"/);
    if (laneMatch) {
      lane = laneMatch[2].toLowerCase();
      lanes[lane] = laneMatch[1];
      continue;
    }
    const cardMatch = line.match(/uid=(\S+) article "(WO-\d+) (Urgent|Blocked|Routine)"/);
    if (cardMatch) {
      cards.push({ uid: cardMatch[1], ref: cardMatch[2], tag: cardMatch[3].toLowerCase(), lane });
    }
  }
  return { lanes, cards };
}

const wantedLane = (card) =>
  card.tag === 'urgent' ? 'done' : card.tag === 'blocked' ? 'backlog' : null;

export const DRIVERS = {
  'kanban-triage': {
    note: 'the only driver that calls drag_by_uid_to_uid; drags all four cards',
    async run({ base, goto, mcp }) {
      await goto(PATH);
      const snapshot = () => snapText(mcp, { maxLines: 400 });

      const dealt = await until('the eight work orders to render', async () => {
        const board = readBoard(await snapshot());
        return board.cards.length === 8 && Object.keys(board.lanes).length === 3 ? board : null;
      });
      const toMove = dealt.cards.filter((c) => wantedLane(c) && wantedLane(c) !== c.lane);
      if (toMove.length !== 4) {
        throw new Error(`expected 4 cards out of place, the board dealt ${toMove.length}`);
      }

      const dragged = [];
      for (let guard = 0; guard < 10; guard++) {
        // Re-read every pass: the board re-renders after each drop and a new
        // snapshot invalidates the previous uids either way.
        const board = readBoard(await snapshot());
        const next = board.cards.find((c) => wantedLane(c) && wantedLane(c) !== c.lane);
        if (!next) break;
        const target = wantedLane(next);
        await mcp('drag_by_uid_to_uid', { fromUid: next.uid, toUid: board.lanes[target] });
        const landed = await until(`${next.ref} to land in ${LANES[target]}`, async () => {
          const now = readBoard(await snapshot());
          return now.cards.some((c) => c.ref === next.ref && c.lane === target);
        });
        if (landed) dragged.push(`${next.ref} to ${LANES[target]}`);
      }
      if (dragged.length !== 4) {
        throw new Error(
          `dragged ${dragged.length} of 4 cards; drag_by_uid_to_uid did not land them`
        );
      }

      const beforeSave = readBoard(await snapshot());
      const stillWrong = beforeSave.cards.filter((c) => wantedLane(c) && wantedLane(c) !== c.lane);
      if (stillWrong.length)
        throw new Error(`${stillWrong.length} tagged cards still out of place`);

      const saveUid = (await snapshot()).match(/uid=(\S+) button "Save board"/)?.[1];
      if (!saveUid) throw new Error('no Save board button in the snapshot');
      await mcp('click_by_uid', { uid: saveUid });

      const revision = await until('the board revision to appear', async () => {
        const snap = await snapshot();
        if (!snap.includes('text="Board saved"')) return null;
        return snap.match(/text="(CM-[0-9A-F]{6})"/)?.[1] ?? null;
      });

      // A wrong answer that looks right: the same prose, a revision the server
      // never issued. The validator has to reject it or it is grading nothing.
      this.wrong = [
        'I dragged the Urgent cards into Done and the Blocked cards into Backlog and ' +
          'saved the board. It came back as board revision CM-000000.',
        'All four tagged cards were dragged home and the board saved, but the toast ' +
          'cleared before I could copy the revision code down.',
      ];
      this.alsoCorrect = [
        `Moves (all by dragging): ${dragged.join('; ')}\nBoard revision: ${revision}`,
        `I dragged ${dragged.join(', ')}, left the Routine orders alone, and saved; ` +
          `the page reported revision ${revision.slice(3)}.`,
        `Saved by drag-and-drop between lanes; the board revision is ${revision.toLowerCase()}.`,
      ];
      // Curl sessions that save their own boards: one saves the dealt board
      // untouched, one triages but also shifts a Routine card, and one saves the
      // dealt board before triaging and saving again. Each revision is real, so
      // each must fail on the layout it was issued for.
      const probeBoard = async () => {
        const probe = await probeSession(base, PATH);
        const { body } = await probe.get('/api/kanban/board');
        if (!Array.isArray(body.cards)) throw new Error('probe could not read its board');
        const save = async (place) => {
          const columns = { backlog: [], doing: [], done: [] };
          for (const card of body.cards) columns[place(card)].push(card.id);
          const r = await probe.post('/api/kanban/layout', { columns, moves: [] });
          if (!r.body.ok) throw new Error(`probe save refused: ${JSON.stringify(r.body)}`);
          return r.body.revision;
        };
        const triaged = (card) =>
          card.tag === 'urgent' ? 'done' : card.tag === 'blocked' ? 'backlog' : card.col;
        return { cards: body.cards, save, triaged };
      };
      const untouched = await probeBoard();
      const untouchedRevision = await untouched.save((card) => card.col);
      const shuffled = await probeBoard();
      const nudged = shuffled.cards.find((card) => card.tag === 'routine');
      const routineRevision = await shuffled.save((card) =>
        card === nudged ? (card.col === 'doing' ? 'done' : 'doing') : shuffled.triaged(card)
      );
      const twice = await probeBoard();
      const staleRevision = await twice.save((card) => card.col);
      await twice.save(twice.triaged);

      const fields = { boardRevision: revision };
      this.wrongFields = [
        { boardRevision: 'CM-000000' },
        { boardRevision: untouchedRevision },
        { boardRevision: routineRevision },
        { boardRevision: staleRevision },
      ];
      this.alsoCorrectFields = [
        fields,
        { boardRevision: String(revision).replace(/^CM-/i, '') },
      ];
      return {
        text:
          `Triaged the Terminal 3 board by dragging each card between lanes: ` +
          `${dragged.join(', ')}. The Routine work orders were left where they were. ` +
          `Saved, and the board came back as revision ${revision}.`,
        fields,
      };
    },
  },
};
