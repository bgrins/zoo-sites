// pages/vault/ - Stavelock credential vault (token-rotate).
// A UK company: UK spelling, 020 7946 0xxx numbers, UK time.
import { randomBytes } from 'node:crypto';
import { DAY_MS, MONTH_NAMES, utcDay } from './lib.mjs';

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
//
// The console's "today", which the rotation-due list is worked out against, is the
// day the session opened, in UTC, and every date it shows for a secret is counted
// in days back from it, so the deploy token is overdue on any run date and a
// rotation made today falls due again after it.

// A day as the console writes it, '14 February 2026'; the seeded records carry
// two-digit days, '03 January 2026'.
function vaultDay(ms, { pad = false } = {}) {
  const at = new Date(ms);
  const day = pad ? String(at.getUTCDate()).padStart(2, '0') : at.getUTCDate();
  return `${day} ${MONTH_NAMES[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

const VAULT_SECRETS = [
  {
    id: 'sluicegate-deploy',
    name: 'sluicegate-api/deploy',
    environment: 'production',
    purpose: 'Release pipeline deploy token',
    scope: 'deploy:write, artifact:read',
    owner: 'Platform Delivery',
    issuedDaysAgo: 163,
    rotatedDaysAgo: 163,
    policyDays: 90,
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
    issuedDaysAgo: 205,
    rotatedDaysAgo: 38,
    policyDays: 180,
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
    issuedDaysAgo: 247,
    rotatedDaysAgo: 77,
    policyDays: 180,
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
    issuedDaysAgo: 110,
    rotatedDaysAgo: 110,
    policyDays: 90,
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
    issuedDaysAgo: 300,
    rotatedDaysAgo: 147,
    policyDays: 365,
    policy: 'Rotate every 365 days',
    fingerprint: '5e:83:0c:79:b1:2f',
    copyable: false,
    rotatable: false,
  },
];

// The two rotations here fall on the rotatedDaysAgo of their secrets above.
const VAULT_AUDIT_BASE = [
  { daysAgo: 1, time: '16:41', what: 'Policy PD-04 reviewed, no change', actor: 'k.arbuthnot' },
  { daysAgo: 3, time: '09:12', what: 'sluicegate-api/deploy read by pipeline lease', actor: 'svc-release' },
  { daysAgo: 6, time: '14:03', what: 'Break-glass request 4471 declined, no ticket', actor: 'security-eng' },
  { daysAgo: 38, time: '08:55', what: 'sluicegate-api/db-ro rotated', actor: 'm.tarleton' },
  { daysAgo: 77, time: '10:26', what: 'northmoor-cdn/purge rotated', actor: 'edge-platform' },
];

const VAULT_MASK = (token) => token.slice(0, 13) + '…' + token.slice(-4);

// Audit rows the server writes have to read like the seeded ones ('26 Jul 16:41'),
// so a generated row is the day and the clock time of the record itself, in UTC
// like every other date the console shows.
const VAULT_STAMP = (at) => {
  const when = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${vaultAuditDay(at)} ${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}`;
};

function vaultAuditDay(ms) {
  const at = new Date(ms);
  return `${at.getUTCDate()} ${MONTH_NAMES[at.getUTCMonth()].slice(0, 3)}`;
}

function vaultState(session) {
  return (session.vault ??= {
    today: utcDay(session.createdAt ?? Date.now()),
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
    signedOut: false,
  });
}

// A secret's dates for this session: a rotation this session made counts from
// the day it was made, and a seeded one from the console's today.
function vaultDates(vault, secret) {
  const record = vault.rotated[secret.id];
  const rotated = record ? utcDay(record.at) : vault.today - secret.rotatedDaysAgo * DAY_MS;
  const due = rotated + secret.policyDays * DAY_MS;
  return {
    issued: vaultDay(vault.today - secret.issuedDaysAgo * DAY_MS, { pad: true }),
    lastRotated: vaultDay(rotated, { pad: !record }),
    dueOn: vaultDay(due),
    overdue: due < vault.today,
  };
}

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
  // Did this read come from the console, or from a shell? Sec-Fetch-Site is a
  // forbidden header name for fetch()/XHR but `curl -H` sets it freely, so this is
  // route telemetry for `detail`, never a pass condition.
  const vaultFromPage = fromPage('/vault/');
  // Signing out of the console holds every vault route until the session signs
  // back in through the SSO button on the signed-out page.
  const signedOut = (res, vault) => {
    if (!vault.signedOut) return false;
    json(res, 401, { error: 'signed out' });
    return true;
  };
  return async (req, res, url, pathname0) => {
    if (req.method === 'POST' && (pathname0 === '/api/vault/signout' || pathname0 === '/api/vault/signin')) {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { error: 'Malformed request body.' });
      }
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      vaultState(found.session).signedOut = pathname0 === '/api/vault/signout';
      return json(res, 200, { ok: true });
    }

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
      if (signedOut(res, vault)) return;
      return json(res, 200, {
        team: 'Platform Delivery',
        secrets: VAULT_SECRETS.map((s) => {
          const { lastRotated, dueOn, overdue } = vaultDates(vault, s);
          return {
            id: s.id,
            name: s.name,
            environment: s.environment,
            purpose: s.purpose,
            lastRotated,
            rotatable: s.rotatable,
            dueOn,
            overdue,
          };
        }),
      });
    }

    if (req.method === 'GET' && pathname0 === '/api/vault/secret') {
      const found = requireSession(req, res);
      if (!found) return;
      const secret = VAULT_SECRETS.find((s) => s.id === url.searchParams.get('id'));
      const vault = vaultState(found.session);
      if (signedOut(res, vault)) return;
      if (!secret) return json(res, 404, { error: 'no such secret' });
      const rotation = vault.rotated[secret.id] ?? null;
      const { issued, lastRotated, dueOn, overdue } = vaultDates(vault, secret);
      return json(res, 200, {
        id: secret.id,
        name: secret.name,
        environment: secret.environment,
        purpose: secret.purpose,
        scope: secret.scope,
        owner: secret.owner,
        issued,
        lastRotated,
        policy: secret.policy,
        fingerprint: secret.fingerprint,
        copyable: secret.copyable,
        rotatable: secret.rotatable,
        masked: VAULT_MASK(vault.tokens[secret.id]),
        receipt: rotation ? rotation.receipt : null,
        dueOn,
        overdue,
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
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const secret = VAULT_SECRETS.find((s) => s.id === payload?.id);
      if (signedOut(res, vaultState(found.session))) return;
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
      const vault = vaultState(found.session);
      if (signedOut(res, vault)) return;
      if (!secret) return json(res, 404, { ok: false, error: 'no such secret' });
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
        rotatedOn: vaultDates(vault, secret).lastRotated,
      });
    }

    if (req.method === 'GET' && pathname0 === '/api/vault/audit') {
      const found = requireSession(req, res);
      if (!found) return;
      const vault = vaultState(found.session);
      if (signedOut(res, vault)) return;
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
      const seeded = VAULT_AUDIT_BASE.map(({ daysAgo, time, what, actor }) => ({
        at: `${vaultAuditDay(vault.today - daysAgo * DAY_MS)} ${time}`,
        what,
        actor,
      }));
      return json(res, 200, { entries: [...entries, ...seeded] });
    }

    return false;
  };
}
