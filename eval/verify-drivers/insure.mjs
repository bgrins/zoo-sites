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
      // Where the desk stands for this session, through the page's own safe read.
      const desk = () =>
        evaluate(async () => {
          const nonce = document.documentElement.innerHTML.match(/const NONCE = '([0-9a-f]+)'/)?.[1];
          const res = await fetch('/api/insure/state', { headers: { 'X-Session-Nonce': nonce } });
          return res.ok ? await res.json() : null;
        });
      // click_by_uid can report a click that never landed (see clickToPath in
      // lib.mjs), and its uid can go stale. Re-clicking blindly is not safe on
      // this desk, which counts a second post of a step it has already recorded
      // as a violation. So a listener on the button records whether a click
      // reached it in a state the page posts from, and the button is clicked
      // again only when none did and the desk has still not recorded the post.
      // A failed click is left to that same check.
      const tryClick = async (uid) => {
        try {
          await mcp('click_by_uid', { uid });
        } catch {}
      };
      const postOnce = async (buttonId, uidPattern, what, done, prepare = async () => {}) => {
        for (let attempt = 0; attempt < 4; attempt++) {
          if (await done()) return;
          await prepare();
          await evaluate(`() => {
            const button = document.getElementById(${JSON.stringify(buttonId)});
            if (!button.landed) {
              button.addEventListener('click', () => {
                const choices = [...document.querySelectorAll('#card input[name=choice]')];
                button.landed.push(!choices.length || choices.some((c) => c.checked));
              });
            }
            button.landed = [];
          }`);
          const uid = uidOf(await snapshot(), uidPattern);
          if (!uid) throw new Error(`no button for ${what} in the snapshot`);
          await tryClick(uid);
          // A button the page has already replaced was clicked, and posted.
          const posted = await evaluate(`() => {
            const landed = document.getElementById(${JSON.stringify(buttonId)})?.landed;
            return !landed || landed.includes(true);
          }`);
          if (posted) return until(`the desk to record ${what}`, done);
        }
        throw new Error(`four clicks never posted ${what}`);
      };
      const pickAndContinue = async (step, label) => {
        await until(`option "${label}" to render`, async () =>
          (await desk())?.current === step && uidOf(await snapshot(), `input "${label}"`));
        await postOnce(
          'continueBtn',
          'button "Continue"',
          `the ${step} step`,
          async () => {
            const read = await desk();
            return !!read && read.current !== step;
          },
          async () => {
            const picked = await evaluate(
              `() => document.querySelector('input[aria-label=${JSON.stringify(label)}]')?.checked === true`
            );
            if (!picked) await tryClick(uidOf(await snapshot(), `input "${label}"`));
          }
        );
      };
      await pickAndContinue('dwelling', 'Detached house');
      await pickAndContinue('heating', 'Oil furnace');
      // The disclosure step only exists because heating=oil branched the
      // server-side sequence; reaching this option is itself the branch proof.
      await pickAndContinue('fuel-storage', 'Underground tank');
      await pickAndContinue('coverage', 'Standard');
      await until('the review step to render', async () => uidOf(await snapshot(), 'button "Get my quote"'));
      await postOnce('quoteBtn', 'button "Get my quote"', 'the quotation', async () => (await desk())?.quoted > 0);
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
      // The desk counts every out-of-turn post, so a golden path that re-posted
      // a finished step while recovering from a click shows up here.
      const record = [...ctx.pages.state.sessions.values()].find((s) => s.insure?.quotes.some((q) => q.code === code))?.insure;
      if (!record || record.violations !== 0 || record.quotes.length !== 1) {
        throw new Error(
          `the browser session made ${record?.violations ?? 'no'} out-of-turn posts and ` +
            `${record?.quotes.length ?? 'no'} quote requests to the desk`
        );
      }
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
