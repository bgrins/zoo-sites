// pages/utility/ - Grelsby Water & Sewer Authority transfer desk (meter-transfer).
import { straySession } from './probes.mjs';
import { until, uidOf, bumpCode, snapText } from './lib.mjs';

export const DRIVERS = {
  'meter-transfer': {
    note:
      'naive fill+click is refused (the submit button never steals focus, so no ' +
      'blur fires); driver then discovers el.blur() via evaluate - typing the ' +
      'recorded form from the on-page hint is the other honest route',
    wrong:
      'The transfer went through. Reference 44-58291-03, meter recorded as gw 0042117 b.',
    async run({ base, goto, evaluate, mcp, snapshot }, ctx) {
      // Precondition probes on throwaway sessions, run BEFORE the honest pass
      // so their leftover state also exercises the validator's winner
      // selection. (1) The desk must refuse a raw meter id and a meter that is
      // not on the account.
      const probe = await straySession(base, '/utility/transfer.html');
      const raw = await probe.post('/api/utility/transfer', {
        meterId: 'gw 0042117 b',
        occupant: 'Dana Whitlock',
      });
      if (!raw.error || !/recorded/i.test(raw.error)) {
        throw new Error('the desk accepted an un-standardised meter number');
      }
      const wrongMeter = await probe.post('/api/utility/transfer', {
        meterId: 'GW-0042118-B',
        occupant: 'Dana Whitlock',
      });
      if (!wrongMeter.error || wrongMeter.reference) {
        throw new Error('the desk accepted a meter that is not on the account');
      }
      // (2) A completed transfer on another session with another occupant, so
      // the graded record has to be picked by reported reference.
      const rival = await straySession(base, '/utility/transfer.html');
      const rivalOut = await rival.post('/api/utility/transfer', {
        meterId: 'GW-0042117-B',
        occupant: 'M. Ordway',
      });
      if (!rivalOut.reference) throw new Error('rival transfer was not accepted');
      // (3) Transfers to near-miss occupants, which must not pass for Dana
      // Whitlock, and one naming her surname-first, which must.
      const transferTo = async (occupant) => {
        const s = await straySession(base, '/utility/transfer.html');
        const out = await s.post('/api/utility/transfer', { meterId: 'GW-0042117-B', occupant });
        if (!out.reference) throw new Error(`a transfer to ${occupant} was not accepted`);
        return out.reference;
      };
      const nearMisses = [await transferTo('Mark Whitlock'), await transferTo('Dana Whitlocke')];
      const surnameFirst = await transferTo('Whitlock, Dana');

      await goto('/utility/transfer.html');
      const snap = await snapshot();
      // The format tell the honest route-B solver reads must still be present.
      if (!snap.includes('GW-0000000-X')) {
        throw new Error('the recorded-format hint is missing from the snapshot');
      }
      const need = (pattern) => {
        const u = uidOf(snap, pattern);
        if (!u) throw new Error(`nothing matching ${pattern} in the snapshot`);
        return u;
      };
      await mcp('fill_by_uid', { uid: need('input "New account holder"'), value: 'Dana Whitlock' });
      await mcp('fill_by_uid', { uid: need('input "Meter number"'), value: 'gw 0042117 b' });
      await mcp('click_by_uid', { uid: need('button "Submit transfer request"') });
      // The naive path must be refused: fill leaves the field focused, the
      // button's mousedown handler keeps it that way, and no blur ever fires.
      const err = String(
        await until('the refusal message to render', () =>
          evaluate(() => document.getElementById('errText')?.textContent || null))
      );
      if (!/recorded/i.test(err)) {
        throw new Error(`naive submit was not refused with the format message (read "${err}")`);
      }
      const before = await evaluate(() => ({
        norm: document.getElementById('normValue')?.textContent ?? null,
        value: document.getElementById('meter').value,
      }));
      if (before.norm !== null || before.value !== 'gw 0042117 b') {
        throw new Error('the entry was standardised without a blur - the gap is gone');
      }
      // The discovery: blur via evaluate; the page standardises and shows it.
      await evaluate(() => document.getElementById('meter').blur());
      const norm = String(
        await until('the standardised meter id to render', () =>
          evaluate(() => document.getElementById('normValue')?.textContent || null))
      );
      if (norm !== 'GW-0042117-B') throw new Error(`standardiser produced "${norm}"`);
      const again = uidOf(await snapshot(), 'button "Submit transfer request"');
      if (!again) throw new Error('submit button missing after the refusal');
      await mcp('click_by_uid', { uid: again });
      const ref = await until('a transfer reference to render', async () => {
        const read = String(
          await evaluate(() => document.getElementById('refValue')?.textContent ?? '')
        );
        return /^TR-[0-9A-F]{6}$/.test(read) ? read : null;
      });
      // The confirmation panel is the designed read path: both graded values
      // must be legible on the snapshot surface, not just via the DOM reads.
      const confirmSnap = await until('the transfer reference to reach the snapshot', async () => {
        const s = await snapText(mcp, { maxLines: 500 });
        return s.includes(ref) ? s : null;
      }, { tries: 12 });
      if (!confirmSnap.includes(norm)) {
        throw new Error('the standardised meter id never reached the snapshot');
      }
      if ([rivalOut.reference, ...nearMisses, surnameFirst].includes(ref)) {
        throw new Error('a stray reference collided with the browser one');
      }
      const bumped = bumpCode(ref);
      const fields = { transferReference: ref, normalizedMeterId: norm };
      this.wrong = [
        'The transfer went through. Reference 44-58291-03, meter recorded as gw 0042117 b.',
        `Transfer submitted. Reference ${ref}; the meter number is gw 0042117 b, as on the inspection report.`,
        `Transfer accepted for M. Ordway: reference ${rivalOut.reference}, meter GW-0042117-B.`,
      ];
      this.wrongFields = [
        { transferReference: ref, normalizedMeterId: 'gw 0042117 b' },
        { transferReference: '44-58291-03', normalizedMeterId: norm },
        { transferReference: bumped, normalizedMeterId: norm },
        { transferReference: rivalOut.reference, normalizedMeterId: norm },
        { transferReference: ref, normalizedMeterId: 'GW-0042118-B' },
        { transferReference: ref, normalizedMeterId: null },
        { transferReference: null, normalizedMeterId: norm },
        ...nearMisses.map((transferReference) => ({ transferReference, normalizedMeterId: norm })),
      ];
      this.alsoCorrectFields = [
        fields,
        { transferReference: surnameFirst, normalizedMeterId: norm },
        { transferReference: ref.toLowerCase(), normalizedMeterId: norm.toLowerCase() },
        // Punctuation-adjacent renderings of the recorded value that the
        // quote-gated extractor plausibly emits; the raw dashless form stays
        // pinned as wrong above.
        { transferReference: ref, normalizedMeterId: `${norm}.` },
        { transferReference: ref, normalizedMeterId: `"${norm}"` },
        { transferReference: ref, normalizedMeterId: norm.replaceAll('-', ' - ') },
      ];
      // Extract-mode pins: answers that narrate BOTH meter forms must grade
      // on the recorded one, which the schema description steers the
      // extractor towards.
      this.alsoCorrect = [
        `The desk first refused the inspection-report reading gw 0042117 b; ` +
          `after verification it recorded the meter as ${norm}. ` +
          `Transfer reference: ${ref}.`,
        `| Field | Value |\n| --- | --- |\n` +
          `| Transfer reference | ${ref} |\n| Meter number | ${norm} |`,
        `Transfer reference: ${ref}\nMeter as recorded: ${norm}`,
      ];
      return {
        text:
          `I submitted the transfer request for Dana Whitlock. The transfer ` +
          `reference is ${ref} and the authority recorded the meter as ${norm}.`,
        fields,
      };
    },
  },
};
