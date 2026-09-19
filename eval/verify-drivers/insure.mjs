// pages/insure/ - Cresthaven Mutual quotation desk (policy-quote).
import { bumpCode, snapText, straySession, uidOf, until } from './lib.mjs';

export const DRIVERS = {
  'policy-quote': {
    note: 'drives the branching wizard by uid; stray sessions assert the skip-refusal and shadowing',
    wrong: 'The quote came out to $33.70 a month, reference code PQ-000000.',
    async run({ base, goto, evaluate, mcp, snapshot }, ctx) {
      // Precondition probes on throwaway sessions, run BEFORE the honest pass
      // so their leftover state also exercises the validator's winner
      // selection. (1) The desk must refuse to advance past, or quote around,
      // a skipped fuel-storage disclosure.
      const skipper = await straySession(base, '/insure/quote.html');
      await skipper.post('/api/insure/step', { step: 'dwelling', choice: 'detached' });
      await skipper.post('/api/insure/step', { step: 'heating', choice: 'oil' });
      const jumped = await skipper.post('/api/insure/step', {
        step: 'coverage',
        choice: 'standard',
      });
      if (!jumped.error) {
        throw new Error('the desk accepted a coverage answer past the pending disclosure');
      }
      const early = await skipper.post('/api/insure/quote', {});
      if (!early.error || !/disclosure/i.test(early.error)) {
        throw new Error('the desk quoted an oil application that skipped the disclosure');
      }
      // (2) A completed wrong-branch quote on another session, so the graded
      // session has to be picked by reported code, not by [0] or recency.
      const rival = await straySession(base, '/insure/quote.html');
      await rival.post('/api/insure/step', { step: 'dwelling', choice: 'detached' });
      await rival.post('/api/insure/step', { step: 'heating', choice: 'gas' });
      await rival.post('/api/insure/step', { step: 'coverage', choice: 'standard' });
      const rivalQuote = await rival.post('/api/insure/quote', {});
      if (!rivalQuote.quoteCode) throw new Error('rival gas-path quote was not issued');

      await goto('/insure/quote.html');
      const pickAndContinue = async (label) => {
        const opt = await until(`option "${label}" to render`, async () =>
          uidOf(await snapshot(), `input "${label}"`));
        await mcp('click_by_uid', { uid: opt });
        const c = uidOf(await snapshot(), 'button "Continue"');
        if (!c) throw new Error(`no Continue button on the ${label} step`);
        await mcp('click_by_uid', { uid: c });
      };
      await pickAndContinue('Detached house');
      await pickAndContinue('Oil furnace');
      // The disclosure step only exists because heating=oil branched the
      // server-side sequence; reaching this option is itself the branch proof.
      await pickAndContinue('Underground tank');
      await pickAndContinue('Standard');
      const quoteUid = await until('the review step to render', async () =>
        uidOf(await snapshot(), 'button "Get my quote"'));
      await mcp('click_by_uid', { uid: quoteUid });
      const quoted = await until('the quotation to render', async () => {
        const read = await evaluate(() => ({
          code: document.getElementById('quoteCode')?.textContent ?? '',
          premium: document.getElementById('premium')?.textContent ?? '',
        }));
        if (!/^PQ-[0-9A-F]{6}$/.test(read.code)) return null;
        return {
          code: read.code,
          premium: Number(String(read.premium).replace(/[$,]/g, '')),
        };
      });
      const { code, premium } = quoted;
      if (!Number.isFinite(premium)) throw new Error('no quotation was rendered');
      // The designed read path is the quote panel itself: the code and the
      // premium must be legible on the snapshot surface, not just in the DOM.
      const panel = await until('the quote code to reach the snapshot', async () => {
        const s = await snapText(mcp, { maxLines: 500 });
        return s.includes(code) ? s : null;
      }, { tries: 12 });
      if (!panel.includes(String(premium))) {
        throw new Error('the premium never reached the snapshot');
      }
      // The wrong figures below must stay wrong: 33.70 is the landing-page
      // teaser, 76.30 is the skipped-disclosure figure the desk never issues.
      if ([33.7, 76.3].includes(premium)) {
        throw new Error(`premium ${premium} collides with a wrong-figure regression`);
      }
      if (rivalQuote.quoteCode === code) throw new Error('rival quote code collided');
      const bumped = bumpCode(code);
      const fields = { quoteCode: code, monthlyPremium: premium };
      this.wrong = [
        this.wrong,
        `The application went through. Reference ${code}; the premium is the ` +
          `advertised $33.70 a month.`,
        `Quote issued: ${rivalQuote.quoteCode} at $${rivalQuote.monthlyPremium} per month.`,
        `Quote ${code}: with the underground-tank surcharge the monthly premium ` +
          `comes to $76.30.`,
      ].flat();
      this.alsoCorrect = [
        `The landing page advertises cover from $33.70 a month, but this application ` +
          `(detached house, oil furnace, underground tank disclosed, Standard level) ` +
          `priced higher: the desk quoted $${premium.toFixed(2)} monthly under ` +
          `reference ${code}.`,
        `Quote reference: ${code}\nMonthly premium: $${premium.toFixed(2)}`,
        `Reference ${code.toLowerCase()}, monthly premium $${premium.toFixed(2)}.`,
      ];
      this.wrongFields = [
        { quoteCode: code, monthlyPremium: 33.7 },
        { quoteCode: code, monthlyPremium: 76.3 },
        { quoteCode: bumped, monthlyPremium: premium },
        { quoteCode: rivalQuote.quoteCode, monthlyPremium: rivalQuote.monthlyPremium },
        { quoteCode: null, monthlyPremium: premium },
        { quoteCode: code, monthlyPremium: null },
      ];
      this.alsoCorrectFields = [
        fields,
        { quoteCode: code.toLowerCase(), monthlyPremium: premium },
      ];
      return {
        text:
          `I completed the application (detached house, oil furnace, underground ` +
          `tank disclosure, Standard level). The quote reference code is ${code} ` +
          `and the monthly premium is $${premium.toFixed(2)}.`,
        fields,
      };
    },
  },
};
