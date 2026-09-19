// Golden paths for the Quotient site (pages/quotient/): silent-throw and
// mid-flight-rate. See probes.mjs for the driver contract.
//
// Both tasks measure the console/network/debugger axis, so neither is
// solvable from the snapshot alone by design: silent-throw's page renders
// NOTHING on failure, and mid-flight-rate's graded value exists only in one
// response body and one transient stack frame. The drivers therefore lean on
// evaluate_script, which is the honest route for today's tool surface: our
// console entries carry no stack (measured), and the debugger tools error on
// Firefox < 153, so instrumentation before the triggering click is the one
// route that always works.

import { ANSWERS } from '../answers.mjs';
import { addSession, findSession, straySession, until, uidOf } from './lib.mjs';

// Which helper reads which batch field. Fixed public knowledge from
// pages/quotient/app.js; which PAIR is broken is the per-session draw.
const FIELD_HELPERS = Object.fromEntries(
  ANSWERS.quotient.batchFields.map(({ field, helper }) => [field, helper])
);

// The field a 200 batch body lacks: the session's draw, read as a curl
// probe reads it.
const omittedFrom = (body) => Object.keys(FIELD_HELPERS).find((k) => !(k in (body ?? {})));

export const DRIVERS = {
  'silent-throw': {
    note:
      'instruments window "error" via evaluate_script BEFORE the one-shot click; ' +
      'our console entry for the throw carries no stack, so the wrapper is the ' +
      'attribution route; curl probes draw stray batches first, so selection ' +
      'must prefer the page-served session',
    // Static wrong for --extract: renderCards is in app.js but is not one of
    // the eight helpers, and rows is never the omitted field.
    wrong:
      'The reconciliation fails because renderCards throws an uncaught TypeError: ' +
      'the batch response is missing its rows field.',
    async run({ goto, mcp, snapshot, evaluate, base }) {
      // Curl probes sent ahead of the run, each drawing its own one-shot
      // batch: the validator must grade the session that ran the
      // reconciliation through the page, not a stray draw an answer names.
      const strayDraw = async () => {
        const stray = await straySession(base, '/quotient/reconcile.html', { nonce: 'QT_NONCE', reply: 'response' });
        const { status, body } = await stray.get('/api/quotient/batch');
        const omitted = status === 200 ? omittedFrom(body) : null;
        if (!omitted) throw new Error(`a stray batch answered ${status} with no omitted field`);
        return omitted;
      };
      const strays = [];
      for (let i = 0; i < 3; i++) strays.push(await strayDraw());
      await goto('/quotient/reconcile.html');
      // The batch is one-shot, so attribution has to be armed before the
      // first click: an uncaught TypeError's stack exists only at throw time.
      await evaluate(`() => {
        window.__reconErrors = [];
        window.addEventListener('error', (event) => {
          const err = event.error;
          window.__reconErrors.push({
            message: String((err && err.message) || event.message || ''),
            stack: String((err && err.stack) || ''),
          });
        });
      }`);
      const run = uidOf(await snapshot(), 'button "Run reconciliation"');
      if (!run) throw new Error('the Run reconciliation button is not in the snapshot');
      await mcp('click_by_uid', { uid: run });
      const caught = await until('a page error after Run reconciliation', async () => {
        const errors = await evaluate('() => window.__reconErrors');
        return Array.isArray(errors) && errors.length ? errors[0] : null;
      });
      // Firefox: 'can\'t access property "rates", batch.fx is undefined'.
      const field = /batch\.(\w+) is undefined/.exec(caught.message)?.[1];
      // First app.js frame whose name is a plain identifier: an arrow inside
      // a helper stringifies as "helperName/<@...", which the anchored match
      // skips in favour of the named helper frame below it.
      const frame = /(?:^|\n)([A-Za-z_$][\w$]*)@[^\n]*app\.js/.exec(caught.stack)?.[1];
      if (!field || !frame) {
        throw new Error(`could not parse the failure: ${caught.message}`);
      }
      if (FIELD_HELPERS[field] !== frame) {
        throw new Error(`stack frame ${frame} does not match omitted field ${field}`);
      }
      // The page must have swallowed it: busy indicator gone, no error text.
      const after = await snapshot();
      if (/Running reconciliation/.test(after) || /TypeError/i.test(after)) {
        throw new Error('the failure leaked into the page');
      }
      // Observe the decoy exactly the way an out-of-band re-fetch would, so
      // the wrongFields below are the real trap, not an invented one.
      const replay = await evaluate(`async () => {
        const r = await fetch('/api/quotient/batch', {
          headers: { 'X-Session-Nonce': window.QT_NONCE },
        });
        const body = await r.json();
        return { status: r.status, keys: Object.keys(body.batch ?? {}) };
      }`);
      if (replay?.status !== 410) {
        throw new Error(`replaying the one-shot batch answered ${replay?.status}, not 410`);
      }
      const decoy = Object.keys(FIELD_HELPERS).find((k) => !replay.keys.includes(k));
      if (!decoy || decoy === field) {
        throw new Error(`the 410 reference copy omits ${decoy}, expected a different field`);
      }
      // A stray draw distinct from both the page's draw and its decoy, so
      // naming it is wrong for a reason no other pin already covers.
      let strayField = strays.find((f) => f !== field && f !== decoy);
      for (let i = 0; !strayField && i < 20; i++) {
        const f = await strayDraw();
        if (f !== field && f !== decoy) strayField = f;
      }
      if (!strayField) throw new Error(`no stray draw differed from ${field} and ${decoy}`);
      const strayFields = { throwingFunction: FIELD_HELPERS[strayField], missingField: strayField };
      const fields = { throwingFunction: frame, missingField: field };
      this.wrong = [
        this.wrong,
        `The 410 reference copy shows the batch without its ${decoy} field, so ` +
          `${FIELD_HELPERS[decoy]} is what throws.`,
        `${frame} throws an uncaught TypeError because batch.${decoy} is undefined.`,
      ].flat();
      this.alsoCorrect = [
        `Replaying /api/quotient/batch answers 410 with a reference copy that omits ` +
          `${decoy}, but the batch the page actually ran was missing ${field}: ` +
          `${frame} threw "batch.${field} is undefined" and the page swallowed it.`,
        `Throwing function: ${frame}\nMissing field: ${field}`,
        `The silent failure is ${frame.toLowerCase()} reading the absent ${field} ` +
          `field of the batch response.`,
      ];
      this.wrongFields = [
        // Trusted the 410 reference copy wholesale.
        { throwingFunction: FIELD_HELPERS[decoy], missingField: decoy },
        // Right function, decoy field, and vice versa.
        { throwingFunction: frame, missingField: decoy },
        { throwingFunction: FIELD_HELPERS[decoy], missingField: field },
        // Swapped bindings.
        { throwingFunction: field, missingField: frame },
        // A curl probe's draw, made before the page run.
        strayFields,
        // A qualified wrong helper, and two helpers where one is asked for.
        { throwingFunction: `Reconciler.${FIELD_HELPERS[decoy]}`, missingField: field },
        { throwingFunction: `${frame} / ${FIELD_HELPERS[decoy]}`, missingField: field },
        // The decoy helper behind the source location a right answer may carry.
        { throwingFunction: `${FIELD_HELPERS[decoy]}() in app.js`, missingField: field },
        // Another app.js function named as the thrower, the helper as context.
        { throwingFunction: `runReconciliation (via ${frame})`, missingField: field },
        { throwingFunction: `renderCards after ${frame}`, missingField: field },
        { throwingFunction: `the caller of ${frame}`, missingField: field },
      ];
      this.alsoCorrectFields = [
        fields,
        { throwingFunction: `${frame}()`, missingField: `batch.${field}` },
        { throwingFunction: frame.toLowerCase(), missingField: field.toUpperCase() },
        // The helper named with a qualifier or its source file. app.js is a
        // classic script, so its functions are window properties.
        { throwingFunction: `window.${frame}`, missingField: field },
        { throwingFunction: `Reconciler.${frame}`, missingField: field },
        { throwingFunction: `${frame} (app.js)`, missingField: field },
        { throwingFunction: `${frame}() in app.js`, missingField: field },
        { throwingFunction: `${frame} on line 21 of app.js`, missingField: field },
      ];
      const pageServed = (s) => Boolean(s.quotient?.batch?.servedFromPage);
      this.alsoCorrectState = [
        {
          // No page-served session at all: the answer is graded against the
          // shell's own draws.
          name: 'a pure shell run is graded on its own draw',
          mutate(state) {
            for (const [sid, s] of [...state.sessions]) if (pageServed(s)) state.sessions.delete(sid);
          },
          fields: strayFields,
        },
        {
          // A later session that also ran the batch through the page (a
          // re-run under a fresh cookie; a forged Referer looks the same) is
          // graded on its own one-shot draw.
          name: 'a second page-served session is graded on its own draw',
          mutate(state) {
            const page = findSession(state, pageServed).session;
            addSession(state, {
              quotient: {
                batch: {
                  ...page.quotient.batch,
                  omitted: strayField,
                  helper: FIELD_HELPERS[strayField],
                  servedAt: page.quotient.batch.servedAt + 1,
                },
                quotes: [],
                offPageQuotes: 0,
              },
            });
          },
          fields: strayFields,
        },
      ];
      return {
        text:
          `Running the reconciliation fails silently: the batch response from ` +
          `/api/quotient/batch is missing its ${field} field, so ${frame} in app.js ` +
          `throws an uncaught TypeError (batch.${field} is undefined) and the page ` +
          `renders nothing.`,
        fields,
      };
    },
  },

  'mid-flight-rate': {
    note:
      'wraps Response.prototype.json via evaluate_script before the first ' +
      'quote; the debugger route (set_logpoint on quote.js line 19) needs ' +
      'Firefox 153+ and is covered in the staging self-test notes',
    // Static wrong for --extract: plausible-looking 4dp figure outside the
    // mint range [1.0500, 1.4999], so it can never be a session's rate.
    wrong: 'The rate multiplier applied to the second quote was 1.5300.',
    async run({ goto, mcp, snapshot, evaluate, base: origin }) {
      // A curl client can send a lane that is not a string; the quote must
      // still be recorded under the lane it priced, or no validator can ever
      // match it.
      const stray = await straySession(origin, '/quotient/quote.html', { nonce: 'QT_NONCE', reply: 'response' });
      const odd = await stray.post('/api/quotient/quote', { lane: ['casterway'], weight: 65 });
      if (odd.status !== 200 || odd.body.lane !== 'casterway') {
        throw new Error(`an array lane was echoed as ${JSON.stringify(odd.body.lane)} (${odd.status})`);
      }
      await goto('/quotient/quote.html');
      const price = async (laneValue, weight) => {
        const radio = uidOf(await snapshot(), `input[^\\n]*value="${laneValue}"`);
        if (!radio) throw new Error(`no lane radio for ${laneValue} in the snapshot`);
        await mcp('click_by_uid', { uid: radio });
        const box = uidOf(await snapshot(), 'input "Weight in kilograms"');
        if (!box) throw new Error('no weight input in the snapshot');
        await mcp('fill_by_uid', { uid: box, value: String(weight) });
        const button = uidOf(await snapshot(), 'button "Price it"');
        if (!button) throw new Error('no Price it button in the snapshot');
        await mcp('click_by_uid', { uid: button });
      };

      // The instrumentation the ask exists to force, armed before every
      // quote: the rate is destructured and dropped by the page - it exists
      // only while the response is being read. Catching the exploratory and
      // Harlow rates too gives the driver its order and index wrong pins.
      await evaluate(`() => {
        window.__seenRates = [];
        const original = Response.prototype.json;
        Response.prototype.json = async function () {
          const value = await original.call(this);
          if (value && typeof value.rate === 'number') window.__seenRates.push(value.rate);
          return value;
        };
      }`);
      const seenRates = (n, label) =>
        until(label, async () => {
          const rates = (await evaluate('() => window.__seenRates')) ?? [];
          return rates.length >= n ? rates : null;
        }, { tries: 30, gap: 200 });
      // An exploratory quote of the second asked shipment before following
      // the ask: its rate was applied to a Casterway 65 kg quote, but not to
      // the one priced after the Harlow shipment, so it must fail. The Harlow
      // rate then sits second in the quote list, the index-answer pin.
      await price('casterway', 65);
      const exploreRate = (await seenRates(1, 'the fetch wrapper to see the exploratory rate'))[0];
      await price('harlow-dunmere', 40);
      const harlowRate = (await seenRates(2, 'the fetch wrapper to see the Harlow rate'))[1];
      await price('casterway', 65);
      const rate = (await seenRates(3, 'the fetch wrapper to see the asked Casterway rate'))[2];
      const shown = await evaluate(`() => document.getElementById('total').textContent`);
      const total = Number(String(shown).replace(/[$,]/g, ''));
      // Bind the captured rate to the rendered figure: base mirrors the
      // page's Casterway card ($2.90/kg + $18.00 terminal at 65 kg).
      const base = Math.round((2.9 * 65 + 18.0) * 100) / 100;
      if (Math.round(base * rate) !== total) {
        throw new Error(`captured rate ${rate} does not produce the rendered total ${shown}`);
      }
      const round4 = (n) => Math.round(n * 10000) / 10000;
      const twoDp = Math.round(rate * 100) / 100;
      const neighbour = round4(total / base);
      // Guarded stand-ins: the exploratory and Harlow rates and the 2dp
      // truncation, nudged onto a different grid point whenever the draw makes
      // them collide with the real rate.
      const exploreWrong =
        Math.abs(exploreRate - rate) > 0.00005 ? exploreRate : round4(rate + 0.0005);
      const harlowWrong =
        Math.abs(harlowRate - rate) > 0.00005 ? harlowRate : round4(rate + 0.0002);
      const twoDpWrong = Math.abs(twoDp - rate) > 0.00005 ? twoDp : round4(rate + 0.0004);
      const fields = { rateMultiplier: rate };
      this.wrong = [
        this.wrong,
        `Reading the rates in order, the second quote I priced was the Harlow - Dunmere ` +
          `shipment, so the multiplier applied to it was ${harlowWrong.toFixed(4)}.`,
        `The rate multiplier on the Casterway quote was ${twoDpWrong.toFixed(2)}.`,
      ].flat();
      this.alsoCorrect = [
        `The wrapped response reader saw ${harlowRate.toFixed(4)} on the Harlow - Dunmere ` +
          `quote and then ${rate.toFixed(4)} on the 65 kg Casterway Corridor quote - the ` +
          `second shipment the ask names - so the multiplier applied to it was ` +
          `${rate.toFixed(4)}.`,
        `Shipment: Casterway Corridor, 65 kg\nRate multiplier: ${rate.toFixed(4)}`,
        `The server-issued multiplier for the second asked shipment works out to ${rate}.`,
      ];
      this.wrongFields = [
        // The Casterway 65 kg rate priced before the Harlow shipment: the
        // right shipment, out of the asked order.
        { rateMultiplier: exploreWrong },
        // The rate of the session's second quote by INDEX (the Harlow
        // shipment): the ask demands the rate applied to the asked-for second
        // shipment, not a position in the quote list.
        { rateMultiplier: harlowWrong },
        // One grid step off.
        { rateMultiplier: round4(rate + 0.0001) },
        { rateMultiplier: round4(rate - 0.0003) },
        // Two decimal places is not the rate.
        { rateMultiplier: twoDpWrong },
        // The back-computation the collision property defeats: total / base,
        // whenever that lands on a different grid point than the minted rate.
        { rateMultiplier: Math.abs(neighbour - rate) > 0.00005 ? neighbour : round4(rate - 0.0001) },
        // The rendered total itself.
        { rateMultiplier: total },
      ];
      this.alsoCorrectFields = [fields];
      const graded = (s) => s.quotient?.quotes?.some((q) => q.fromPage && q.rate === rate);
      const requoteRate = [1.0501, 1.0502, 1.0503, 1.0504].find((r) =>
        [exploreRate, harlowRate, rate].every((x) => Math.abs(x - r) > 0.00005)
      );
      this.wrongState = [
        {
          name: 'no Harlow 40 kg quote precedes the asked Casterway one',
          mutate(state) {
            const s = findSession(state, graded).session;
            s.quotient.quotes = s.quotient.quotes.filter((q) => q.lane !== 'harlow-dunmere');
          },
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'a re-quote of the asked Casterway shipment after the flow',
          mutate(state) {
            const s = findSession(state, graded).session;
            const last = s.quotient.quotes.at(-1);
            s.quotient.quotes.push({ ...last, rate: requoteRate, at: last.at + 1 });
          },
          fields: { rateMultiplier: requoteRate },
        },
      ];
      return {
        text:
          `After a quick exploratory quote, I priced the 40 kg Harlow - Dunmere shipment ` +
          `and then the 65 kg Casterway Corridor shipment ($${total}). Wrapping the page's ` +
          `response reader shows the server issued a rate multiplier of ` +
          `${rate.toFixed(4)} for the second asked shipment: the page multiplied the ` +
          `$${base.toFixed(2)} lane base by it and rounded to the nearest dollar.`,
        fields,
      };
    },
  },
};
