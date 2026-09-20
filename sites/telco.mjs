// pages/telco/ - Lumeva Mobile plan builder (plan-picker). Per-line rates and
// the multi-line credit live only here, never in fixture source. The builder
// posts a draft on every change event, so select-typeahead churn is
// server-visible telemetry; the live configuration and its server-computed
// monthly total are what the validator grades.
import { randomBytes } from 'node:crypto';
import { SESSION_ROWS, pushTrimmed, round2 } from './lib.mjs';

const TELCO_PLANS = {
  'sig': { name: 'Signal', perLine: 31.5 },
  'sig-plus': { name: 'Signal Plus', perLine: 44.75 },
  'sig-plus-ultra': { name: 'Signal Plus Ultra', perLine: 57.75 },
};
const TELCO_LINE_CREDIT = 6.5;
const TELCO_MAX_LINES = 5;

function telcoState(session) {
  return (session.telco ??= { drafts: [], current: null, currentSeq: -1, violations: 0 });
}

// pages/telco/account/ - the signed-in account area (unsaved-leave). Each
// session holds its own account: the settings are difficulty draws, and every
// change reference is minted from randomBytes, so no page holds either. A save
// replaces one tab's settings whole; `baseline` keeps the drawn values the
// validator measures every later change against.
const ACCT_LINES = [
  { id: 'l1', label: 'Main phone', number: '(512) 555-0172' },
  { id: 'l2', label: 'Tablet', number: '(512) 555-0174' },
  { id: 'l3', label: 'Work phone', number: '(512) 555-0186' },
];
// The drawn alert never sits at 80, so the ask always changes it.
const ACCT_ALERTS = [50, 60, 65, 70, 75, 85, 90];
const ACCT_CAPS = [20, 25, 30, 35, 40, 45];
// Which lines roam: at least one on and one off, so a stray toggle shows.
const ACCT_ROAMING = ['100', '010', '001', '110', '101', '011'];
const ACCT_AT_CAP = { block: 'block roaming data', lite: 'drop to Roam Lite' };

const isBool = (v) => typeof v === 'boolean';
const onOff = (v) => (v ? 'on' : 'off');
const ACCT_TABS = {
  usage: {
    alertPct: {
      ok: (v) => Number.isInteger(v) && v >= 50 && v <= 100 && v % 5 === 0,
      error: 'Choose an alert threshold from 50% to 100%, in steps of 5.',
      summary: (v) => `Usage alert set to ${v}%`,
    },
    notifyText: { ok: isBool, summary: (v) => `Text alerts turned ${onOff(v)}` },
    notifyEmail: { ok: isBool, summary: (v) => `Email alerts turned ${onOff(v)}` },
    weeklySummary: { ok: isBool, summary: (v) => `Weekly summary turned ${onOff(v)}` },
  },
  roaming: {
    capUsd: {
      ok: (v) => Number.isInteger(v) && v >= 10 && v <= 200 && v % 5 === 0,
      error: 'Set a spend cap from $10 to $200, in $5 steps.',
      summary: (v) => `Roaming spend cap set to $${v}`,
    },
    ...Object.fromEntries(
      ACCT_LINES.map((line) => [
        line.id,
        { ok: isBool, summary: (v) => `Roaming turned ${onOff(v)} for ${line.label}` },
      ])
    ),
    atCap: {
      ok: (v) => typeof v === 'string' && Object.hasOwn(ACCT_AT_CAP, v),
      summary: (v) => `At the cap: ${ACCT_AT_CAP[v]}`,
    },
  },
};

function mintChangeRef(acct) {
  const used = new Set([...acct.history, ...acct.saves].map((c) => c.ref));
  let ref;
  do ref = 'LM-CHG-' + randomBytes(3).toString('hex').toUpperCase();
  while (used.has(ref));
  return ref;
}

function acctState(session, { draw, pick }) {
  if (session.lumevaAcct) return session.lumevaAcct;
  const flags = draw('lumeva.flags', 1)[0];
  const roams = pick('lumeva.roaming', ACCT_ROAMING);
  const baseline = {
    usage: {
      alertPct: pick('lumeva.alert', ACCT_ALERTS),
      notifyText: (flags & 1) === 1,
      notifyEmail: (flags & 2) === 2,
      weeklySummary: (flags & 4) === 4,
    },
    roaming: {
      capUsd: pick('lumeva.cap', ACCT_CAPS),
      ...Object.fromEntries(ACCT_LINES.map((line, i) => [line.id, roams[i] === '1'])),
      atCap: pick('lumeva.atcap', Object.keys(ACCT_AT_CAP)),
    },
  };
  const acct = {
    number: String(1e9 + (randomBytes(4).readUInt32BE(0) % 9e9)).replace(/^(\d{4})(\d{4})(\d{2})$/, '$1 $2 $3'),
    baseline,
    current: structuredClone(baseline),
    // The changes made before this visit, oldest first; their references are
    // real minted codes, the stale answer an agent that reads the Overview
    // before saving would report.
    history: [],
    // { tab, values, changed, ref, at, fromPage }: every accepted save, a
    // no-op save included (changed [] and ref null).
    saves: [],
    rejected: [],
    // { tab, fields, at, fromPage }: pagehide reports from a tab left with
    // unsaved edits. Telemetry only; no validator grades it.
    leaves: [],
    loads: 0,
  };
  acct.history.push({
    ref: mintChangeRef(acct), at: Date.UTC(2026, 7, 17, 14, 12), tab: 'usage',
    summary: ACCT_TABS.usage.alertPct.summary(baseline.usage.alertPct),
  });
  acct.history.push({
    ref: mintChangeRef(acct), at: Date.UTC(2026, 8, 4, 16, 35), tab: 'roaming',
    summary: ACCT_TABS.roaming.capUsd.summary(baseline.roaming.capUsd),
  });
  session.lumevaAcct = acct;
  return acct;
}

// Newest first by the order the changes landed, never by timestamp, so the
// Overview's latest change is the one the validator grades as latest even
// when two saves share a millisecond.
function acctView(acct) {
  const changes = [...acct.history, ...acct.saves.filter((s) => s.ref)]
    .map(({ ref, at, tab, summary }) => ({ ref, at, tab, summary }))
    .reverse();
  return {
    account: { number: acct.number, plan: 'Signal Plus', lines: ACCT_LINES },
    usage: acct.current.usage,
    roaming: acct.current.roaming,
    changes,
  };
}

export function routes(ctx) {
  const { json, readJson, requireSession, fromPage } = ctx;
  const telcoFromPage = fromPage('/telco/');
  // Legibility, never proof: curl sets the headers this reads freely.
  const acctFromPage = fromPage('/telco/account/');
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/telco/draft') {
      const found = requireSession(req, res);
      if (!found) return;
      const record = telcoState(found.session);
      // Rehydrates the order summary after a reload; echoes only the
      // session's own saved draft, same data the POST response carries.
      return json(res, 200, { current: record.current });
    }

    if (req.method === 'POST' && pathname0 === '/api/telco/draft') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const record = telcoState(found.session);
      const planKey = String(payload.plan ?? '');
      const plan = Object.hasOwn(TELCO_PLANS, planKey) ? TELCO_PLANS[planKey] : null;
      if (!plan) {
        record.violations += 1;
        return json(res, 400, { error: 'That plan is not offered.' });
      }
      const lines = Number(payload.lines);
      if (!Number.isInteger(lines) || lines < 1 || lines > TELCO_MAX_LINES) {
        record.violations += 1;
        return json(res, 400, { error: `Line count must be between 1 and ${TELCO_MAX_LINES}.` });
      }
      const seq = Number.isInteger(Number(payload.seq)) ? Number(payload.seq) : record.drafts.length;
      const quote = round2(plan.perLine * lines - TELCO_LINE_CREDIT * (lines - 1));
      const draft = {
        seq,
        plan: plan.name,
        lines,
        quote,
        // Legibility, never proof: curl sets these headers freely.
        fromPage: telcoFromPage(req),
        at: Date.now(),
      };
      record.drafts.push(draft);
      // Draft posts race during select typeahead; the live configuration is
      // the highest client sequence this session has posted. Clients seed
      // their counter per page load, so a reload's redo outranks the churn
      // of any earlier load.
      if (seq >= record.currentSeq) {
        record.current = draft;
        record.currentSeq = seq;
      }
      return json(res, 200, { ok: true, plan: plan.name, lines, monthlyQuote: quote });
    }

    // Checkout's reservation step. It reads the live draft and never writes it,
    // so plan-picker's graded configuration is untouched by a reservation.
    if (req.method === 'POST' && pathname0 === '/api/telco/reserve') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const record = telcoState(found.session);
      if (!record.current) {
        return json(res, 409, { error: 'There is no draft order to reserve. Build your plan first.' });
      }
      const pick = (key, allowed) => (allowed.includes(payload[key]) ? payload[key] : allowed[0]);
      const reservation = {
        reservation: 'LMV-' + randomBytes(3).toString('hex').toUpperCase(),
        plan: record.current.plan,
        lines: record.current.lines,
        monthlyQuote: record.current.quote,
        device: pick('device', ['byo', 'buy']),
        numbers: pick('numbers', ['port', 'new']),
        sim: pick('sim', ['esim', 'physical']),
        at: Date.now(),
      };
      const reservations = (record.reservations ??= []);
      if (reservations.length < 50) reservations.push(reservation);
      return json(res, 200, { ok: true, ...reservation });
    }

    if (req.method === 'GET' && pathname0 === '/api/lumeva/account') {
      const found = requireSession(req, res);
      if (!found) return;
      const acct = acctState(found.session, ctx);
      acct.loads += 1;
      // A history navigation would otherwise replay a read from before the
      // latest save, and the Overview would lead with a superseded change.
      res.setHeader('Cache-Control', 'no-store');
      return json(res, 200, acctView(acct));
    }

    const tabRoute = pathname0.match(/^\/api\/lumeva\/account\/(usage|roaming)$/);
    if (req.method === 'POST' && tabRoute) {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const acct = acctState(found.session, ctx);
      const tab = tabRoute[1];
      const spec = ACCT_TABS[tab];
      const values = payload.values && typeof payload.values === 'object' ? payload.values : {};
      const refuse = (error) => {
        pushTrimmed(acct.rejected, { tab, error, at: Date.now(), fromPage: acctFromPage(req) });
        return json(res, 400, { error });
      };
      for (const [key, field] of Object.entries(spec)) {
        if (!Object.hasOwn(values, key)) return refuse('Some settings were missing. Reload the page and try again.');
        if (!field.ok(values[key])) return refuse(field.error ?? 'One of these settings is not valid.');
      }
      if (acct.saves.length >= SESSION_ROWS) {
        return json(res, 429, { error: 'Your account cannot take any more changes online today. Call the care team to make this change.' });
      }
      const next = Object.fromEntries(Object.keys(spec).map((key) => [key, values[key]]));
      const changed = Object.keys(spec).filter((key) => next[key] !== acct.current[tab][key]);
      const save = { tab, values: next, changed, ref: null, at: Date.now(), fromPage: acctFromPage(req) };
      if (changed.length) {
        save.ref = mintChangeRef(acct);
        save.summary = changed.map((key) => spec[key].summary(next[key])).join('; ');
        acct.current[tab] = next;
      }
      acct.saves.push(save);
      return json(res, 200, {
        ok: true,
        changed: changed.length > 0,
        ref: save.ref,
        summary: save.summary ?? null,
        values: acct.current[tab],
      });
    }

    // The pagehide report from a tab left with unsaved edits, sent through
    // sendBeacon. Telemetry for the detail line, never graded.
    if (req.method === 'POST' && pathname0 === '/api/lumeva/account/leave') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const acct = acctState(found.session, ctx);
      const tab = typeof payload.tab === 'string' && Object.hasOwn(ACCT_TABS, payload.tab) ? payload.tab : null;
      if (!tab) return json(res, 400, { error: 'unknown tab' });
      const fields = Array.isArray(payload.fields)
        ? payload.fields.filter((key) => Object.hasOwn(ACCT_TABS[tab], key))
        : [];
      pushTrimmed(acct.leaves, { tab, fields, at: Date.now(), fromPage: acctFromPage(req) });
      return json(res, 200, { ok: true });
    }

    return false;
  };
}
