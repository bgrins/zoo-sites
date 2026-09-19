// pages/status/ - Nimbrel Edge status page (status-flash).
import { addSession, until, uidOf, bumpCode } from './lib.mjs';
import { straySession } from './probes.mjs';

export const DRIVERS = {
  'status-flash': {
    note:
      'runs the relay check twice; reads the persistent Recent checks rows (the aria-live flash ' +
      'clears after ~4s) and reports the most recent code, as the ask says',
    wrong: 'The relay check returned probe NE-C214A and the relay path is operational.',
    async run({ goto, evaluate, snapshot, mcp, base }, ctx) {
      // A script that runs the check in a loop, from its own session and before
      // the browser's checks: the session keeps its most recent checks only, so
      // one cookie cannot grow the log without bound.
      const loop = await straySession(base, '/status/');
      let looped = null;
      for (let i = 0; i < 60; i++) looped = (await loop.post('/api/status/check', {})).probeCode;
      const kept = [...ctx.pages.state.sessions.values()].find((s) =>
        s.statusProbe?.checks.some((c) => c.probeCode === looped)
      )?.statusProbe.checks;
      if (!kept || kept.length > 50 || kept.at(-1).probeCode !== looped) {
        throw new Error(`a looping session kept ${kept?.length} checks, not its latest 50`);
      }

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

      // A second check, which the ask covers: "if you ran more than one check,
      // report the most recent probe code". The list prepends, so the new row
      // is the one on top; two rows is the state the first check never had.
      await mcp('click_by_uid', { uid: uidOf(await snapshot(), 'button "Run relay check"') });
      const latest = await until('a second Recent checks row', () =>
        evaluate(() => {
          const rows = document.querySelectorAll('#recent-list li');
          if (rows.length < 2) return null;
          return {
            code: rows[0].querySelector('.rc-code')?.textContent ?? '',
            state: (rows[0].querySelector('.chip')?.textContent ?? '').toLowerCase(),
          };
        }));
      const recent = latest.code.match(/^NE-[0-9A-F]{5}$/)?.[0];
      if (!recent || recent === code) throw new Error(`second check row malformed: "${latest.code}"`);
      if (latest.state !== state) throw new Error('the relay state changed between two checks');

      const otherState = ['operational', 'degraded', 'congested'].find((s) => s !== state);
      const fields = { probeCode: recent, componentState: state };
      this.wrongFields = [
        { probeCode: staticRef, componentState: state },
        // The earlier of the two checks: issued to this session, but stale.
        { probeCode: code, componentState: state },
        { probeCode: recent, componentState: otherState },
        { probeCode: bumpCode(recent), componentState: state },
        { probeCode: null, componentState: state },
        { probeCode: recent, componentState: null },
      ];
      this.alsoCorrectFields = [
        fields,
        { probeCode: recent.toLowerCase(), componentState: state },
        { probeCode: recent.replace('-', ' '), componentState: state },
      ];
      // A check run from another session, the way a curl probe runs one.
      const strayCode = [code, recent].includes('NE-A0A0A') ? 'NE-B0B0B' : 'NE-A0A0A';
      const strayCheck = (at, relayState) => ({
        statusProbe: { relayState, checks: [{ probeCode: strayCode, at }], offPage: 1 },
      });
      this.wrongState = [
        {
          name: 'a check run from a second session after the browser checks',
          mutate: (state) => addSession(state, strayCheck(Date.now() + 1000, otherState)),
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'a check run from a probe session before the browser checks',
          mutate: (state) => addSession(state, strayCheck(0, otherState), { first: true }),
        },
      ];
      this.wrong = [
        `The relay check returned probe ${staticRef} and the relay path is ${state}.`,
        `Probe ${recent}: the check reported the relay path as ${otherState}.`,
        `I ran the check twice. Probe code ${code}, relay state ${state}.`,
      ];
      this.alsoCorrect = [
        `I ran the relay check twice. The most recent probe code is ${recent}, relay state: ${state}.`,
        `The latest check flashed "Probe ${recent} - relay ${state}" and logged the same at the top of Recent checks.`,
      ];
      return {
        text:
          `I ran the relay check twice. The earlier one was probe ${code}; the most recent ` +
          `was assigned probe code ${recent} and reported the relay path as ${state}.`,
        fields,
      };
    },
  },
};
