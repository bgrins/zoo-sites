// Golden path for T112 support-chat (pages/support/). The adviser's replies are
// queued server-side with due times, so every wait here polls for the reply
// rather than sleeping a fixed interval.
//
// Two measured properties of our surface this driver documents:
//   - the default 100-line snapshot loses the chat composer after the FIRST
//     exchange (the help page is 91 lines with the dock open, and each message
//     costs 3 lines), so every send after the first needs a scoped snapshot;
//   - message text truncates at 27 characters, so the adviser's instructions are
//     only ever half-readable through the snapshot.
// Neither is worked around in the fixture; the driver takes the same routes an
// agent has to take.

import { bumpCode, snapText, uidOf, until as poll } from './lib.mjs';

const CHAT_PATH = '/support/';
const ACCOUNT_PATH = '/support/account.html';

// Adviser replies fall due seconds apart, so waits here breathe at 500ms rather
// than at the shared default gap.
const until = (label, fn) => poll(label, fn, { gap: 500 });

// The dock sits at the end of a 78-line help page, so scope the snapshot to it
// rather than raising maxLines: that is the cheaper of the two workarounds and
// the one an agent discovers from the "[+N lines]" marker. It stays cheap however
// long the chat runs — the transcript keeps only its most recent messages in the
// DOM, so this snapshot settles at ~37 lines with the composer always in it.
const dockSnapshot = (mcp) => snapText(mcp, { selector: '.dock' });

async function sendMessage(mcp, text) {
  const snap = await dockSnapshot(mcp);
  const box = uidOf(snap, 'textarea');
  const button = uidOf(snap, 'button "Send"');
  if (!box || !button) throw new Error('composer not present in the dock snapshot');
  await mcp('fill_by_uid', { uid: box, value: text });
  await mcp('click_by_uid', { uid: button });
  // The visitor line is echoed by the next poll; wait for it so a send that
  // silently failed is not mistaken for a slow reply.
  const head = text.slice(0, 24);
  await until('the sent message to appear in the transcript', async () =>
    (await dockSnapshot(mcp)).includes(head)
  );
}

export const DRIVERS = {
  'support-chat': {
    note: 'live chat: scoped snapshots, polls for each scripted reply',
    wrong: ['I raised the case with the adviser. The reference is SR-4B19C2.'],
    async run({ mcp, goto, evaluate }) {
      await goto(CHAT_PATH);
      const home = await snapText(mcp);
      const launcher = uidOf(home, 'button "Chat with an adviser"');
      if (!launcher) throw new Error('no chat launcher on the help centre page');
      await mcp('click_by_uid', { uid: launcher });

      await until("the adviser's greeting", async () =>
        (await dockSnapshot(mcp)).includes('How can I help today?')
      );

      await sendMessage(
        mcp,
        'My connection drops out for a few minutes three or four times each evening ' +
          'between 7pm and 10pm, and the gateway status light goes amber when it happens.'
      );

      // "What is your gateway model number?" is 34 chars, so the snapshot shows
      // "What is your gateway model ..." — enough to know what is being asked,
      // which is why this is a snapshot check and not an eval.
      await until('the adviser to ask for the gateway model', async () =>
        /What is your gateway model/.test(await dockSnapshot(mcp))
      );

      // The rest of the adviser's instruction is past the 27-char cap. Read it
      // through eval purely to assert the fixture still points at the account
      // page; the driver does not need the text to proceed.
      await until('the adviser to name the Equipment panel', async () => {
        const transcript = await evaluate(() =>
          [...document.querySelectorAll('.dock .msg .txt')].map((p) => p.textContent)
        );
        return (
          Array.isArray(transcript) &&
          transcript.some((line) => /Equipment panel of your account/.test(line))
        );
      });

      await goto(ACCOUNT_PATH);
      const account = await until('the equipment record to load', async () => {
        const snap = await snapText(mcp);
        const model = snap.match(
          /span text="Gateway model"\s*\n\s*uid=\S+ span text="([^"]+)"/
        )?.[1];
        return model && model !== 'Loading' ? model : null;
      });
      if (!/^GX-\d{4}[A-Z]$/.test(account)) {
        throw new Error(`account page rendered an implausible gateway model: ${account}`);
      }

      await goto(CHAT_PATH);
      // The widget reopens itself from sessionStorage on return, and the poll
      // replays every reply that has already fallen due.
      await until('the chat to reopen with its transcript', async () =>
        (await dockSnapshot(mcp)).includes('What is your gateway model')
      );

      await sendMessage(mcp, `The gateway model is ${account}.`);

      const closing = await until('the adviser to raise a case', async () => {
        const snap = await dockSnapshot(mcp);
        return snap.match(/\bSR-[0-9A-F]{6}\b/)?.[0] ?? null;
      });

      const fields = { caseReference: closing };
      this.wrongFields = [{ caseReference: 'SR-000000' }];
      this.alsoCorrectFields = [fields, { caseReference: closing.toLowerCase() }];
      this.wrong = [
        this.wrong[0],
        `The adviser logged the fault against gateway ${account} and said a case was ` +
          `open, but the chat closed before I could read the reference back.`,
        `Case ${bumpCode(closing)} is open for the evening dropouts; I supplied the ` +
          `gateway model ${account} from the Equipment panel.`,
      ];
      this.alsoCorrect = [
        `Fault: evening dropouts between 7pm and 10pm, amber gateway light\n` +
          `Gateway model: ${account}\nCase reference: ${closing}`,
        `The adviser needed the gateway model before raising anything; the Equipment ` +
          `panel gave ${account}, and once I sent it they opened case ${closing}.`,
        `The case the adviser raised is ${closing.toLowerCase().replace('-', ' ')}.`,
      ];
      return {
        text: [
          `I described the evening dropouts to the adviser, then took the gateway model`,
          `${account} from the Equipment panel of my account and gave it to them.`,
          `The case reference is ${closing}.`,
        ].join(' '),
        fields,
      };
    },
  },
};
