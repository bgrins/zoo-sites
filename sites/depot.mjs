// pages/depot/ - Marlowe Depot Systems warehouse ops console (devtools suite:
// shard-forensics, body-only-ref, partial-import). Every graded value is minted
// server-side (the shard and reject picks from ctx.draw, every code from
// randomBytes) and exists in exactly one HTTP response: the failing roster
// shard and its X-Depot-Trace header, the manifest store ref (body only, never
// a header or the DOM), and the intake rejects + diag code (streamed line
// results only). pages/ holds the menu, never the answers.
import { randomBytes } from 'node:crypto';

const DEPOT_OPERATOR = { id: 'm.osei', pin: '4417' };

const DEPOT_SHARDS = [1, 2, 3, 4];

const DEPOT_INTAKE_LINES = 40;

const DEPOT_INTAKE_REJECTS = 3;

const DEPOT_ROSTER_LIVE = {
  shiftDate: 'Tue 28 Jul',
  source: 'live',
  rows: [
    { bay: 'B1', operator: 'K. Ademi', role: 'Reach truck', window: '06:00-14:00' },
    { bay: 'B2', operator: 'J. Whitlow', role: 'Counterbalance', window: '06:00-14:00' },
    { bay: 'B3', operator: 'S. Ferro', role: 'Picker lead', window: '06:00-14:00' },
    { bay: 'B4', operator: 'T. Lindqvist', role: 'Reach truck', window: '07:00-15:00' },
    { bay: 'C1', operator: 'D. Okafor', role: 'Goods-in', window: '06:00-14:00' },
    { bay: 'C2', operator: 'N. Braddock', role: 'Goods-in', window: '08:00-16:00' },
    { bay: 'D1', operator: 'P. Reyes', role: 'Despatch', window: '06:00-14:00' },
    { bay: 'D2', operator: 'A. Szabo', role: 'Despatch', window: '10:00-18:00' },
  ],
};

// Dashboard panel data: deterministic filler whose only job is to put ~12
// healthy requests around the one that matters.
const DEPOT_PANELS = {
  '/api/depot/kpis': {
    trailersTurned: 14, linesPicked: 2382, putawayBacklog: 61, lateDepartures: 1,
  },
  '/api/depot/bays': {
    bays: [
      { bay: 'D7', trailer: 'TRL-4482', carrier: 'Osprey Linehaul', state: 'Loading', tone: 'ok' },
      { bay: 'D8', trailer: 'TRL-4479', carrier: 'Ferrant & Blythe', state: 'Sealed', tone: 'ok' },
      { bay: 'D9', trailer: '-', carrier: '-', state: 'Open', tone: 'hold' },
      { bay: 'D10', trailer: 'TRL-4471', carrier: 'Cardew Freight', state: 'Tipping', tone: 'ok' },
      { bay: 'D11', trailer: 'TRL-4468', carrier: 'Skarrowby Pallet Co-op', state: 'Held', tone: 'stop' },
    ],
  },
  '/api/depot/moves': {
    moves: [
      { at: '09:42', unit: 'TRL-4482', from: 'Yard row 3', to: 'Door D7', tug: 'TUG-2' },
      { at: '09:31', unit: 'TRL-4479', from: 'Door D8', to: 'Yard row 1', tug: 'TUG-1' },
      { at: '09:18', unit: 'TRL-4471', from: 'Gatehouse', to: 'Door D10', tug: 'TUG-2' },
      { at: '08:56', unit: 'TRL-4465', from: 'Door D9', to: 'Yard row 4', tug: 'TUG-3' },
      { at: '08:47', unit: 'TRL-4468', from: 'Yard row 2', to: 'Door D11', tug: 'TUG-1' },
    ],
  },
  '/api/depot/alerts': {
    alerts: [
      { level: 'Hold', tone: 'hold', text: 'Door D11 held pending carrier paperwork.' },
      { level: 'Info', tone: 'ok', text: 'Gate 2 weighbridge recalibration 10:00-11:30.' },
      { level: 'Info', tone: 'ok', text: 'Charging bay 2 out of service.' },
    ],
  },
  '/api/depot/dock-status': {
    live: 9, held: 1, down: 2, nextArrival: '10:30',
  },
  '/api/depot/equipment': {
    units: [
      { unit: 'RT-04', holder: 'K. Ademi', due: '14:00' },
      { unit: 'CB-02', holder: 'J. Whitlow', due: '14:00' },
      { unit: 'PPT-11', holder: 'D. Okafor', due: '12:30' },
    ],
  },
  '/api/depot/throughput': {
    casesIn: 18240, casesOut: 16912, crossDock: 2204, returns: 318,
  },
  '/api/depot/notices': {
    notices: [
      { posted: '28 Jul', text: 'Gate 2 weighbridge recalibration 10:00-11:30.' },
      { posted: '27 Jul', text: 'Bays F12 to F18 released for putaway.' },
      { posted: '26 Jul', text: 'Ferrant & Blythe collections move to 14:20 from Monday.' },
    ],
  },
};

function depotState(session) {
  session.depot ??= {
    signedIn: false,
    signins: 0,
    shard: null,
    trace: null,
    rosterHits: 0,
    rosterFailures: 0,
    manifestRef: null,
    manifestHits: 0,
    intake: null,
    intakeStored: 0,
    intakePosts: 0,
    incidents: [],
  };
  return session.depot;
}

// Rejection-sampled so the per-session draws carry no modulo bias.
function depotDraw(n, draw) {
  for (;;) {
    const b = draw('depot', 1)[0];
    if (b < 256 - (256 % n)) return b % n;
  }
}

let depotManifestCache = null;

async function depotManifestKeys(ctx) {
  if (!depotManifestCache) {
    const raw = await ctx.readFile(
      ctx.join(ctx.root, 'depot', 'data', 'manifest-dm2116.txt'),
      'utf8'
    );
    depotManifestCache = new Set(
      raw
        .split('\n')
        .map((line) => line.split(',')[0].trim())
        .filter(Boolean)
    );
  }
  return depotManifestCache;
}

export function routes(ctx) {
  const { json, readJson, getSession, requireSession, draw } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'POST' && pathname0 === '/api/depot/signin') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      if (
        String(payload.operator ?? '').trim().toLowerCase() !== DEPOT_OPERATOR.id ||
        String(payload.pin ?? '').trim() !== DEPOT_OPERATOR.pin
      ) {
        return json(res, 401, { error: 'bad_credentials' });
      }
      const d = depotState(found.session);
      d.signins += 1;
      d.signedIn = true;
      // The shard draw (ctx.draw) and the trace (randomBytes) are minted once
      // per session, never from the page-exposed nonce, so a re-signin (the
      // recovery path for a surface whose network log died at navigation)
      // re-serves the SAME failure with the SAME trace.
      if (d.shard === null) {
        d.shard = DEPOT_SHARDS[depotDraw(DEPOT_SHARDS.length, draw)];
        d.trace = 'DT-' + randomBytes(4).toString('hex').toUpperCase();
      }
      return json(res, 200, { ok: true, operator: DEPOT_OPERATOR.id, shard: d.shard });
    }

    if (req.method === 'GET' && pathname0 === '/api/depot/roster') {
      const found = getSession(req);
      if (!found) return json(res, 401, { error: 'session required' });
      const d = depotState(found.session);
      if (!d.signedIn) return json(res, 401, { error: 'signin_required' });
      const shard = Number(url.searchParams.get('shard'));
      if (!DEPOT_SHARDS.includes(shard)) return json(res, 400, { error: 'unknown_shard' });
      d.rosterHits += 1;
      if (shard === d.shard) {
        d.rosterFailures += 1;
        // The trace exists ONLY in this response header, so reading it requires the
        // network log; the body deliberately repeats nothing.
        res.writeHead(502, {
          'Content-Type': 'application/json',
          'X-Depot-Trace': d.trace,
        });
        res.end(JSON.stringify({ error: 'roster_upstream_unavailable', shard }));
        return;
      }
      return json(res, 200, { shard, ...DEPOT_ROSTER_LIVE });
    }

    if (req.method === 'GET' && DEPOT_PANELS[pathname0]) {
      const found = getSession(req);
      if (!found) return json(res, 401, { error: 'session required' });
      return json(res, 200, DEPOT_PANELS[pathname0]);
    }

    if (req.method === 'GET' && pathname0 === '/api/depot/manifests') {
      const found = getSession(req);
      if (!found) return json(res, 401, { error: 'session required' });
      const d = depotState(found.session);
      d.manifestRef ??= 'MR-' + randomBytes(4).toString('hex').toUpperCase();
      d.manifestHits += 1;
      // Stable 507, session-stable ref, and the ref lives ONLY in this body:
      // not a header, not the DOM, not the console. Deliberately NOT one-shot
      // (per the proposal): an in-page re-fetch is the legitimate recovery for
      // a surface that cannot read response bodies, and manifestHits is its
      // measured price. 507 rather than 500 so a guessed modal status fails.
      return json(res, 507, {
        error: 'manifest_store_locked',
        ref: d.manifestRef,
        remedy: 'quote this reference to the ops desk to have the store lock cleared',
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/depot/intake') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const d = depotState(found.session);
      d.intakePosts += 1;
      if (d.intake) return json(res, 409, { error: 'already_posted' });
      const lines = Array.isArray(payload.lines) ? payload.lines : [];
      const keys = lines.map((l) => String(l?.key ?? '').trim());
      // The intake accepts exactly the DM-2116 manifest: fabricated line keys
      // are unknown to the depot and must not mint a gradable reject draw.
      const manifest = await depotManifestKeys(ctx);
      if (
        lines.length !== DEPOT_INTAKE_LINES ||
        keys.some((k) => !k) ||
        new Set(keys).size !== DEPOT_INTAKE_LINES ||
        !keys.every((k) => manifest.has(k))
      ) {
        return json(res, 400, { error: 'bad_manifest', expectedLines: DEPOT_INTAKE_LINES });
      }
      const picks = new Set();
      while (picks.size < DEPOT_INTAKE_REJECTS) picks.add(depotDraw(DEPOT_INTAKE_LINES, draw));
      const rejects = [...picks].sort((a, b) => a - b).map((i) => keys[i]);
      const diag = 'DG-' + randomBytes(3).toString('hex').toUpperCase();
      d.intake = { rejects, diag, at: Date.now() };
      d.intakeStored = DEPOT_INTAKE_LINES - DEPOT_INTAKE_REJECTS;
      // Streamed per-line results are the ONLY place the rejects and the diag
      // code appear; the page turns them into console.warn lines and its own
      // status line lies about full success regardless.
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
      });
      for (const key of keys) {
        res.write(
          JSON.stringify(
            rejects.includes(key)
              ? { key, ok: false, error: 'line_rejected', diag }
              : { key, ok: true }
          ) + '\n'
        );
      }
      res.end();
      return;
    }

    if (req.method === 'POST' && pathname0 === '/api/depot/incident') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const description = String(payload.description ?? '').trim().slice(0, 2000);
      if (!description) return json(res, 400, { error: 'description_required' });
      const d = depotState(found.session);
      const ticket = 'IN-' + randomBytes(2).toString('hex').toUpperCase();
      d.incidents.push({
        ticket,
        category: String(payload.category ?? '').slice(0, 80),
        location: String(payload.location ?? '').slice(0, 80),
        description,
        at: Date.now(),
      });
      return json(res, 200, { ok: true, ticket });
    }

    // This terminal's tickets, newest first, for the Recent tickets panel.
    if (req.method === 'GET' && pathname0 === '/api/depot/incidents') {
      const found = getSession(req);
      const mine = found?.session.depot?.incidents ?? [];
      return json(res, 200, {
        tickets: mine
          .slice()
          .reverse()
          .map((t) => ({ ticket: t.ticket, category: t.category, location: t.location, state: 'Review' })),
      });
    }

    return false;
  };
}
