// pages/telco/ - Lumeva Mobile plan builder (plan-picker). Per-line rates and
// the multi-line credit live only here, never in fixture source. The builder
// posts a draft on every change event, so select-typeahead churn is
// server-visible telemetry; the live configuration and its server-computed
// monthly total are what the validator grades.
import { round2 } from './lib.mjs';

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

export function routes(ctx) {
  const { json, readJson, requireSession, fromPage } = ctx;
  const telcoFromPage = fromPage('/telco/');
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

    return false;
  };
}
