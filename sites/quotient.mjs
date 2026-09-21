// pages/quotient/ - Quotient, a small accounting SaaS (silent-throw,
// mid-flight-rate).
//
// T121 silent-throw: GET /api/quotient/batch is session-gated and ONE-SHOT.
// The first request of a session gets the reconciliation batch with exactly
// one of its eight reference fields omitted, drawn through ctx.pick; the page
// pipes the payload through the eight helpers in pages/quotient/app.js and
// the helper that reads the omitted field throws an uncaught TypeError. Every
// later request answers 410 carrying a reference copy with a DIFFERENT field
// omitted (the decoy), so an out-of-band re-fetch reads a batch that
// contradicts the one the browser actually ran. All eight field names and all
// eight helpers are readable in app.js on disk - which one is broken this
// session is not: the source is a menu of candidates, not a solution.
//
// T124 mid-flight-rate: POST /api/quotient/quote is nonce-gated and mints a
// per-call rate multiplier (4 decimal places). The page computes
// total = base * rate, rounds to the nearest dollar, renders ONLY the total
// and never retains the rate, so the rate exists only in one HTTP response
// body and one transient stack frame. quotientMintRate guarantees the rounded
// total collides with at least QUOTIENT_MIN_COLLISIONS other candidate rates,
// so back-computing total / base cannot identify the rate. Every issued rate
// is recorded in order on the session; the validator grades a Casterway 65 kg
// quote priced after a Harlow - Dunmere 40 kg one.
import { randomBytes } from 'node:crypto';

// Field -> helper map. Mirrors pages/quotient/app.js exactly: each helper's
// first statement reads its field, so omitting the field makes that helper -
// and only that helper - throw.
export const QUOTIENT_BATCH_FIELDS = [
  { field: 'vendorAliases', helper: 'normalizeVendor' },
  { field: 'fx', helper: 'applyFxRate' },
  { field: 'taxRules', helper: 'splitTaxLines' },
  { field: 'adjustments', helper: 'mergeAdjustments' },
  { field: 'costCenters', helper: 'assignCostCenters' },
  { field: 'rounding', helper: 'applyRoundingPolicy' },
  { field: 'periods', helper: 'flagAging' },
  { field: 'ledgerMeta', helper: 'composeSummary' },
];

const QUOTIENT_ROWS = [
  { id: 'L-3021', vendor: 'HALE & PORTER LLP', currency: 'GBP', amount: 1840.0, taxCode: 'STD', account: '6020', posted: '2026-07-03', memo: 'Quarterly counsel retainer' },
  { id: 'L-3022', vendor: 'nordwind papier gmbh', currency: 'EUR', amount: 412.5, taxCode: 'RED', account: '6410', posted: '2026-07-08', memo: 'Letterhead reprint' },
  { id: 'L-3023', vendor: 'Corvid Analytics', currency: 'USD', amount: 2200.0, taxCode: 'ZERO', account: '6205', posted: '2026-06-27', memo: 'June usage true-up' },
  { id: 'L-3024', vendor: 'BRISTLECONE COURIERS', currency: 'USD', amount: 96.4, taxCode: 'STD', account: '6300', posted: '2026-07-15', memo: 'Same-day court filings' },
  { id: 'L-3025', vendor: 'Meridian Office Trust', currency: 'USD', amount: 3150.0, taxCode: 'ZERO', account: '6100', posted: '2026-07-01', memo: 'July suite licence' },
  { id: 'L-3026', vendor: 'nordwind papier gmbh', currency: 'EUR', amount: 188.2, taxCode: 'STD', account: '6410', posted: '2026-06-24', memo: 'Envelope stock' },
];

// A fresh, complete batch object per call, so deleting the omitted field can
// never mutate shared state.
function quotientBatchBody() {
  return {
    batchId: 'REC-2026-07',
    ledger: 'Supplier ledger',
    rows: QUOTIENT_ROWS.map((row) => ({ ...row })),
    vendorAliases: {
      'HALE & PORTER LLP': 'Hale & Porter',
      'NORDWIND PAPIER GMBH': 'Nordwind Papier',
      'BRISTLECONE COURIERS': 'Bristlecone Couriers',
    },
    fx: { home: 'USD', asOf: '2026-07-24', rates: { USD: 1, EUR: 1.0842, GBP: 1.2704 } },
    taxRules: { basis: 'gross', rates: { STD: 0.2, RED: 0.055, ZERO: 0 } },
    adjustments: [
      { row: 'L-3023', delta: -150, reason: 'Service credit note CN-118' },
      { row: 'L-3025', delta: 75.5, reason: 'CPI uplift arrears' },
    ],
    costCenters: {
      byAccount: { 6020: 'CC-LEGAL', 6100: 'CC-FAC', 6205: 'CC-DATA', 6300: 'CC-OPS', 6410: 'CC-PRINT' },
      fallback: 'CC-GEN',
    },
    rounding: { mode: 'half-even', precision: 2 },
    periods: { open: '2026-07', agedAfterDays: 30 },
    ledgerMeta: { journal: 'GJ-224', period: 'July 2026', preparedBy: 'M. Ashworth' },
  };
}

// Freight lane card. MUST stay identical to LANES in pages/quotient/quote.js:
// the server recomputes the page's base figure to enforce the rate-collision
// property against the exact number the page will multiply.
const QUOTIENT_LANES = {
  'harlow-dunmere': { label: 'Harlow - Dunmere', perKg: 3.62, terminal: 12.4 },
  casterway: { label: 'Casterway Corridor', perKg: 2.9, terminal: 18.0 },
  'veldt-north': { label: 'Veldt North', perKg: 3.95, terminal: 9.75 },
  'ilbrook-ferry': { label: 'Ilbrook Ferry', perKg: 2.45, terminal: 22.6 },
};

// The rate card covers 1-200 kg. The cap is load-bearing, not decorative: the
// largest reachable base is 799.75 (Veldt North at 200 kg), so one dollar of
// rounded total always spans at least 12 candidate rates on the 0.0001 grid,
// and total / base can never single out the minted rate - even for an agent
// that prices an unasked-for shipment to sharpen the division.
const QUOTIENT_WEIGHT_MIN = 1;
const QUOTIENT_WEIGHT_MAX = 200;
const QUOTIENT_RATE_MIN = 10500; // 1.0500, in 1e-4 units
const QUOTIENT_RATE_MAX = 14999; // 1.4999
const QUOTIENT_MIN_COLLISIONS = 2;

function quotientBaseFor(laneId, weight) {
  const lane = Object.hasOwn(QUOTIENT_LANES, String(laneId ?? '')) ? QUOTIENT_LANES[laneId] : null;
  return Math.round((lane.perKg * weight + lane.terminal) * 100) / 100;
}

function quotientCollisions(base, rateUnits) {
  const total = Math.round((base * rateUnits) / 10000);
  let count = 0;
  for (let r = rateUnits - 40; r <= rateUnits + 40; r += 1) {
    if (r === rateUnits || r < QUOTIENT_RATE_MIN || r > QUOTIENT_RATE_MAX) continue;
    if (Math.round((base * r) / 10000) === total) count += 1;
  }
  return count;
}

// Draw a 4dp rate whose rounded total is shared with at least two other
// candidate rates. Interior points of a dollar bucket always qualify (bucket
// width >= 1/800 dollars of rate at the largest base, i.e. >= 12 grid
// points), so the redraw loop only ever rejects edge-of-bucket draws; the
// deterministic scan is a safety net, not the expected path.
function quotientMintRate(base) {
  const span = QUOTIENT_RATE_MAX - QUOTIENT_RATE_MIN + 1;
  let units = QUOTIENT_RATE_MIN + (randomBytes(2).readUInt16BE(0) % span);
  for (let i = 0; i < 40; i += 1) {
    if (quotientCollisions(base, units) >= QUOTIENT_MIN_COLLISIONS) return units / 10000;
    units = QUOTIENT_RATE_MIN + (randomBytes(2).readUInt16BE(0) % span);
  }
  for (let step = 1; step <= 40; step += 1) {
    for (const candidate of [units + step, units - step]) {
      if (candidate < QUOTIENT_RATE_MIN || candidate > QUOTIENT_RATE_MAX) continue;
      if (quotientCollisions(base, candidate) >= QUOTIENT_MIN_COLLISIONS) return candidate / 10000;
    }
  }
  return units / 10000;
}

function quotientState(session) {
  session.quotient ??= { batch: null, quotes: [], offPageQuotes: 0 };
  return session.quotient;
}

export function routes(ctx) {
  const { json, readJson, requireSession, fromPage } = ctx;
  const fromQuotient = fromPage('/quotient/');
  return async (req, res, url, pathname0) => {
    // The reconciliation batch, one shot per session. The first request draws
    // which field is omitted; every later request is answered 410 with a
    // reference copy missing the session's DECOY field instead, so the only
    // trustworthy observation of the real batch is the one the browser
    // already made. fromPage is legibility, never proof - the counters it
    // feeds are reported in the validator's detail line, not gated on.
    if (req.method === 'GET' && pathname0 === '/api/quotient/batch') {
      const found = requireSession(req, res);
      if (!found) return;
      const q = quotientState(found.session);
      if (!q.batch) {
        // Difficulty draws (sites/README.md), so paired conditions face the
        // same broken helper: the omitted field, then the decoy among the
        // other seven.
        const fields = QUOTIENT_BATCH_FIELDS.map((f) => f.field);
        const omitted = ctx.pick('quotient.omitted', fields);
        const decoyField = ctx.pick('quotient.decoy', fields.filter((f) => f !== omitted));
        const helperOf = (field) => QUOTIENT_BATCH_FIELDS.find((f) => f.field === field).helper;
        q.batch = {
          omitted,
          helper: helperOf(omitted),
          decoyField,
          decoyHelper: helperOf(decoyField),
          servedAt: Date.now(),
          servedFromPage: fromQuotient(req),
          decoyServes: 0,
          offPageDecoyServes: 0,
        };
        const body = quotientBatchBody();
        delete body[q.batch.omitted];
        return json(res, 200, body);
      }
      q.batch.decoyServes += 1;
      // Legibility, never proof: separates page-driven decoy serves from
      // out-of-band re-fetches in detail, gating nothing.
      if (!fromQuotient(req)) q.batch.offPageDecoyServes += 1;
      const copy = quotientBatchBody();
      delete copy[q.batch.decoyField];
      return json(res, 410, {
        error: 'batch_already_issued',
        message:
          'A reconciliation batch is issued once per review session so two ' +
          'reviewers cannot post the same lines twice. A read-only reference ' +
          'copy of batch REC-2026-07 is attached.',
        batch: copy,
      });
    }

    // A freight quote. The rate multiplier is minted per call and recorded in
    // order on the session; it goes out in this response body and nowhere
    // else - the page multiplies, rounds to the dollar, shows the total and
    // drops the rate on the floor.
    if (req.method === 'POST' && pathname0 === '/api/quotient/quote') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const laneKey = String(payload?.lane ?? '');
      const lane = Object.hasOwn(QUOTIENT_LANES, laneKey) ? QUOTIENT_LANES[laneKey] : null;
      if (!lane) return json(res, 400, { error: 'Unknown lane.' });
      const weight = Number(payload?.weight);
      if (!Number.isFinite(weight) || weight < QUOTIENT_WEIGHT_MIN || weight > QUOTIENT_WEIGHT_MAX) {
        return json(res, 400, {
          error: `This rate card covers consignments from ${QUOTIENT_WEIGHT_MIN} to ${QUOTIENT_WEIGHT_MAX} kg.`,
        });
      }
      const q = quotientState(found.session);
      const base = quotientBaseFor(laneKey, weight);
      const rate = quotientMintRate(base);
      const ref = 'QF-' + randomBytes(3).toString('hex').toUpperCase();
      const onPage = fromQuotient(req);
      if (!onPage) q.offPageQuotes += 1;
      q.quotes.push({
        ref,
        lane: laneKey,
        weight,
        base,
        rate,
        total: Math.round(base * rate),
        fromPage: onPage,
        at: Date.now(),
      });
      return json(res, 200, { ref, lane: laneKey, weight, rate });
    }

    return false;
  };
}
