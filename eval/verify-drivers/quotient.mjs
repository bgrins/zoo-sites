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

import { until, uidOf } from './lib.mjs';

// Which helper reads which batch field. Fixed public knowledge from
// pages/quotient/app.js; which PAIR is broken is the per-session draw.
const FIELD_HELPERS = {
  vendorAliases: 'normalizeVendor',
  fx: 'applyFxRate',
  taxRules: 'splitTaxLines',
  adjustments: 'mergeAdjustments',
  costCenters: 'assignCostCenters',
  rounding: 'applyRoundingPolicy',
  periods: 'flagAging',
  ledgerMeta: 'composeSummary',
};

export const DRIVERS = {
  'silent-throw': {
    note:
      'instruments window "error" via evaluate_script BEFORE the one-shot click; ' +
      'our console entry for the throw carries no stack, so the wrapper is the ' +
      'attribution route',
    // Static wrong for --extract: renderCards is in app.js but is not one of
    // the eight helpers, and rows is never the omitted field.
    wrong:
      'The reconciliation fails because renderCards throws an uncaught TypeError: ' +
      'the batch response is missing its rows field.',
    async run({ goto, mcp, snapshot, evaluate }) {
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
      ];
      this.alsoCorrectFields = [
        fields,
        { throwingFunction: `${frame}()`, missingField: `batch.${field}` },
        { throwingFunction: frame.toLowerCase(), missingField: field.toUpperCase() },
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
      'wraps Response.prototype.json via evaluate_script between the first and ' +
      'second quote; the debugger route (set_logpoint on quote.js line 19) needs ' +
      'Firefox 153+ and is covered in the staging self-test notes',
    // Static wrong for --extract: plausible-looking 4dp figure outside the
    // mint range [1.0500, 1.4999], so it can never be a session's rate.
    wrong: 'The rate multiplier applied to the second quote was 1.5300.',
    async run({ goto, mcp, snapshot, evaluate }) {
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

      // An exploratory quote before following the ask: the validator must
      // grade the asked-for Casterway/65 rate wherever it sits in the quote
      // list, and an index-based answer (the Harlow rate, second in this
      // session) must fail.
      await price('veldt-north', 12);
      await until('the exploratory quote to render a total', async () =>
        /"\$([\d,]+)"/.exec(await snapshot())?.[1] ?? null, { tries: 30, gap: 200 });

      // The instrumentation the ask exists to force, armed before both asked
      // quotes: the rate is destructured and dropped by the page - it exists
      // only while the response is being read. Catching the Harlow rate too
      // gives the driver its index-answer wrong pin.
      await evaluate(`() => {
        window.__seenRates = [];
        const original = Response.prototype.json;
        Response.prototype.json = async function () {
          const value = await original.call(this);
          if (value && typeof value.rate === 'number') window.__seenRates.push(value.rate);
          return value;
        };
      }`);
      await price('harlow-dunmere', 40);
      const seenRates = (n, label) =>
        until(label, async () => {
          const rates = (await evaluate('() => window.__seenRates')) ?? [];
          return rates.length >= n ? rates : null;
        }, { tries: 30, gap: 200 });
      const harlowRate = (await seenRates(1, 'the fetch wrapper to see the first rate'))[0];
      await price('casterway', 65);
      const rate = (await seenRates(2, 'the fetch wrapper to see the second rate'))[1];
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
      // Guarded stand-ins: the Harlow rate and the 2dp truncation, nudged onto
      // a different grid point whenever the draw makes them collide with the
      // real rate.
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
