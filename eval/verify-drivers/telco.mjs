// pages/telco/ - Lumeva Mobile plan builder (plan-picker).
import { straySession, uidOf, until } from './lib.mjs';

export const DRIVERS = {
  'plan-picker': {
    note:
      'fills the shared-prefix select by visible label (typeahead churn is the probe, never a gate); ' +
      'reads the answer from the order-summary echo in the snapshot (the designed read path) and ' +
      'reads ctx.pages.state only to assert the churn telemetry landed, never for the answer',
    wrong: 'The builder quoted $121.25 a month for the Signal Plus plan on 3 lines.',
    async run({ base, goto, evaluate, mcp, snapshot }, ctx) {
      // Rival session on a wrong configuration, so the validator's winner
      // selection is exercised and recency alone can never pick the rival.
      const rival = await straySession(base, '/telco/');
      const rivalDraft = await rival.post('/api/telco/draft', {
        seq: 0,
        plan: 'sig-plus',
        lines: 3,
      });
      if (!rivalDraft.ok) throw new Error('rival draft was rejected');

      await goto('/telco/');
      const snap = await snapshot();
      const sel = uidOf(snap, 'select');
      if (!sel) throw new Error('plan select not in snapshot');
      // A38 trap precondition: filling the option VALUE must silently land on
      // the first shared-prefix label (Signal), not the intended plan.
      await mcp('fill_by_uid', { uid: sel, value: 'sig-plus-ultra' });
      const trapped = await evaluate(() => document.getElementById('plan').value);
      if (trapped !== 'sig') throw new Error(`value-fill trap gone: select landed on "${trapped}"`);
      // Honest move: the visible label. Native typeahead walks Signal ->
      // Signal Plus -> Signal Plus Ultra, firing a change (and a draft POST)
      // per hop; the churn is telemetry and must not be graded.
      await mcp('fill_by_uid', { uid: sel, value: 'Signal Plus Ultra' });
      const landed = await evaluate(() => document.getElementById('plan').value);
      if (landed !== 'sig-plus-ultra') throw new Error(`label fill landed on "${landed}"`);
      const pill = uidOf(await snapshot(), 'button "3"');
      if (!pill) throw new Error('3-line pill not in snapshot');
      await mcp('click_by_uid', { uid: pill });
      const settled = await until('the order summary to settle', async () => {
        const read = await evaluate(() => ({
          plan: document.getElementById('planOut')?.textContent ?? '',
          lines: document.getElementById('linesOut')?.textContent ?? '',
          quote: document.getElementById('quoteOut')?.textContent ?? '',
        }));
        const m = String(read.quote).match(/^\$(\d+(?:\.\d{2})?)$/);
        if (read.plan !== 'Signal Plus Ultra' || read.lines !== '3' || !m) return null;
        return { plan: read.plan, quote: Number(m[1]) };
      });
      let { plan, quote } = settled;
      if (!Number.isFinite(quote)) throw new Error('order summary never settled');
      // The order-summary echo is the designed snapshot read path (selection
      // state itself is A5/A6-invisible): the answer must be readable from
      // OUR snapshot; the evaluate poll above is for settling only.
      const finalSnap = await snapshot();
      const summary = finalSnap.slice(finalSnap.indexOf('Order summary'));
      const echo = summary.match(
        /text="Plan"[\s\S]*?text="([^"]+)"[\s\S]*?text="Lines"[\s\S]*?text="([^"]+)"[\s\S]*?text="Monthly total"[\s\S]*?text="\$(\d+\.\d{2})"/,
      );
      if (!echo) throw new Error('order-summary echo not readable from the snapshot');
      if (echo[1] !== plan || echo[2] !== '3' || Number(echo[3]) !== quote) {
        throw new Error(`snapshot echo ${JSON.stringify(echo.slice(1))} disagrees with the settled summary`);
      }
      plan = echo[1];
      quote = Number(echo[3]);
      // Fixture-precondition telemetry check (state read, not answer read):
      // the value-fill and typeahead churn must be server-visible as extra
      // drafts on the session that reached the target configuration.
      const rec = [...ctx.pages.state.sessions.values()]
        .map((s) => s.telco)
        .find((r) => r?.current?.plan === 'Signal Plus Ultra' && r.current.lines === 3);
      if (!rec) throw new Error('no session holds the target configuration');
      if (rec.drafts.length < 3) {
        throw new Error(`expected churn drafts, saw only ${rec.drafts.length}`);
      }
      if (!rec.drafts.some((d) => d.plan !== 'Signal Plus Ultra')) {
        throw new Error('no spurious shared-prefix draft was recorded');
      }
      // The wrong figures below must stay wrong: 121.25 is the intermediate
      // Signal Plus total at 3 lines, 173.25 the undiscounted figure, 26.30
      // the landing-page per-line teaser.
      if ([121.25, 173.25, 26.3].includes(quote)) {
        throw new Error(`quote ${quote} collides with a wrong-figure regression`);
      }
      const fields = { plan, monthlyQuote: quote };
      this.wrong = [
        this.wrong,
        `The Signal Plus Ultra plan for 3 lines comes to $173.25 a month.`,
        `The builder quoted $${rivalDraft.monthlyQuote} for the ${rivalDraft.plan} plan.`,
        `The builder quoted $${quote.toFixed(2)} a month for the Signal Plus plan ` +
          `on 3 lines.`,
      ].flat();
      this.alsoCorrect = [
        `Signal Plus at 3 lines would have been $121.25, but the plan asked for was ` +
          `Signal Plus Ultra: with the 3-line discount applied the builder's monthly ` +
          `total is $${quote.toFixed(2)}.`,
        `Plan: Signal Plus Ultra\nLines: 3\nMonthly total: $${quote.toFixed(2)}`,
        `the signal plus ultra plan on three lines comes to $${quote} a month.`,
      ];
      this.wrongFields = [
        { plan: 'Signal Plus', monthlyQuote: 121.25 },
        { plan: 'Signal Plus Ultra', monthlyQuote: 26.3 },
        { plan: 'Signal Plus Ultra', monthlyQuote: 173.25 },
        { plan: 'Signal', monthlyQuote: quote },
        { plan: 'Signal Plus', monthlyQuote: quote },
        { plan: null, monthlyQuote: quote },
        { plan: 'Signal Plus Ultra', monthlyQuote: null },
      ];
      this.alsoCorrectFields = [
        fields,
        { plan: 'signal plus ultra plan', monthlyQuote: quote },
        { plan: 'the Signal Plus Ultra plan', monthlyQuote: quote },
        { plan: 'Lumeva Signal Plus Ultra', monthlyQuote: quote },
        { plan: 'Signal Plus Ultra tier', monthlyQuote: quote },
        { plan: 'Plan: Signal Plus Ultra (3 lines)', monthlyQuote: quote },
      ];
      return {
        text:
          `I configured the Signal Plus Ultra plan for 3 lines in the builder. ` +
          `The order summary shows the plan as ${plan} and the monthly total ` +
          `quoted is $${quote.toFixed(2)}.`,
        fields,
      };
    },
  },
};
