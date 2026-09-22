// pages/status/ - Nimbrel Edge public status page (status-flash).
import { randomBytes } from 'node:crypto';
import { DAY_MS, dayText, utcDay } from './lib.mjs';

// The probe code and the relay state the validator grades are minted here per
// session from randomBytes, so neither exists under pages/. The page's static
// incident references share the NE-<5 hex> shape by design (they are the
// plausible-wrong answers), so the mint redraws on a collision with any of
// them; a minted code therefore never equals a reference readable on disk.
const STATUS_RELAY_STATES = ['operational', 'degraded', 'congested'];

// A session keeps its most recent checks only: the validator grades the latest,
// the page lists eight, and a script looping the check cannot grow the log (or
// the collision set the mint scans) without bound.
const STATUS_CHECKS_KEPT = 50;

const STATUS_COMPONENTS = ['edge', 'relay', 'api', 'panel', 'logs'];

// The page lists this many checks, and GET /api/status/checks returns them.
const STATUS_CHECKS_LISTED = 8;

const MIN_MS = 60000;
const UPTIME_DAYS = 90;

// The one open incident is dated from the session, so it is always as recent
// as the page says: it opened 2 hr 18 min before the session's first page,
// and each update follows the opening by a fixed offset. The resolved ones
// are history and keep their stamps, copied from pages/status/history.html
// and pages/status/incidents/: an incident edited there is edited here too,
// or the uptime bars stop agreeing with the list.
const OPEN_INCIDENT = {
  ref: 'NE-2D08F',
  component: 'logs',
  impact: 'degraded',
  openedBefore: 138 * MIN_MS,
  updates: [
    { state: 'Investigating', after: 0 },
    { state: 'Identified', after: 29 * MIN_MS },
    { state: 'Monitoring', after: 113 * MIN_MS },
  ],
};
const RESOLVED_INCIDENTS = [
  { ref: 'NE-C214A', component: 'relay', impact: 'degraded', from: '2026-07-21T09:14Z', to: '2026-07-21T11:47Z' },
  { ref: 'NE-77D02', component: 'panel', impact: 'partial', from: '2026-07-14T15:03Z', to: '2026-07-14T15:26Z' },
  { ref: 'NE-4B9E1', component: 'relay', impact: 'degraded', from: '2026-07-03T19:41Z', to: '2026-07-03T21:05Z' },
  { ref: 'NE-05F1B', component: 'api', impact: 'partial', from: '2026-06-19T02:12Z', to: '2026-06-19T02:58Z' },
  { ref: 'NE-1A9C4', component: 'panel', impact: 'degraded', from: '2026-05-28T13:20Z', to: '2026-05-28T14:02Z' },
  { ref: 'NE-B7730', component: 'edge', impact: 'degraded', from: '2026-05-11T08:47Z', to: '2026-05-11T10:15Z' },
].map((inc) => ({ ...inc, from: Date.parse(inc.from), to: Date.parse(inc.to) }));

// The trailing window ends on the session's day. A component's figure is the
// share of the window no listed incident touched; announced maintenance
// (NE-E60D3) is excluded, as the definitions page says. Each day an incident
// touched is marked with the worse impact of that day's incidents.
function uptimeSummary(session, now) {
  const openedAt = session.createdAt - OPEN_INCIDENT.openedBefore;
  const incidents = [...RESOLVED_INCIDENTS, { ...OPEN_INCIDENT, from: openedAt, to: now }];
  const last = utcDay(session.createdAt);
  const first = last - (UPTIME_DAYS - 1) * DAY_MS;
  const end = last + DAY_MS;
  const components = STATUS_COMPONENTS.map((key) => {
    let affected = 0;
    const days = new Map();
    for (const inc of incidents) {
      if (inc.component !== key) continue;
      const from = Math.max(inc.from, first);
      const to = Math.min(inc.to, end);
      if (to <= from) continue;
      affected += to - from;
      for (let day = utcDay(from); day < to; day += DAY_MS) {
        const mark = days.get(day) ?? { index: (day - first) / DAY_MS, impact: 'degraded', refs: [] };
        if (inc.impact === 'partial') mark.impact = 'partial';
        mark.refs.push(inc.ref);
        days.set(day, mark);
      }
    }
    const share = 1 - affected / (UPTIME_DAYS * DAY_MS);
    return {
      key,
      uptime: (Math.floor(share * 10000) / 100).toFixed(2),
      days: [...days.entries()]
        .sort(([a], [b]) => a - b)
        .map(([day, mark]) => ({ ...mark, day: dayText(day, { weekday: false }) })),
    };
  });
  return {
    now,
    window: { days: UPTIME_DAYS, from: dayText(first, { weekday: false }), to: dayText(last, { weekday: false }) },
    incident: {
      ref: OPEN_INCIDENT.ref,
      openedAt,
      updates: OPEN_INCIDENT.updates.map((u) => ({ state: u.state, at: openedAt + u.after })),
    },
    components,
  };
}

const STATUS_SCOPES = ['all', 'unplanned', 'major'];

const STATUS_STATIC_REFS = new Set([
  'NE-2D08F', 'NE-C214A', 'NE-77D02', 'NE-4B9E1',
  'NE-05F1B', 'NE-E60D3', 'NE-1A9C4', 'NE-B7730',
]);

function mintProbeCode(taken) {
  let code;
  do {
    code = 'NE-' + randomBytes(3).toString('hex').slice(0, 5).toUpperCase();
  } while (STATUS_STATIC_REFS.has(code) || taken.has(code));
  return code;
}

// The relay state is drawn once per session so every check an agent runs
// reports the same state: a re-check can never contradict the answer the
// first check gave.
function statusProbeState(session) {
  session.statusProbe ??= {
    relayState: STATUS_RELAY_STATES[randomBytes(1)[0] % STATUS_RELAY_STATES.length],
    checks: [],
    offPage: 0,
  };
  return session.statusProbe;
}

export function routes(ctx) {
  const { json, readBody, requireSession, fromPage } = ctx;
  const fromStatus = fromPage('/status/');
  return async (req, res, url, pathname0) => {
    // T062 status-flash: each check mints a fresh probe code on the session,
    // so the graded pair (code, state) is server-held, cleared by
    // state.reset(), and unforgeable through /api/beacon. The page flashes the
    // result in an aria-live region for ~4s and appends it permanently to the
    // Recent checks list, which is the winnable read for a slow snapshot loop.
    if (req.method === 'POST' && pathname0 === '/api/status/check') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const probe = statusProbeState(found.session);
      const check = {
        probeCode: mintProbeCode(new Set(probe.checks.map((c) => c.probeCode))),
        at: Date.now(),
      };
      probe.checks.push(check);
      if (probe.checks.length > STATUS_CHECKS_KEPT) probe.checks.shift();
      // Legibility, never proof (curl sets these headers freely): a shell
      // check holding a live cookie still mints, it is just visible as
      // off-page in the validator's detail line.
      if (!fromStatus(req)) probe.offPage += 1;
      return json(res, 200, {
        probeCode: check.probeCode,
        component: 'Relay mesh',
        state: probe.relayState,
        at: check.at,
      });
    }

    // The Recent checks list the page renders on load, newest first. Reading it
    // mints nothing, so a reload is a second route to the graded pair.
    if (req.method === 'GET' && pathname0 === '/api/status/checks') {
      const found = requireSession(req, res);
      if (!found) return;
      const probe = found.session.statusProbe;
      const checks = (probe?.checks ?? []).slice(-STATUS_CHECKS_LISTED).reverse().map((c) => ({
        probeCode: c.probeCode,
        component: 'Relay mesh',
        state: probe.relayState,
        at: c.at,
      }));
      return json(res, 200, { checks });
    }

    if (req.method === 'GET' && pathname0 === '/api/status/summary') {
      const found = requireSession(req, res);
      if (!found) return;
      return json(res, 200, uptimeSummary(found.session, Date.now()));
    }

    // The subscribe page's confirmation step. Ungraded; the list lives on the
    // session so state.reset() clears it.
    if (req.method === 'POST' && pathname0 === '/api/status/subscribe') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const addr = String(payload.addr ?? '').trim().slice(0, 254);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
        return json(res, 422, { ok: false, error: 'That email address is not complete.' });
      }
      const components = (Array.isArray(payload.components) ? payload.components : [])
        .filter((c) => STATUS_COMPONENTS.includes(c));
      if (!components.length) {
        return json(res, 422, { ok: false, error: 'Pick at least one component to follow.' });
      }
      const scope = STATUS_SCOPES.includes(payload.scope) ? payload.scope : STATUS_SCOPES[0];
      const subs = (found.session.statusSubs ??= []);
      if (subs.length < STATUS_CHECKS_KEPT) subs.push({ addr, components, scope, at: Date.now() });
      return json(res, 200, { ok: true, addr, components, scope, confirmed: false });
    }

    return false;
  };
}
