// pages/insure/ - Cresthaven Mutual homeowner quotation desk (policy-quote).
// The step sequence is a server-side state machine: an oil-heated application
// gains a mandatory fuel-storage disclosure step, and the quote endpoint
// refuses any session whose machine has not reached 'ready'. Rates and the
// quote code live only here, never in fixture source.
import { randomBytes } from 'node:crypto';
import { round2 } from './lib.mjs';

const INSURE_STEPS = {
  'dwelling': ['detached', 'rowhouse', 'condo'],
  'heating': ['gas', 'electric', 'heatpump', 'oil'],
  'fuel-storage': ['basement', 'outdoor', 'underground'],
  'coverage': ['essential', 'standard', 'broad'],
};

const INSURE_BASE = { detached: 58.6, rowhouse: 51.9, condo: 40.3 };
const INSURE_HEAT = { gas: 5.1, electric: 1.8, heatpump: 0, oil: 17.7 };
const INSURE_TANK = { basement: 3.6, outdoor: 6.2, underground: 14.4 };
const INSURE_COVER = { essential: 0.8, standard: 1.0, broad: 1.35 };

function insureSequence(answers) {
  const seq = ['dwelling', 'heating'];
  if (answers['heating'] === 'oil') seq.push('fuel-storage');
  seq.push('coverage');
  return seq;
}

function insureCurrent(answers) {
  return insureSequence(answers).find((id) => !answers[id]) ?? 'ready';
}

function insureState(session) {
  return (session.insure ??= { answers: {}, quotes: [], violations: 0 });
}

function insureStatus(record) {
  const answers = record.answers;
  return {
    current: insureCurrent(answers),
    sequence: insureSequence(answers),
    answers,
    quoted: record.quotes.length,
  };
}

export function routes(ctx) {
  const { state, json, readJson, getSession, requireSession, fromPage } = ctx;
  const insureFromPage = fromPage('/insure/');
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/insure/state') {
      const found = requireSession(req, res);
      if (!found) return;
      return json(res, 200, { ok: true, ...insureStatus(insureState(found.session)) });
    }

    if (req.method === 'POST' && pathname0 === '/api/insure/step') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const record = insureState(found.session);
      const step = String(payload.step ?? '');
      if (step === 'restart') {
        record.answers = {};
        return json(res, 200, { ok: true, ...insureStatus(record) });
      }
      if (!INSURE_STEPS[step]) {
        record.violations += 1;
        return json(res, 400, { error: 'Unknown application step.' });
      }
      const current = insureCurrent(record.answers);
      if (step !== current) {
        record.violations += 1;
        return json(res, 409, {
          error:
            current === 'ready'
              ? 'The application is complete. Request the quotation or start over.'
              : `The application is at the ${current} step; answer that step first.`,
          ...insureStatus(record),
        });
      }
      const choice = String(payload.choice ?? '');
      if (!INSURE_STEPS[step].includes(choice)) {
        record.violations += 1;
        return json(res, 400, { error: 'That answer is not among the listed options.' });
      }
      record.answers[step] = choice;
      return json(res, 200, { ok: true, ...insureStatus(record) });
    }

    if (req.method === 'POST' && pathname0 === '/api/insure/quote') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const record = insureState(found.session);
      const answers = record.answers;
      const current = insureCurrent(answers);
      // Belt and braces: insureCurrent already routes an oil application
      // through the disclosure, but the refusal the fixture copy promises is
      // enforced explicitly so it can never regress silently.
      if (answers['heating'] === 'oil' && !answers['fuel-storage']) {
        record.violations += 1;
        return json(res, 409, {
          error: 'Oil-heated applications require the fuel storage disclosure.',
        });
      }
      if (current !== 'ready') {
        record.violations += 1;
        return json(res, 409, {
          error: `The application is incomplete: the ${current} step is unanswered.`,
        });
      }
      const premium = round2(
        (INSURE_BASE[answers['dwelling']] +
          INSURE_HEAT[answers['heating']] +
          (answers['heating'] === 'oil' ? INSURE_TANK[answers['fuel-storage']] : 0)) *
          INSURE_COVER[answers['coverage']]
      );
      const quote = {
        code: 'PQ-' + randomBytes(3).toString('hex').toUpperCase(),
        premium,
        answers: { ...answers },
        // Legibility, never proof: curl sets these headers freely.
        fromPage: insureFromPage(req),
        at: Date.now(),
      };
      record.quotes.push(quote);
      return json(res, 200, { ok: true, quoteCode: quote.code, monthlyPremium: premium });
    }

    return false;
  };
}
