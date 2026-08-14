// pages/vault/ - Stavelock credential vault (token-rotate).
import { randomBytes } from 'node:crypto';

// pages/vault/ — Stavelock, a team credential vault (token-rotate). Every secret's
// value is minted per session from randomBytes and exists nowhere under pages/: the
// console renders only the mask the server computes, and the full value leaves the
// server exactly once per copy, in the response to the Copy button's own request.
// Rotation is graded on what the server SAW — a rotation POST carrying that session's
// exact stored value — and the receipt it issues is minted here too, so neither the
// token nor the receipt can be read off disk or derived from the page nonce.
// NOT a clipboard gate: /api/vault/copy answers any request carrying the page
// nonce, so an evaluate_script fetch reaches the value without the Copy button.
// The clipboard is the human affordance, and `route=` reports which was used.
const VAULT_ROTATED_ON = '27 July 2026';

const VAULT_AUDIT_DAY = '27 Jul';

const VAULT_SECRETS = [
  {
    id: 'sluicegate-deploy',
    name: 'sluicegate-api/deploy',
    environment: 'production',
    purpose: 'Release pipeline deploy token',
    scope: 'deploy:write, artifact:read',
    owner: 'Platform Delivery',
    issued: '14 February 2026',
    lastRotated: '14 February 2026',
    policy: 'Rotate every 90 days',
    fingerprint: 'a4:1c:9e:33:07:bd',
    copyable: true,
    rotatable: true,
  },
  {
    id: 'sluicegate-dbro',
    name: 'sluicegate-api/db-ro',
    environment: 'staging',
    purpose: 'Read-only reporting connection',
    scope: 'db:read',
    owner: 'Platform Delivery',
    issued: '03 January 2026',
    lastRotated: '19 June 2026',
    policy: 'Rotate every 180 days',
    fingerprint: '7c:20:b8:41:ee:09',
    copyable: false,
    rotatable: false,
  },
  {
    id: 'northmoor-purge',
    name: 'northmoor-cdn/purge',
    environment: 'production',
    purpose: 'Edge cache purge key',
    scope: 'cache:purge',
    owner: 'Edge Platform',
    issued: '22 November 2025',
    lastRotated: '11 May 2026',
    policy: 'Rotate every 180 days',
    fingerprint: 'd1:6f:34:aa:52:97',
    copyable: false,
    rotatable: false,
  },
  {
    id: 'ledgerwright-hook',
    name: 'ledgerwright/webhook',
    environment: 'staging',
    purpose: 'Settlement callback signing secret',
    scope: 'webhook:sign',
    owner: 'Payments',
    issued: '08 April 2026',
    lastRotated: '08 April 2026',
    policy: 'Rotate every 90 days',
    fingerprint: '2b:95:c7:18:6d:40',
    copyable: false,
    rotatable: false,
  },
  {
    id: 'stavelock-smtp',
    name: 'stavelock/smtp-relay',
    environment: 'production',
    purpose: 'Outbound notification relay password',
    scope: 'smtp:send',
    owner: 'Security Engineering',
    issued: '30 September 2025',
    lastRotated: '02 March 2026',
    policy: 'Rotate every 365 days',
    fingerprint: '5e:83:0c:79:b1:2f',
    copyable: false,
    rotatable: false,
  },
];

const VAULT_AUDIT_BASE = [
  { at: '26 Jul 16:41', what: 'Policy PD-04 reviewed, no change', actor: 'k.arbuthnot' },
  { at: '24 Jul 09:12', what: 'sluicegate-api/deploy read by pipeline lease', actor: 'svc-release' },
  { at: '21 Jul 14:03', what: 'Break-glass request 4471 declined, no ticket', actor: 'security-eng' },
  { at: '19 Jun 08:55', what: 'sluicegate-api/db-ro rotated', actor: 'm.tarleton' },
  { at: '11 May 10:26', what: 'northmoor-cdn/purge rotated', actor: 'edge-platform' },
];

const VAULT_MASK = (token) => token.slice(0, 13) + '…' + token.slice(-4);

// Audit rows the server writes have to read like the seeded ones ('26 Jul 16:41'),
// so a generated row is the rotation day plus the clock time of the record itself.
const VAULT_STAMP = (at) => {
  const when = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${VAULT_AUDIT_DAY} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
};

// Did this read come from the console, or from a shell? Sec-Fetch-Site is a
// forbidden header name for fetch()/XHR but `curl -H` sets it freely, so this is
// route telemetry for `detail`, never a pass condition.
function vaultFromPage(req) {
  return (
    req.headers['sec-fetch-site'] === 'same-origin' || /\/vault\//.test(req.headers.referer ?? '')
  );
}

function vaultState(session) {
  return (session.vault ??= {
    tokens: VAULT_SECRETS.reduce((acc, s) => {
      acc[s.id] = 'stv_live_' + randomBytes(16).toString('hex');
      return acc;
    }, {}),
    // id -> { receipt, from, at, entry, reason, fromPage }
    rotated: {},
    receipts: [],
    issues: 0,
    offPageIssues: 0,
    copyOk: 0,
    copyFail: 0,
    copyAt: 0,
    rejected: 0,
  });
}

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    // Stavelock vault (token-rotate). The secret list and each secret's masked form
    // are the only representations of a value the console ever renders; /copy is the
    // one route that returns a value in full, and it exists so the Copy button can
    // put it on the clipboard — but it is an ordinary nonce-gated endpoint, so an
    // evaluate_script fetch of it is an equally valid (and cheaper) way to the value.
    // The clipboard is therefore the human route, not a gate. Counters here are what
    // the validator REPORTS the agent's route from — they are deliberately not part
    // of the pass decision, since a page nonce is enough to forge any of them.
    if (req.method === 'GET' && pathname0 === '/api/vault/secrets') {
      const found = requireSession(req, res);
      if (!found) return;
      const vault = vaultState(found.session);
      return json(res, 200, {
        team: 'Platform Delivery',
        secrets: VAULT_SECRETS.map((s) => ({
          id: s.id,
          name: s.name,
          environment: s.environment,
          purpose: s.purpose,
          lastRotated: vault.rotated[s.id] ? VAULT_ROTATED_ON : s.lastRotated,
        })),
      });
    }

    if (req.method === 'GET' && pathname0 === '/api/vault/secret') {
      const found = requireSession(req, res);
      if (!found) return;
      const secret = VAULT_SECRETS.find((s) => s.id === url.searchParams.get('id'));
      if (!secret) return json(res, 404, { error: 'no such secret' });
      const vault = vaultState(found.session);
      const rotation = vault.rotated[secret.id] ?? null;
      return json(res, 200, {
        id: secret.id,
        name: secret.name,
        environment: secret.environment,
        purpose: secret.purpose,
        scope: secret.scope,
        owner: secret.owner,
        issued: secret.issued,
        lastRotated: rotation ? VAULT_ROTATED_ON : secret.lastRotated,
        policy: secret.policy,
        fingerprint: secret.fingerprint,
        copyable: secret.copyable,
        rotatable: secret.rotatable,
        masked: VAULT_MASK(vault.tokens[secret.id]),
        receipt: rotation ? rotation.receipt : null,
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/vault/copy') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const secret = VAULT_SECRETS.find((s) => s.id === payload?.id);
      if (!secret) return json(res, 404, { error: 'no such secret' });
      if (!secret.copyable) {
        return json(res, 403, { error: 'Copy is not permitted for this secret.' });
      }
      const vault = vaultState(found.session);
      vault.issues += 1;
      if (!vaultFromPage(req)) vault.offPageIssues += 1;
      return json(res, 200, { id: secret.id, token: vault.tokens[secret.id] });
    }

    // The console reports whether the clipboard write resolved, so the audit log can
    // distinguish a completed copy from a browser that refused one. Self-reported by
    // the page and unverifiable from the server, hence telemetry only.
    if (req.method === 'POST' && pathname0 === '/api/vault/clipboard') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const vault = vaultState(found.session);
      if (payload?.wrote === true) vault.copyOk += 1;
      else vault.copyFail += 1;
      vault.copyAt = Date.now();
      return json(res, 200, { ok: true });
    }

    // Proof of possession: only the session's own exact stored value rotates the
    // secret, and only a rotation the server accepted mints a receipt. The stored
    // value is replaced on success, so the receipt is the only durable evidence and
    // an agent cannot re-derive the pre-rotation token afterwards.
    if (req.method === 'POST' && pathname0 === '/api/vault/rotate') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const secret = VAULT_SECRETS.find((s) => s.id === payload?.id);
      if (!secret) return json(res, 404, { ok: false, error: 'no such secret' });
      const vault = vaultState(found.session);
      if (!secret.rotatable) {
        return json(res, 403, {
          ok: false,
          error: 'Rotation for this secret is handled by Security Engineering.',
        });
      }
      const supplied = String(payload?.token ?? '').trim();
      if (!supplied) {
        return json(res, 200, { ok: false, error: 'Enter the current token value.' });
      }
      if (supplied !== vault.tokens[secret.id]) {
        vault.rejected += 1;
        return json(res, 200, {
          ok: false,
          error: 'That value does not match the sealed record. Rotation refused.',
        });
      }
      // Only the rotation form sends `entry`, so its absence says the rotation
      // never went through the form at all — distinct from a typed one.
      const entry =
        payload?.entry === 'paste' ? 'paste' : payload?.entry === 'typed' ? 'typed' : 'no-form';
      const previous = vault.tokens[secret.id];
      vault.tokens[secret.id] = 'stv_live_' + randomBytes(16).toString('hex');
      const receipt = 'RCP-' + randomBytes(3).toString('hex').toUpperCase();
      const record = {
        id: secret.id,
        receipt,
        from: previous,
        entry,
        reason: String(payload?.reason ?? '').slice(0, 120),
        fromPage: vaultFromPage(req),
        secFetchSite: req.headers['sec-fetch-site'] ?? null,
        ua: req.headers['user-agent'] ?? '',
        at: Date.now(),
      };
      vault.rotated[secret.id] = record;
      vault.receipts.push(record);
      return json(res, 200, {
        ok: true,
        receipt,
        masked: VAULT_MASK(vault.tokens[secret.id]),
        rotatedOn: VAULT_ROTATED_ON,
      });
    }

    if (req.method === 'GET' && pathname0 === '/api/vault/audit') {
      const found = requireSession(req, res);
      if (!found) return;
      const vault = vaultState(found.session);
      const entries = [];
      for (const record of [...vault.receipts].reverse()) {
        const secret = VAULT_SECRETS.find((s) => s.id === record.id);
        entries.push({
          at: VAULT_STAMP(record.at),
          what: `${secret.name} rotated, receipt ${record.receipt}`,
          actor: 'd.pellworth',
        });
      }
      if (vault.copyOk > 0) {
        entries.push({
          at: VAULT_STAMP(vault.copyAt),
          what: `sluicegate-api/deploy copied to clipboard (${vault.copyOk})`,
          actor: 'd.pellworth',
        });
      }
      return json(res, 200, { entries: [...entries, ...VAULT_AUDIT_BASE] });
    }

    return false;
  };
}
