// pages/kanban/ - Coppermast Dispatch triage board (kanban-triage).
import { randomBytes } from 'node:crypto';
import { SESSION_ROWS, lcg } from './lib.mjs';

// pages/kanban/ — Coppermast Dispatch's Terminal 3 shift triage board
// (kanban-triage). Which work orders carry the Urgent and Blocked tags, and which
// lane each one starts in, are drawn per session from ctx.draw and released
// only through the gated board read below, so the two sets the validator grades
// exist nowhere under pages/. Every tagged card is dealt into a lane it does not
// belong in, so a correct board is never handed out for free. The saved layout is
// the graded fact; the `moves` list is page-reported route telemetry (drag vs the
// per-card move buttons) and is deliberately not part of the pass decision, since
// a page nonce is enough to forge it.
const KANBAN_ORDERS = [
  { id: 'c1', ref: 'WO-1042', title: 'Winch relay trips under load', berth: 'Berth 4', raised: '07:15', raisedBy: 'K. Brenner' },
  { id: 'c2', ref: 'WO-1043', title: 'Gantry rail packing worn at joint 6', berth: 'Berth 2', raised: '07:40', raisedBy: 'D. Farrant' },
  { id: 'c3', ref: 'WO-1047', title: 'Quay lighting column 12 dark', berth: 'Berth 5', raised: '08:05', raisedBy: 'R. Aldwyn' },
  { id: 'c4', ref: 'WO-1051', title: 'Conveyor 3 overload trip repeating', berth: 'Berth 2', raised: '08:22', raisedBy: 'S. Okonjo' },
  { id: 'c5', ref: 'WO-1054', title: 'Bollard 9 grout cracked', berth: 'Berth 1', raised: '09:10', raisedBy: 'T. Marlow' },
  { id: 'c6', ref: 'WO-1058', title: 'Hose reel leaking at coupling', berth: 'Berth 4', raised: '09:48', raisedBy: 'J. Loweth' },
  { id: 'c7', ref: 'WO-1063', title: 'Crane anemometer reading low', berth: 'Berth 1', raised: '10:26', raisedBy: 'A. Prentice' },
  { id: 'c8', ref: 'WO-1069', title: 'Gate barrier slow to lift', berth: 'Gate 2', raised: '11:03', raisedBy: 'P. Crennock' },
];

const KANBAN_COLS = ['backlog', 'doing', 'done'];

const KANBAN_LANE_NAME = { backlog: 'Backlog', doing: 'Doing', done: 'Done' };

const KANBAN_TAG_LABEL = { urgent: 'Urgent', blocked: 'Blocked', routine: 'Routine' };

function kanbanState(session, draw) {
  if (!session.kanban) {
    const rand = lcg(draw('kanban', 4));
    const shuffle = (list) => {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    };
    const dealt = shuffle(KANBAN_ORDERS.map((o) => ({ ...o })));
    // Two urgent, two blocked, four routine. The urgent pair starts split across
    // Backlog and Doing and the blocked pair across Doing and Done, so exactly
    // four cards have to move and both drag directions are exercised.
    const tags = ['urgent', 'urgent', 'blocked', 'blocked', 'routine', 'routine', 'routine', 'routine'];
    const starts = [
      'backlog',
      'doing',
      'doing',
      'done',
      'backlog',
      'doing',
      'done',
      KANBAN_COLS[Math.floor(rand() * KANBAN_COLS.length)],
    ];
    dealt.forEach((card, i) => {
      card.tag = tags[i];
      card.col = starts[i];
    });
    session.kanban = {
      cards: shuffle(dealt),
      urgent: dealt.filter((c) => c.tag === 'urgent').map((c) => c.id).sort(),
      blocked: dealt.filter((c) => c.tag === 'blocked').map((c) => c.id).sort(),
      // The dealt columns, frozen at mint: accepted saves overwrite card.col
      // (so a reload shows the saved board), which would otherwise leave "leave
      // the Routine ones where they are" ungradable.
      startCols: Object.fromEntries(dealt.map((c) => [c.id, c.col])),
      reads: 0,
      offPageReads: 0,
      layouts: [],
    };
  }
  return session.kanban;
}

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage, draw } = ctx;
  return async (req, res, url, pathname0) => {
    // Coppermast Dispatch triage board. The tag assignment and the starting lanes
    // are minted here, so the board is the only place they exist; `src=board` marks
    // the read the page itself makes, which separates an agent's own fetch from it.
    if (req.method === 'GET' && pathname0 === '/api/kanban/board') {
      const found = requireSession(req, res);
      if (!found) return;
      const kb = kanbanState(found.session, draw);
      kb.reads += 1;
      if (url.searchParams.get('src') !== 'board') kb.offPageReads += 1;
      return json(res, 200, {
        terminal: 'Terminal 3',
        shift: '08:00 to 16:00',
        lanes: KANBAN_COLS,
        // An accepted save is written back onto the cards, so a reload repaints the
        // saved board; these two let it repaint the saved STATUS as well, instead of
        // telling an agent that reloaded to check its work that nothing was saved.
        saves: kb.layouts.length,
        lastRevision: kb.layouts.at(-1)?.revision ?? null,
        cards: kb.cards.map((c) => ({
          id: c.id,
          ref: c.ref,
          title: c.title,
          berth: c.berth,
          raised: c.raised,
          raisedBy: c.raisedBy,
          tag: c.tag,
          tagLabel: KANBAN_TAG_LABEL[c.tag],
          col: c.col,
        })),
      });
    }

    // The handover draft: the last saved layout, by work order reference. It
    // never mints a board, because seeded draws are counted per scope and a
    // read from this page must not move the session's deal.
    if (req.method === 'GET' && pathname0 === '/api/kanban/handover') {
      const found = requireSession(req, res);
      if (!found) return;
      const kb = found.session.kanban;
      const last = kb?.layouts.at(-1) ?? null;
      const refOf = (id) => kb.cards.find((c) => c.id === id)?.ref ?? id;
      return json(res, 200, {
        revision: last?.revision ?? null,
        lanes: last
          ? KANBAN_COLS.map((col) => [KANBAN_LANE_NAME[col], last.columns[col].map(refOf)])
          : [],
      });
    }

    // Save board. The layout is the graded fact, so it is validated as a whole
    // board: every work order exactly once, across the three known lanes. Each
    // accepted save gets its own randomBytes revision, which the board prints.
    if (req.method === 'POST' && pathname0 === '/api/kanban/layout') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const kb = kanbanState(found.session, draw);
      if (kb.layouts.length >= SESSION_ROWS) {
        return json(res, 429, { ok: false, error: 'This board cannot take any more saves this shift.' });
      }
      const columns = {};
      const seen = new Set();
      for (const col of KANBAN_COLS) {
        const ids = payload?.columns?.[col];
        if (!Array.isArray(ids)) {
          return json(res, 400, { ok: false, error: 'Every lane must be sent.' });
        }
        for (const id of ids) {
          if (typeof id !== 'string' || !kb.cards.some((c) => c.id === id) || seen.has(id)) {
            return json(res, 400, { ok: false, error: 'Unknown or repeated work order.' });
          }
          seen.add(id);
        }
        columns[col] = ids.slice();
      }
      if (seen.size !== kb.cards.length) {
        return json(res, 400, { ok: false, error: 'Every work order must be on the board.' });
      }
      const moves = (Array.isArray(payload?.moves) ? payload.moves : [])
        .slice(0, 200)
        .filter((m) => m && typeof m.card === 'string' && KANBAN_COLS.includes(m.to))
        .map((m) => ({
          card: m.card,
          from: KANBAN_COLS.includes(m.from) ? m.from : null,
          to: m.to,
          via: m.via === 'drag' || m.via === 'button' ? m.via : 'other',
        }));
      const revision = 'CM-' + randomBytes(3).toString('hex').toUpperCase();
      kb.layouts.push({ columns, moves, revision, at: Date.now() });
      // An accepted save is what the board shows on its next load, so reloading
      // to check the work does not silently throw it away.
      const saved = [];
      for (const col of KANBAN_COLS) {
        for (const id of columns[col]) {
          const card = kb.cards.find((c) => c.id === id);
          card.col = col;
          saved.push(card);
        }
      }
      kb.cards = saved;
      return json(res, 200, { ok: true, revision, saved: kb.layouts.length });
    }

    return false;
  };
}
