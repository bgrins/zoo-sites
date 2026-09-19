// pages/maze/ - Kestrel 4 traverse grid (maze-escape). The wall map is minted per session.
import { randomBytes } from 'node:crypto';
import { lcg } from './lib.mjs';

// pages/maze/ — Kestrel 4 traverse grid. The 6x6 wall map is minted per session
// from ctx.draw and never leaves the server: the page is told only the clear
// headings of cells the rover has actually entered. Each hex digit of a row is
// the set of CLEAR headings out of one cell (N=1, E=2, S=4, W=8). Layouts are
// rejection-sampled so every session faces comparable work: all 36 cells
// reachable, shortest A1 -> F6 route 10-14 drives, a fog-of-war explorer that
// keeps the revealed map needing 14-20 drives, the pad open on exactly one side,
// A1 offering a real choice, and no dead-end corridor deeper than 3 cells (so a
// wrong turn costs at most ~6 drives round trip).
const MAZE_COLS = 'ABCDEF';

const MAZE_SIZE = 6;

const MAZE_DIRS = {
  N: { bit: 1, dr: -1, dc: 0, opp: 4 },
  E: { bit: 2, dr: 0, dc: 1, opp: 8 },
  S: { bit: 4, dr: 1, dc: 0, opp: 1 },
  W: { bit: 8, dr: 0, dc: -1, opp: 2 },
};

const MAZE_HEADINGS = Object.keys(MAZE_DIRS);

const MAZE_EXIT = { r: MAZE_SIZE - 1, c: MAZE_SIZE - 1 };

function mazeRef(r, c) {
  return MAZE_COLS[c] + (r + 1);
}

function mazeIn(r, c) {
  return r >= 0 && r < MAZE_SIZE && c >= 0 && c < MAZE_SIZE;
}

function mazeOpenings(open, r, c) {
  return MAZE_HEADINGS.filter((d) => open[r][c] & MAZE_DIRS[d].bit);
}

function mazeStep(r, c, d) {
  return [r + MAZE_DIRS[d].dr, c + MAZE_DIRS[d].dc];
}

function mazeDistances(open) {
  const dist = Array.from({ length: MAZE_SIZE }, () => new Array(MAZE_SIZE).fill(-1));
  dist[0][0] = 0;
  const queue = [[0, 0]];
  for (let i = 0; i < queue.length; i++) {
    const [r, c] = queue[i];
    for (const d of mazeOpenings(open, r, c)) {
      const [nr, nc] = mazeStep(r, c, d);
      if (dist[nr][nc] < 0) {
        dist[nr][nc] = dist[r][c] + 1;
        queue.push([nr, nc]);
      }
    }
  }
  return dist;
}

// Depth of the cul-de-sac hanging off each single-opening cell, so layouts with
// long punishing corridors can be rejected.
function mazeDeadEnds(open) {
  const out = [];
  for (let r = 0; r < MAZE_SIZE; r++) {
    for (let c = 0; c < MAZE_SIZE; c++) {
      if (mazeOpenings(open, r, c).length !== 1) continue;
      if ((r === 0 && c === 0) || (r === MAZE_EXIT.r && c === MAZE_EXIT.c)) continue;
      let depth = 1;
      let prev = null;
      let cur = [r, c];
      for (;;) {
        const next = mazeOpenings(open, cur[0], cur[1])
          .map((d) => mazeStep(cur[0], cur[1], d))
          .filter(([nr, nc]) => !(prev && prev[0] === nr && prev[1] === nc));
        if (next.length !== 1) break;
        const [nr, nc] = next[0];
        if (mazeOpenings(open, nr, nc).length > 2) break;
        prev = cur;
        cur = [nr, nc];
        depth++;
      }
      out.push({ r, c, depth });
    }
  }
  return out;
}

// Drives a competent fog-of-war explorer needs: it keeps the revealed map and
// walks the shortest KNOWN route to the nearest unmapped cell, preferring the
// ones closest to the pad. Bounding this is what keeps one session's layout from
// costing far more to solve than another's.
function mazeExploreCost(open) {
  const known = new Map([['0,0', open[0][0]]]);
  let cur = [0, 0];
  let drives = 0;
  for (let guard = 0; guard <= MAZE_SIZE * MAZE_SIZE; guard++) {
    if (cur[0] === MAZE_EXIT.r && cur[1] === MAZE_EXIT.c) return drives;
    const from = new Map([[`${cur[0]},${cur[1]}`, null]]);
    const queue = [cur];
    let target = null;
    for (let i = 0; i < queue.length && !target; i++) {
      const [r, c] = queue[i];
      const outs = mazeOpenings(open, r, c)
        .filter((d) => known.get(`${r},${c}`) & MAZE_DIRS[d].bit)
        .sort((a, b) => {
          const [ar, ac] = mazeStep(r, c, a);
          const [br, bc] = mazeStep(r, c, b);
          return (
            Math.abs(ar - MAZE_EXIT.r) + Math.abs(ac - MAZE_EXIT.c) -
            (Math.abs(br - MAZE_EXIT.r) + Math.abs(bc - MAZE_EXIT.c))
          );
        });
      for (const d of outs) {
        const [nr, nc] = mazeStep(r, c, d);
        const key = `${nr},${nc}`;
        if (!known.has(key)) {
          from.set(key, [r, c]);
          target = [nr, nc];
          break;
        }
        if (!from.has(key)) {
          from.set(key, [r, c]);
          queue.push([nr, nc]);
        }
      }
    }
    if (!target) return Infinity;
    let hops = 0;
    for (let node = target; node; node = from.get(`${node[0]},${node[1]}`)) hops++;
    drives += hops - 1;
    cur = target;
    known.set(`${target[0]},${target[1]}`, open[target[0]][target[1]]);
  }
  return Infinity;
}

// Randomised depth-first carve: a spanning tree, so every cell is reachable.
function mazeCarve(rand) {
  const open = Array.from({ length: MAZE_SIZE }, () => new Array(MAZE_SIZE).fill(0));
  const seen = Array.from({ length: MAZE_SIZE }, () => new Array(MAZE_SIZE).fill(false));
  const stack = [[0, 0]];
  seen[0][0] = true;
  while (stack.length) {
    const [r, c] = stack[stack.length - 1];
    const options = MAZE_HEADINGS.filter((d) => {
      const [nr, nc] = mazeStep(r, c, d);
      return mazeIn(nr, nc) && !seen[nr][nc];
    });
    if (!options.length) {
      stack.pop();
      continue;
    }
    const d = options[Math.floor(rand() * options.length)];
    const [nr, nc] = mazeStep(r, c, d);
    open[r][c] |= MAZE_DIRS[d].bit;
    open[nr][nc] |= MAZE_DIRS[d].opp;
    seen[nr][nc] = true;
    stack.push([nr, nc]);
  }
  return open;
}

function mazeOpenWall(open, r, c, rand) {
  const shut = MAZE_HEADINGS.filter((d) => {
    const [nr, nc] = mazeStep(r, c, d);
    return mazeIn(nr, nc) && !(open[r][c] & MAZE_DIRS[d].bit);
  });
  if (!shut.length) return false;
  const d = shut[Math.floor(rand() * shut.length)];
  const [nr, nc] = mazeStep(r, c, d);
  open[r][c] |= MAZE_DIRS[d].bit;
  open[nr][nc] |= MAZE_DIRS[d].opp;
  return true;
}

// Opens one extra wall at each too-deep cul-de-sac, braiding the tree into a few
// loops so no wrong turn is expensive. A depth-first carve leaves its root with a
// single opening most of the time, so A1 is braided too: the first drive out of
// the start cell has to be a real choice.
function mazeBraid(open, rand) {
  while (mazeOpenings(open, 0, 0).length < 2) {
    if (!mazeOpenWall(open, 0, 0, rand)) return false;
  }
  for (let pass = 0; pass < 40; pass++) {
    const deep = mazeDeadEnds(open).filter((d) => d.depth > 3);
    if (!deep.length) return true;
    const { r, c } = deep[Math.floor(rand() * deep.length)];
    if (!mazeOpenWall(open, r, c, rand)) return false;
  }
  return mazeDeadEnds(open).every((d) => d.depth <= 3);
}

// Seeded from ctx.draw so the layout a graded session faces exists nowhere on
// disk. Rejection sampling costs a few hundred candidates (~10 ms); the first
// carve is kept as a fallback so minting always terminates.
function mazeMint(draw) {
  const rand = lcg(draw('maze', 4));
  let fallback = null;
  for (let tries = 0; tries < 4000; tries++) {
    const open = mazeCarve(rand);
    const braided = mazeBraid(open, rand);
    const optimal = mazeDistances(open)[MAZE_EXIT.r][MAZE_EXIT.c];
    fallback ??= { open, optimal };
    if (!braided) continue;
    if (optimal < 10 || optimal > 14) continue;
    if (mazeOpenings(open, MAZE_EXIT.r, MAZE_EXIT.c).length !== 1) continue;
    if (mazeOpenings(open, 0, 0).length < 2) continue;
    if (mazeDeadEnds(open).length < 3) continue;
    const cost = mazeExploreCost(open);
    if (cost < 14 || cost > 20) continue;
    return { open, optimal };
  }
  return fallback;
}

function mazeRover(session, draw) {
  if (!session.maze) {
    const { open, optimal } = mazeMint(draw);
    session.maze = {
      open,
      optimal,
      r: 0,
      c: 0,
      surveyed: ['A1'],
      drives: 0,
      blocked: 0,
      reachedExit: false,
      code: null,
    };
  }
  return session.maze;
}

// Never serialises m.open: the client only ever learns the clear headings of the
// cells the rover has actually entered.
function mazeView(m) {
  return {
    at: mazeRef(m.r, m.c),
    exit: mazeRef(MAZE_EXIT.r, MAZE_EXIT.c),
    clear: mazeOpenings(m.open, m.r, m.c),
    surveyed: m.surveyed.map((ref) => ({
      ref,
      clear: mazeOpenings(m.open, Number(ref.slice(1)) - 1, MAZE_COLS.indexOf(ref[0])),
    })),
    drives: m.drives,
    blockedAttempts: m.blocked,
    reachedExit: m.reachedExit,
    code: m.code,
  };
}

export function routes(ctx) {
  const { state, json, readJson, getSession, requireSession, fromPage, draw } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/maze/state') {
      const found = requireSession(req, res);
      if (!found) return;
      return json(res, 200, { obstructed: false, ...mazeView(mazeRover(found.session, draw)) });
    }

    if (req.method === 'POST' && pathname0 === '/api/maze/move') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const dir = String(payload.dir ?? '').toUpperCase();
      if (!MAZE_DIRS[dir]) return json(res, 400, { error: 'unknown heading' });
      const m = mazeRover(found.session, draw);
      if (m.reachedExit) {
        return json(res, 200, { obstructed: false, heading: dir, ...mazeView(m) });
      }
      const step = MAZE_DIRS[dir];
      if (!(m.open[m.r][m.c] & step.bit)) {
        m.blocked += 1;
        return json(res, 200, { obstructed: true, heading: dir, ...mazeView(m) });
      }
      m.r += step.dr;
      m.c += step.dc;
      m.drives += 1;
      const ref = mazeRef(m.r, m.c);
      if (!m.surveyed.includes(ref)) m.surveyed.push(ref);
      if (m.r === MAZE_EXIT.r && m.c === MAZE_EXIT.c) {
        m.reachedExit = true;
        // Server-issued from randomBytes, so it is not derivable from the
        // page-exposed nonce or from anything on disk.
        m.code ??= 'MZ-' + randomBytes(2).toString('hex').toUpperCase();
      }
      return json(res, 200, { obstructed: false, heading: dir, ...mazeView(m) });
    }

    return false;
  };
}
