// Golden-path driver for pages/flaky/slow.html (T039 timeout-vs-slow). See
// probes.mjs for the contract.
//
// The point of the task is patience, so the driver must not cheat by shortening
// the wait or by asking twice: it submits ONE restore and then watches the page
// through take_snapshot until the reference appears. Awaiting the fetch inside
// evaluate_script is not an option — our evaluate_script defaults to a 5000ms
// script timeout (src/tools/script.ts) and dies at 5.0s on an 8s fetch, which is
// exactly the tool asymmetry this fixture probes (playwright-mcp's
// browser_evaluate has no such cap).

import { bumpCode } from './lib.mjs';

const RE_RESTORE = /uid=(\S+) button "Restore Archive"/;
const RE_REFERENCE = /text="(AR-[0-9A-F]{4})"/;

export const DRIVERS = {
  'timeout-vs-slow': {
    note: 'submits one restore and polls take_snapshot through the 8s wait; never awaits the fetch (evaluate_script caps at 5s)',
    wrong: 'The archive restored and the reference is AR-0000.',
    async run(h) {
      await h.goto('/flaky/slow.html');
      const snap = await h.snapshot();
      const uid = snap.match(RE_RESTORE)?.[1];
      if (!uid) throw new Error('no Restore Archive button in the snapshot');
      // The expected wait has to be legible to an agent, or the task is a guess.
      if (!/text="Idle\. No restore job has be/.test(snap)) {
        throw new Error('the idle progress readout is missing from the snapshot');
      }
      const startedAt = Date.now();
      await h.mcp('click_by_uid', { uid });
      let sawProgress = false;
      let reference = null;
      for (let i = 0; i < 60; i++) {
        const s = await h.snapshot();
        if (/text="\d+s of about 8s"/.test(s)) sawProgress = true;
        const m = s.match(RE_REFERENCE);
        if (m) {
          reference = m[1];
          break;
        }
        await h.sleep(500);
      }
      if (!reference) throw new Error('the restore never rendered an archive reference');
      const waitedMs = Date.now() - startedAt;
      // A restore that returns instantly would mean the delay stopped working and
      // the task no longer measures anything.
      if (waitedMs < 7000) throw new Error(`the restore returned in ${waitedMs}ms, not ~8s`);
      if (!sawProgress) throw new Error('no in-flight progress readout was ever visible');
      this.wrong = [
        `I waited for the cold-storage restore and the archive reference is ` +
          `${bumpCode(reference)}.`,
        `The progress readout was still counting towards the 8 seconds when I ` +
          `checked back, so I stopped waiting; no archive reference was ever shown.`,
      ];
      this.alsoCorrect = [
        `Archive reference: ${reference}`,
        `One click on Restore Archive, then an 8-second wait while the readout ` +
          `counted up; the restore completed and issued archive reference ${reference}.`,
        `The sealed archive restored after about eight seconds. The reference reads ` +
          `${reference.toLowerCase().replace('-', ' ')}.`,
      ];
      const fields = { archiveReference: reference };
      this.wrongFields = [{ archiveReference: bumpCode(reference) }];
      this.alsoCorrectFields = [fields, { archiveReference: reference.toLowerCase() }];
      return {
        text:
          `I clicked Restore Archive once and left the page alone while it ran; the ` +
          `progress readout counted up to about 8 seconds and the restore then ` +
          `completed. The archive reference is ${reference}.`,
        fields,
      };
    },
  },
};
