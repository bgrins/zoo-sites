// pages/status/ - Nimbrel Edge status page (status-flash).
import { until, uidOf, bumpCode } from './lib.mjs';

export const DRIVERS = {
  'status-flash': {
    note: 'clicks Run relay check; reads the persistent Recent checks row (the aria-live flash clears after ~4s)',
    wrong: 'The relay check returned probe NE-C214A and the relay path is operational.',
    async run({ goto, evaluate, snapshot, mcp }) {
      await goto('/status/');
      const snap = await snapshot();
      const runUid = uidOf(snap, 'button "Run relay check"');
      if (!runUid) throw new Error('no Run relay check button in the snapshot');

      // Precondition of the aria-live probe: the flash region exists, is
      // assertive, and starts empty.
      const live = await evaluate(() => ({
        aria: document.getElementById('flash')?.getAttribute('aria-live') ?? null,
        text: document.getElementById('flash')?.textContent.trim() ?? null,
      }));
      if (live.aria !== 'assertive') throw new Error('aria-live flash region missing');
      if (live.text !== '') throw new Error('flash region not empty before the check');

      await mcp('click_by_uid', { uid: runUid });

      // The winnable path: poll the persistent Recent checks row, not the flash.
      const row = await until('a Recent checks row to appear after clicking', () =>
        evaluate(() => {
          const li = document.querySelector('#recent-list li');
          if (!li) return null;
          return {
            code: li.querySelector('.rc-code')?.textContent ?? '',
            state: (li.querySelector('.chip')?.textContent ?? '').toLowerCase(),
            flash: document.getElementById('flash')?.textContent ?? '',
          };
        }));
      const code = row.code.match(/^NE-[0-9A-F]{5}$/)?.[0];
      if (!code) throw new Error(`history row code malformed: "${row.code}"`);
      const state = row.state;
      if (!['operational', 'degraded', 'congested'].includes(state)) {
        throw new Error(`history row state malformed: "${row.state}"`);
      }
      // The flash carried the same pair while it was up (we are inside the 4s).
      if (!row.flash.includes(code) || !row.flash.includes(state)) {
        throw new Error(`flash text "${row.flash}" does not carry the minted pair`);
      }

      // Transience precondition: the flash clears on its own (~4.2s), leaving
      // only the Recent checks row. Poll, never a fixed sleep.
      await until('the aria-live flash to clear', async () => {
        const text = await evaluate(() => document.getElementById('flash')?.textContent ?? 'x');
        return text === '';
      }, { tries: 30, gap: 300 });
      const persisted = await evaluate(
        () => document.querySelector('#recent-list li .rc-code')?.textContent ?? ''
      );
      if (persisted !== code) throw new Error('Recent checks row did not persist past the flash');

      // The graded pair must be reachable through the snapshot surface with
      // the flash gone: the row's code and state chip label are their own
      // short text nodes. The label is asserted on the lines right at/after
      // the code, since static chips elsewhere reuse the same words.
      const after = await snapshot();
      const lines = after.split('\n');
      const codeLine = lines.findIndex((l) => l.includes(code));
      if (codeLine === -1) throw new Error('probe code not visible in the post-flash snapshot');
      const label = state[0].toUpperCase() + state.slice(1);
      if (!lines.slice(codeLine, codeLine + 4).some((l) => l.includes(label))) {
        throw new Error(`state chip "${label}" not beside the code in the post-flash snapshot`);
      }

      // Bait precondition: the static incident references (same NE-<5 hex>
      // shape) are still on the page and can never equal a minted code.
      const staticRef = await evaluate(
        () => document.querySelector('.inc-ref')?.textContent ?? ''
      );
      if (!/^NE-[0-9A-F]{5}$/.test(staticRef)) throw new Error('static incident reference missing');
      if (staticRef === code) throw new Error('minted code collided with a static incident ref');

      const otherState = ['operational', 'degraded', 'congested'].find((s) => s !== state);
      const bumped = bumpCode(code);
      const fields = { probeCode: code, componentState: state };
      this.wrongFields = [
        { probeCode: staticRef, componentState: state },
        { probeCode: code, componentState: otherState },
        { probeCode: bumped, componentState: state },
        { probeCode: null, componentState: state },
        { probeCode: code, componentState: null },
      ];
      this.alsoCorrectFields = [
        fields,
        { probeCode: code.toLowerCase(), componentState: state },
        { probeCode: code.replace('-', ' '), componentState: state },
      ];
      this.wrong = [
        `The relay check returned probe ${staticRef} and the relay path is ${state}.`,
        `Probe ${code}: the check reported the relay path as ${otherState}.`,
      ];
      this.alsoCorrect = [
        `I ran the relay check. Probe code ${code}, relay state: ${state}.`,
        `The check flashed "Probe ${code} - relay ${state}" and logged the same under Recent checks.`,
      ];
      return {
        text: `The relay check assigned probe code ${code} and reported the relay path as ${state}.`,
        fields,
      };
    },
  },
};
