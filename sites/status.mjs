// pages/status/ - Nimbrel Edge public status page (status-flash).
import { randomBytes } from 'node:crypto';

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

    return false;
  };
}
