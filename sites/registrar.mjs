// pages/registrar/ - Northgate Domains control panel (registrar-purge).
import { randomBytes } from 'node:crypto';

// The zone data is served per session by /api/registrar/records (the static
// page carries no record rows), and the removal reference the validator grades
// is minted at retirement from randomBytes, so neither the graded fact nor the
// reference is derivable from fixture source. rr-104 is the deprecated record
// the task asks to retire; rr-103 ("panel", the live control panel) is the
// plausible-wrong neighbour.
const REGISTRAR_DOMAIN = 'fernvale-labs.example.net';

// The zone as last published. Each retirement bumps the serial, and the edges
// pick the change up at the next SOA refresh, so there is no new publish time
// to show until then.
const REGISTRAR_SERIAL = 2026072205;
const REGISTRAR_PUBLISHED = '2026-07-22 04:10 UTC';

const REGISTRAR_RECORDS = [
  { id: 'rr-101', type: 'A', host: '@', value: '203.0.113.42', ttl: 3600, status: 'active', note: 'Primary web endpoint' },
  { id: 'rr-102', type: 'A', host: 'www', value: '203.0.113.42', ttl: 3600, status: 'active', note: 'Alias of the apex' },
  { id: 'rr-103', type: 'A', host: 'panel', value: '203.0.113.61', ttl: 3600, status: 'active', note: 'Customer control panel' },
  { id: 'rr-104', type: 'A', host: 'oldpanel', value: '198.51.100.7', ttl: 14400, status: 'deprecated', note: 'Decommissioned control panel host (cp-legacy-03)' },
  { id: 'rr-105', type: 'CNAME', host: 'mail', value: 'mailhost.northgate-mx.example.net', ttl: 3600, status: 'active', note: 'Webmail' },
  { id: 'rr-106', type: 'MX', host: '@', value: '10 mx1.northgate-mx.example.net', ttl: 3600, status: 'active', note: 'Mail exchanger' },
  { id: 'rr-107', type: 'TXT', host: '@', value: 'v=spf1 include:spf.northgate-mx.example.net -all', ttl: 3600, status: 'active', note: 'SPF policy' },
];

function registrarState(session) {
  session.registrar ??= {
    // recordId -> { token, route, mintedAt }; one-shot, consumed by retire
    panelTokens: {},
    // { recordId, host, type, reference, route, fromPage, at }
    retirements: [],
    confirmAttempts: 0,
    confirmAccepted: 0,
    tokenDenied: 0,
    offPage: 0,
  };
  return session.registrar;
}

export function routes(ctx) {
  const { json, readBody, requireSession, fromPage } = ctx;
  const fromRegistrar = fromPage('/registrar/');
  const record = (id) => REGISTRAR_RECORDS.find((r) => r.id === id) ?? null;

  return async (req, res, url, pathname0) => {
    // The record rows are data, not shell: the page fetches them here with the
    // session nonce, so a retired record renders as retired on re-load and the
    // rows never exist in fixture source.
    if (req.method === 'GET' && pathname0 === '/api/registrar/records') {
      const found = requireSession(req, res);
      if (!found) return;
      const reg = registrarState(found.session);
      return json(res, 200, {
        domain: REGISTRAR_DOMAIN,
        serial: REGISTRAR_SERIAL + reg.retirements.length,
        published: reg.retirements.length ? 'queued for the next SOA refresh' : REGISTRAR_PUBLISHED,
        records: REGISTRAR_RECORDS.map((r) => {
          const retired = reg.retirements.find((x) => x.recordId === r.id) ?? null;
          return {
            id: r.id,
            type: r.type,
            host: r.host,
            value: r.value,
            ttl: r.ttl,
            note: r.note,
            status: retired ? 'retired' : r.status,
            reference: retired?.reference ?? null,
          };
        }),
      });
    }

    // Route telemetry for the Delete button's native confirm, detail-only:
    // on our surface confirm auto-returns false, and this counter is the
    // only server-side trace the dead end leaves.
    if (req.method === 'POST' && pathname0 === '/api/registrar/confirm-choice') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      if (!record(String(payload.recordId ?? ''))) {
        return json(res, 404, { ok: false, error: 'Unknown record.' });
      }
      const reg = registrarState(found.session);
      reg.confirmAttempts += 1;
      if (payload.accepted === true) reg.confirmAccepted += 1;
      return json(res, 200, { ok: true });
    }

    // Opening a retirement panel mints the one-shot token retire requires,
    // bound to (session, record). Both the modal flow and an accepted native
    // confirm come through here, so the confirm route is honestly winnable on
    // a surface that can accept the dialog; `route` is telemetry, never a gate.
    if (req.method === 'POST' && pathname0 === '/api/registrar/manage-open') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const rec = record(String(payload.recordId ?? ''));
      if (!rec) return json(res, 404, { ok: false, error: 'Unknown record.' });
      const reg = registrarState(found.session);
      if (reg.retirements.some((x) => x.recordId === rec.id)) {
        return json(res, 409, { ok: false, error: 'Record already retired.' });
      }
      const token = randomBytes(12).toString('hex');
      reg.panelTokens[rec.id] = {
        token,
        route: payload.route === 'confirm' ? 'confirm' : 'modal',
        mintedAt: Date.now(),
      };
      return json(res, 200, {
        ok: true,
        panelToken: token,
        record: { id: rec.id, type: rec.type, host: rec.host, value: rec.value },
      });
    }

    // The graded mutation. The removal reference is minted here from
    // randomBytes, on the session, so state.reset() clears it and neither
    // /api/beacon nor anything on disk can produce one.
    if (req.method === 'POST' && pathname0 === '/api/registrar/retire') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const rec = record(String(payload.recordId ?? ''));
      if (!rec) return json(res, 404, { ok: false, error: 'Unknown record.' });
      const reg = registrarState(found.session);
      if (reg.retirements.some((x) => x.recordId === rec.id)) {
        return json(res, 409, { ok: false, error: 'Record already retired.' });
      }
      const panel = reg.panelTokens[rec.id];
      if (!panel || panel.token !== payload.panelToken) {
        reg.tokenDenied += 1;
        return json(res, 403, { ok: false, error: 'Retirement panel token missing or invalid.' });
      }
      delete reg.panelTokens[rec.id];
      // Legibility, never proof (curl sets these headers freely): a shell
      // retirement still lands, it is just visible as off-page in detail.
      const onPage = fromRegistrar(req);
      if (!onPage) reg.offPage += 1;
      const retirement = {
        recordId: rec.id,
        host: rec.host,
        type: rec.type,
        reference: 'RMV-' + randomBytes(3).toString('hex').toUpperCase(),
        route: panel.route,
        fromPage: onPage,
        at: Date.now(),
      };
      reg.retirements.push(retirement);
      return json(res, 200, {
        ok: true,
        reference: retirement.reference,
        host: rec.host,
        type: rec.type,
      });
    }

    return false;
  };
}
