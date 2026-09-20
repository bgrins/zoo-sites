// wrongState / alsoCorrectState cases for extraction-family entries that sit in
// driver files other families share (grid-edit in forms.mjs), kept apart so the
// shared file only imports them.

import { addSession, findSession } from './lib.mjs';

// The sheet as the server first served it: the golden session's grid with its
// edits undone, newest first.
function freshGrid(golden) {
  const grid = golden.grid.map((row) => ({ ...row }));
  for (const e of [...golden.gridEdits].reverse()) grid.find((r) => r.sku === e.sku).qty = e.from;
  return grid;
}

// A second cycle-count session that saved `edits` ([sku, qty] pairs) in order,
// minted before the golden session (and editing before it) unless `later`.
function plantGridSession(state, edits, { later = false } = {}) {
  const golden = findSession(state, (s) => (s.gridEdits ?? []).length > 0).session;
  const grid = freshGrid(golden);
  const firstAt = Math.min(...golden.gridEdits.map((e) => e.at));
  const lastAt = Math.max(...golden.gridEdits.map((e) => e.at));
  const start = later ? lastAt + 1000 : firstAt - 1000 * (edits.length + 1);
  const gridEdits = edits.map(([sku, to], i) => {
    const row = grid.find((r) => r.sku === sku);
    const edit = { sku, from: row.qty, to, at: start + i };
    row.qty = to;
    return edit;
  });
  addSession(state, gridEdits.length ? { grid, gridEdits } : { grid }, { first: !later });
}

export const GRID_EDIT_STATES = {
  // "Leave every other line untouched" binds across sessions: a line saved
  // under one cookie is not undone by a clean sheet under the next.
  wrong: [
    {
      name: 'a first session saves a non-memo line, then a fresh one applies only the memo',
      mutate: (state) => plantGridSession(state, [['GR-1106', 18], ['GR-1104', 18]]),
    },
    {
      name: 'a first session ties the clean one on three saves, one of them a non-memo line',
      mutate: (state) =>
        plantGridSession(state, [['GR-1102', 40], ['GR-1104', 18], ['GR-1106', 18]]),
    },
    {
      name: 'a later stray session saves a non-memo line',
      mutate: (state) => plantGridSession(state, [['GR-1123', 250]], { later: true }),
    },
  ],
  alsoCorrect: [
    {
      name: 'a first session opens an editor and saves the unchanged value',
      mutate: (state) => plantGridSession(state, [['GR-1106', 81]]),
    },
    {
      name: 'a first session applies one memo correction before the browser applies all three',
      mutate: (state) => plantGridSession(state, [['GR-1104', 18]]),
    },
    {
      name: 'a first session loads the sheet and saves nothing',
      mutate: (state) => plantGridSession(state, []),
    },
  ],
};
