// pages/boxoffice/ - Aurelia Playhouse box office (seat-picker).
import { randomBytes } from 'node:crypto';
import { lcg, round2 } from './lib.mjs';

// The stalls plan for tonight's performance is minted per session from a
// seedable ctx.draw, so the sold pattern, the restricted-view seats and
// therefore which pairs satisfy the booking request exist nowhere on disk and
// move between runs. The mint places the answer constructively: one to three
// qualifying pairs (side by side, one block, full view, within the request's
// price cap), plus one of each decoy — a pair straddling the centre aisle
// (numerically consecutive, NOT side by side), an otherwise-fine pair with one
// restricted-view seat, and a premium pair whose total busts the cap. POST
// /api/boxoffice/hold re-checks every request term SERVER-side; the collection
// code is minted from randomBytes at checkout. The counter also counts
// requests it could not sell and pauses the line once there are too many,
// which throttles a caller posting pairs in turn without ever blocking a pair
// worked out from the plan.
const BOX_ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

const BOX_SEATS_PER_ROW = 12;

const BOX_AISLE_AFTER = 6;

const BOX_PRICES = { A: 44, B: 44, C: 35.5, D: 35.5, E: 28, F: 28, G: 21.5, H: 21.5 };

const BOX_LIMIT = 60;

const BOX_PARTY = 2;

const BOX_PATIENCE = 8;

const BOX_PAUSE_MS = 45000;

const BOX_PAUSE_MAX_MS = 240000;

const BOX_PATIENCE_REFUND = 1;

const BOX_BUDGET_ROWS = BOX_ROWS.filter((r) => BOX_PRICES[r] * BOX_PARTY <= BOX_LIMIT);

const BOX_PREMIUM_ROWS = BOX_ROWS.filter((r) => BOX_PRICES[r] * BOX_PARTY > BOX_LIMIT);

const BOX_SHOW = {
  title: 'The Brass Nightingale',
  strap: 'A revue in two acts',
  performance: 'This evening at 7:30',
};

const BOX_BRIEF = {
  patron: 'Booking for Mrs. Ida Carrow',
  reference: 'Enquiry 118 · collect at will-call',
  terms: [
    'Two seats together in the same block of one row',
    'Not split by the centre aisle between seats 6 and 7',
    'Full view only, no restricted-view seats at any price',
    'Total of £60.00 or less for the pair',
  ],
  note:
    'Every row breaks at the centre aisle between seats 6 and 7; a pair split ' +
    'by the aisle does not sit side by side. You told us Mrs. Carrow will not ' +
    'take restricted view at any price.',
};

const boxSeatId = (row, n) => row + n;

const boxSameBlock = (a, b) =>
  (a <= BOX_AISLE_AFTER) === (b <= BOX_AISLE_AFTER);

// Every numerically consecutive open pair in the house, sorted into the four
// kinds the mint must guarantee. Kept on the session for validator detail and
// for the golden-path driver's precondition assertions, never sent to a page.
function boxScan(open, restricted) {
  const analysis = { pairs: [], straddles: [], restrictedTraps: [], premium: [] };
  for (const row of BOX_ROWS) {
    for (let n = 1; n < BOX_SEATS_PER_ROW; n++) {
      const a = boxSeatId(row, n);
      const b = boxSeatId(row, n + 1);
      if (!open.has(a) || !open.has(b)) continue;
      const clean = !restricted.has(a) && !restricted.has(b);
      const inBudget = BOX_PRICES[row] * BOX_PARTY <= BOX_LIMIT;
      if (!boxSameBlock(n, n + 1)) {
        if (clean && inBudget) analysis.straddles.push([a, b]);
        continue;
      }
      if (!clean) {
        if (inBudget) analysis.restrictedTraps.push([a, b]);
        continue;
      }
      (inBudget ? analysis.pairs : analysis.premium).push([a, b]);
    }
  }
  return analysis;
}

// A hand-laid house used only if 200 seeded draws all fail the checks below,
// which has never been observed; it satisfies every mint guarantee.
function boxFallbackPlan() {
  const open = new Set([
    'F3', 'F4', 'H9', 'H10',
    'G6', 'G7',
    'E11', 'E12',
    'B7', 'B8',
    'A4', 'C9', 'D2', 'E5', 'G3', 'H2',
  ]);
  const restricted = new Set(['A1', 'A12', 'E12']);
  return { open, restricted, analysis: boxScan(open, restricted) };
}

function boxMintPlan(draw) {
  const rand = lcg(draw('boxoffice', 4));
  const pick = (list) => list[Math.floor(rand() * list.length)];
  for (let tries = 0; tries < 200; tries++) {
    const open = new Set();
    // Seats a placement needs kept sold (the run-enders either side of a pair,
    // the walls of the straddle trap); nothing may open them later.
    const locked = new Set();
    const restricted = new Set(['A1', 'A12']);
    const blockNeighbours = (n) =>
      [n - 1, n + 1].filter(
        (m) => m >= 1 && m <= BOX_SEATS_PER_ROW && boxSameBlock(m, n)
      );
    const place = (row, ns) => {
      const ids = ns.map((n) => boxSeatId(row, n));
      const guards = [];
      for (const n of ns) {
        for (const m of blockNeighbours(n)) {
          if (!ns.includes(m)) guards.push(boxSeatId(row, m));
        }
      }
      if (ids.some((id) => locked.has(id) || open.has(id))) return false;
      if (guards.some((id) => open.has(id))) return false;
      for (const id of ids) open.add(id);
      for (const id of guards) locked.add(id);
      return true;
    };
    // Restricted-view trap: a side pair in a cap-priced row, outer seat under
    // the circle supports.
    const trapRow = pick(BOX_BUDGET_ROWS);
    const trapLeft = rand() < 0.5;
    if (!place(trapRow, trapLeft ? [1, 2] : [11, 12])) continue;
    restricted.add(boxSeatId(trapRow, trapLeft ? 1 : 12));
    // Aisle-straddle trap: 6 and 7 open with 5 and 8 sold, so the only
    // numerically consecutive open pair in that row crosses the aisle.
    const straddleRow = pick(BOX_BUDGET_ROWS.filter((r) => r !== trapRow));
    if (!place(straddleRow, [6]) || !place(straddleRow, [7])) continue;
    const pairTarget = 1 + Math.floor(rand() * 3);
    let placedPairs = 0;
    for (let attempt = 0; attempt < 80 && placedPairs < pairTarget; attempt++) {
      const row = pick(BOX_BUDGET_ROWS);
      const start = rand() < 0.5
        ? 1 + Math.floor(rand() * (BOX_AISLE_AFTER - 1))
        : BOX_AISLE_AFTER + 1 + Math.floor(rand() * (BOX_SEATS_PER_ROW - BOX_AISLE_AFTER - 1));
      const ns = [start, start + 1];
      if (ns.some((n) => restricted.has(boxSeatId(row, n)))) continue;
      if (place(row, ns)) placedPairs += 1;
    }
    if (!placedPairs) continue;
    // Premium decoy: an open side-by-side pair whose total busts the cap.
    let premiumPlaced = false;
    for (let attempt = 0; attempt < 40 && !premiumPlaced; attempt++) {
      const row = pick(BOX_PREMIUM_ROWS);
      const start = rand() < 0.5
        ? 1 + Math.floor(rand() * (BOX_AISLE_AFTER - 1))
        : BOX_AISLE_AFTER + 1 + Math.floor(rand() * (BOX_SEATS_PER_ROW - BOX_AISLE_AFTER - 1));
      const ns = [start, start + 1];
      if (ns.some((n) => restricted.has(boxSeatId(row, n)))) continue;
      if (place(row, ns)) premiumPlaced = true;
    }
    if (!premiumPlaced) continue;
    // Scattered singles: realistic returns, never adjacent within a block so
    // they cannot mint an extra qualifying pair.
    const singleTarget = 9 + Math.floor(rand() * 5);
    for (let attempt = 0, placed = 0; attempt < 120 && placed < singleTarget; attempt++) {
      const row = pick(BOX_ROWS);
      const n = 1 + Math.floor(rand() * BOX_SEATS_PER_ROW);
      if (place(row, [n])) placed += 1;
    }
    const analysis = boxScan(open, restricted);
    if (analysis.pairs.length < 1 || analysis.pairs.length > 4) continue;
    if (!analysis.straddles.length) continue;
    if (!analysis.restrictedTraps.length) continue;
    if (!analysis.premium.length) continue;
    if (open.size < 14 || open.size > 26) continue;
    return { open, restricted, analysis };
  }
  return boxFallbackPlan();
}

function boxCounter(session, draw) {
  if (!session.boxoffice) {
    const plan = boxMintPlan(draw);
    session.boxoffice = {
      open: plan.open,
      restricted: plan.restricted,
      analysis: plan.analysis,
      views: { map: 0, list: 0, raw: 0 },
      attempts: [],
      refused: 0,
      pauses: 0,
      pausedUntil: 0,
      released: 0,
      hold: null,
      order: null,
    };
  }
  return session.boxoffice;
}

function boxSeatState(counter, row, n) {
  const id = boxSeatId(row, n);
  if (counter.order?.seats.includes(id)) return 'yours';
  if (!counter.open.has(id)) return 'sold';
  if (counter.hold?.seats.includes(id)) return 'held';
  if (counter.restricted.has(id)) return 'restricted';
  return 'open';
}

function boxView(counter) {
  return {
    show: BOX_SHOW,
    brief: BOX_BRIEF,
    aisleAfter: BOX_AISLE_AFTER,
    rows: BOX_ROWS.map((row) => ({
      row,
      price: BOX_PRICES[row],
      seats: Array.from({ length: BOX_SEATS_PER_ROW }, (_, i) => ({
        n: i + 1,
        state: boxSeatState(counter, row, i + 1),
      })),
    })),
    hold: counter.hold
      ? { id: counter.hold.id, seats: counter.hold.seats, total: counter.hold.total }
      : null,
    order: counter.order
      ? { seats: counter.order.seats, total: counter.order.total, code: counter.order.code }
      : null,
  };
}

function boxParseSeats(raw) {
  const parts = Array.isArray(raw)
    ? raw.map((s) => String(s ?? ''))
    : String(raw ?? '').split(/[\s,;+&]+/);
  const seats = [];
  for (const part of parts) {
    const flat = part.replace(/[^A-Za-z0-9]/g, '');
    if (!flat) continue;
    const m = /^(?:seat)?([A-Ha-h])0*([1-9][0-9]?)$/.exec(flat);
    if (!m || Number(m[2]) > BOX_SEATS_PER_ROW) return null;
    seats.push(m[1].toUpperCase() + Number(m[2]));
  }
  return seats;
}

export function routes(ctx) {
  const { json, readJson, requireSession, fromPage, draw } = ctx;
  const boxFromPage = fromPage('/boxoffice/');
  return async (req, res, url, pathname0) => {
    // seat-picker: the stalls plan behind pages/boxoffice/. Minted on first
    // read and pinned to the session, so state.reset() clears it between tasks
    // and neither the availability nor the collection code exists on disk.
    // ?view= names which selling surface asked (map = SVG plan, list = the
    // accessible booking page); both pages always send it, so a read that
    // names neither and does not look page-served counts as raw, which keeps
    // a shell-only solve visible in the validator's detail line. Telemetry
    // only, never a gate, since a shell can name either view or forge the
    // provenance headers.
    if (req.method === 'GET' && pathname0 === '/api/boxoffice/seats') {
      const found = requireSession(req, res);
      if (!found) return;
      const counter = boxCounter(found.session, draw);
      const named = url.searchParams.get('view');
      // Legibility, never proof: fromPage only picks the telemetry bucket an
      // unnamed request is counted under; it gates nothing.
      const view =
        named === 'list' || named === 'map'
          ? named
          : boxFromPage(req)
            ? 'map'
            : 'raw';
      counter.views[view] += 1;
      return json(res, 200, boxView(counter));
    }

    // Every term on the booking request is re-checked here, so a hold is only
    // ever accepted for a pair that genuinely satisfies the card. Refusals are
    // named plainly (the aisle refusal says which seats sit on which side) and
    // each one charges the patience count that eventually pauses the line.
    if (req.method === 'POST' && pathname0 === '/api/boxoffice/hold') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload.nonce);
      if (!found) return;
      const counter = boxCounter(found.session, draw);
      const now = Date.now();
      if (counter.pausedUntil && now >= counter.pausedUntil) {
        counter.pausedUntil = 0;
        counter.refused = Math.max(0, BOX_PATIENCE - BOX_PATIENCE_REFUND);
      }
      const seats = boxParseSeats(payload.seats);
      const record = (outcome, extra = {}) => {
        counter.attempts.push({
          seats: seats ?? String(payload.seats ?? ''),
          outcome,
          at: now,
        });
        return json(res, 200, { held: false, outcome, ...extra });
      };
      // The counter counts every request it could not sell. A pair worked out
      // from the plan costs one request, so an honest solve never comes near
      // the pause; a caller posting pairs in turn meets it within one row and
      // each further pause is twice as long. Part of the count is refunded
      // when a pause lapses, so a few misreadings never lock a run out.
      const charge = () => {
        counter.refused += 1;
        if (counter.refused < BOX_PATIENCE || counter.pausedUntil) return '';
        const wait = Math.min(BOX_PAUSE_MS * 2 ** counter.pauses, BOX_PAUSE_MAX_MS);
        counter.pauses += 1;
        counter.pausedUntil = now + wait;
        return (
          ` The counter will take no further requests on this line for ` +
          `${Math.round(wait / 1000)} seconds.`
        );
      };
      const refuse = (outcome, extra = {}) =>
        record(outcome, { ...extra, detail: `${extra.detail ?? ''}${charge()}` });
      if (counter.order) {
        return record('complete', {
          message: 'This request has been fulfilled.',
          detail: `Collection code ${counter.order.code} stands; nothing further to do.`,
        });
      }
      if (counter.pausedUntil) {
        return record('counter-busy', {
          message: 'The counter has paused this line.',
          detail:
            `Too many requests it could not sell. It will take another in ` +
            `${Math.ceil((counter.pausedUntil - now) / 1000)} seconds; work the ` +
            `pair out from the seating plan before asking again.`,
          waitSeconds: Math.ceil((counter.pausedUntil - now) / 1000),
        });
      }
      if (!seats || seats.length !== BOX_PARTY || new Set(seats).size !== BOX_PARTY) {
        return refuse('bad-seats', {
          message: `Name exactly ${BOX_PARTY} seats.`,
          detail: 'Row letter then seat number, A1 through H12.',
        });
      }
      const sold = seats.find((id) => !counter.open.has(id));
      if (sold) {
        return refuse('sold', {
          message: `${sold} has been sold.`,
          detail: 'Only seats shown open on the plan can be held.',
        });
      }
      const rows = seats.map((id) => id[0]);
      const numbers = seats.map((id) => Number(id.slice(1)));
      if (rows[0] !== rows[1]) {
        return refuse('split-rows', {
          message: 'Those seats are in different rows.',
          detail: 'The request needs one row, seats together.',
        });
      }
      if (Math.abs(numbers[0] - numbers[1]) !== 1) {
        return refuse('not-adjacent', {
          message: 'Those seats do not sit side by side.',
          detail: 'Seat numbers must run consecutively with no gap.',
        });
      }
      if (!boxSameBlock(numbers[0], numbers[1])) {
        return refuse('aisle', {
          message: `Seats ${BOX_AISLE_AFTER} and ${BOX_AISLE_AFTER + 1} sit either side of the centre aisle.`,
          detail:
            'Consecutive numbers, but the aisle runs between them; the request ' +
            'needs a pair with no gap.',
        });
      }
      const restricted = seats.find((id) => counter.restricted.has(id));
      if (restricted) {
        return refuse('restricted-view', {
          message: `${restricted} is restricted view.`,
          detail: 'The request will not take restricted view at any price.',
        });
      }
      const total = round2(seats.reduce((sum, id) => sum + BOX_PRICES[id[0]], 0));
      if (total > BOX_LIMIT) {
        return refuse('over-limit', {
          message: `Those seats come to £${total.toFixed(2)}.`,
          detail: `The request is capped at £${BOX_LIMIT.toFixed(2)} in all.`,
        });
      }
      if (counter.hold) counter.released += 1;
      counter.hold = {
        id: 'HLD-' + randomBytes(2).toString('hex').toUpperCase(),
        seats: [...seats].sort(
          (a, b) => Number(a.slice(1)) - Number(b.slice(1))
        ),
        total,
        at: now,
      };
      counter.attempts.push({ seats: counter.hold.seats, outcome: 'held', at: now });
      return json(res, 200, {
        held: true,
        outcome: 'held',
        holdId: counter.hold.id,
        seats: counter.hold.seats,
        total,
        message: 'Held at the box office.',
        detail:
          'Confirm the purchase to have a collection code issued. An ' +
          'unconfirmed hold lapses at curtain.',
      });
    }

    // The collection code is minted HERE, from randomBytes, only for a hold
    // the endpoint above already re-checked against every request term — so
    // the code the validator grades cannot be derived from the page, the
    // nonce, or anything on disk.
    if (req.method === 'POST' && pathname0 === '/api/boxoffice/checkout') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload.nonce);
      if (!found) return;
      const counter = boxCounter(found.session, draw);
      if (counter.order) {
        return json(res, 200, {
          ok: true,
          outcome: 'already-confirmed',
          code: counter.order.code,
          seats: counter.order.seats,
          total: counter.order.total,
          message: 'Already confirmed.',
        });
      }
      if (!counter.hold || String(payload.holdId ?? '') !== counter.hold.id) {
        return json(res, 200, {
          ok: false,
          outcome: 'no-hold',
          message: 'No such hold on this line.',
          detail: 'Hold seats first; the hold slip names the hold to confirm.',
        });
      }
      counter.order = {
        seats: counter.hold.seats,
        total: counter.hold.total,
        code: 'AUR-' + randomBytes(3).toString('hex').toUpperCase(),
        at: Date.now(),
      };
      counter.hold = null;
      counter.attempts.push({
        seats: counter.order.seats,
        outcome: 'confirmed',
        at: counter.order.at,
      });
      return json(res, 200, {
        ok: true,
        outcome: 'confirmed',
        code: counter.order.code,
        seats: counter.order.seats,
        total: counter.order.total,
        message: 'Purchase confirmed.',
        detail: 'Quote the collection code at the window from an hour before curtain.',
      });
    }

    return false;
  };
}
