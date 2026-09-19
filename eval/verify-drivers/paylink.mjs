// T113 cross-tab-pay: pages/paylink/. The whole point is the second tab, so this
// driver does the handoff the way an agent must — click the merchant's
// target=_blank pay link, then move between the two tabs with select_page,
// reading the verification word off the merchant tab and typing it into the
// authorizer tab. It never reads ctx.pages.state.

import { bumpCode, textOf, until } from './lib.mjs';

const OPEN_LINK = /uid=(\S+) a "Authorise with Anverra/;
const WORD = /text="([A-Z]{4,8}-\d{2})"/;
const CODE = /text="(OC-[0-9A-F]{6})"/;

export const DRIVERS = {
  'cross-tab-pay': {
    note: 'drives both tabs: target=_blank pay link, select_page, close_page',
    wrong: 'Payment complete. The confirmation code is AVP-77120468.',
    async run({ mcp, goto, snapshot }) {
      const pages = async () => textOf(await mcp('list_pages'));
      const countTabs = async () => ((await pages()).match(/^\s*>?\[\d+\]/gm) ?? []).length;
      // Firefox inserts a link-opened tab immediately after its opener rather
      // than at the end, and this driver shares one browser with every other
      // driver, so the authorizer's index cannot be computed. Select by title and
      // let the tool report which index that was.
      const select = async (title) => {
        const r = await mcp('select_page', { title });
        const text = textOf(r);
        const idx = Number(text.match(/selected \[(\d+)\]/)?.[1]);
        if (!Number.isInteger(idx)) throw new Error(`select_page ${title}: ${text}`);
        return idx;
      };

      const handoff = async () => {
        await goto('/paylink/checkout.html');
        const linkUid = await until('the pay link to be armed', async () =>
          (await snapshot()).match(OPEN_LINK)?.[1]
        );
        const tabsBefore = await countTabs();
        await mcp('click_by_uid', { uid: linkUid });
        await until('the authorizer to open in a second tab', async () =>
          (await countTabs()) > tabsBefore
        );
        // Everything past this point runs with the extra tab open; whatever
        // happens, the tab must not leak into the next task on this worker.
        let word;
        let code;
        let procRef;
        try {
          // The authorizer window: check it shows the amount being authorised, and
          // that it does NOT carry the merchant's confirmation code.
          await select('Anverra Pay');
          const authSnap = await until('the authorizer to render the amount', async () => {
            const s = await snapshot();
            return /\$329\.14/.test(s) ? s : null;
          });
          if (CODE.test(authSnap)) {
            throw new Error('the authorizer window leaked the merchant confirmation code');
          }

          // Back to the merchant tab for the verification word, which only appears
          // there and only once the authorizer window exists.
          await select('Ollister');
          word = await until('the merchant tab to show the verification word', async () =>
            (await snapshot()).match(WORD)?.[1]
          );

          await select('Anverra Pay');
          const formSnap = await snapshot();
          const inputUid = formSnap.match(/uid=(\S+) input[^\n]*Verification word/)?.[1]
            ?? formSnap.match(/uid=(\S+) input/)?.[1];
          if (!inputUid) throw new Error('no verification word input in the authorizer snapshot');
          await mcp('fill_by_uid', { uid: inputUid, value: word });
          const approveUid = formSnap.match(/uid=(\S+) button "Approve payment"/)?.[1];
          if (!approveUid) throw new Error('no Approve payment button in the authorizer snapshot');
          await mcp('click_by_uid', { uid: approveUid });
          const approvedSnap = await until('the authorizer to report the approval', async () => {
            const s = await snapshot();
            return /Authorisation complete/.test(s) ? s : null;
          });
          // The processor reference the authorizer shows: a different number from
          // the merchant code, and the confusion the batteries below pin.
          procRef = approvedSnap.match(/AVP-\d{8}/)?.[0] ?? null;

          await select('Ollister');
          code = await until('the merchant tab to show the confirmation code', async () =>
            (await snapshot()).match(CODE)?.[1]
          );
        } finally {
          // Leave the browser as we found it even on a failed run: an authorizer
          // tab left open would be inherited by the next task on this worker.
          try {
            await mcp('close_page', { pageIdx: await select('Anverra Pay') });
          } catch {
            // already closed or never opened; nothing to clean
          }
          await select('Ollister');
        }
        return { word, code, procRef };
      };

      const first = await handoff();
      // A second order placed from the same browser session, after a reload:
      // the first order's code stays a genuine answer.
      const second = await handoff();
      const { code, procRef } = first;
      if (!first.procRef && !second.procRef) throw new Error('the authorizer never showed a processor reference');
      const fields = { confirmationCode: code };
      this.wrongFields = [
        { confirmationCode: 'OC-0000-0000' },
        { confirmationCode: bumpCode(code) },
        // The processor reference the authorizer window shows: the decoy.
        ...[first.procRef, second.procRef].filter(Boolean).map((ref) => ({ confirmationCode: ref })),
      ];
      this.alsoCorrectFields = [
        fields,
        { confirmationCode: String(code).toLowerCase() },
        { confirmationCode: second.code },
      ];
      this.wrong = ['Payment complete. The confirmation code is AVP-77120468.'];
      this.alsoCorrect = [
        `Order confirmation code: ${code}`,
        `The order confirmation code on the Ollister & Crane page reads ` +
          `${String(code).toLowerCase().replace('-', ' ')}.`,
      ];
      if (procRef) {
        this.wrong.push(
          `Payment approved in the Anverra window. The order confirmation code is ${procRef}.`
        );
        this.alsoCorrect.push(
          `Anverra Pay reported processor reference ${procRef}; the code Ollister & ` +
            `Crane shows for the placed order is ${code}.`
        );
      }
      return {
        text:
          `The payment is authorised and the order is placed. Ollister & Crane shows the order ` +
          `confirmation code ${code}. The Anverra Pay window only showed a processor reference, ` +
          `which is a different number.`,
        fields,
      };
    },
  },
};
