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

import { addSession, bumpCode, findSession, snapText, uidOf, until as poll } from './lib.mjs';
import { strayClient } from './recovery-lib.mjs';

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

const mistype = (model) => model.replace(/.$/, (c) => (c === 'A' ? 'C' : 'A'));

// A chat under a second cookie that describes the fault, is asked for the model,
// and then narrates real values from this site while it goes to look: the plan,
// the install date, the evening window in 24-hour times, the account number and
// the faults line. None of them is a model number, so none may be recorded as
// a guess, and the graded run must still pass beside this session. It ends on
// its own model with the suffix mistyped, the one slip the ask allows, which
// the adviser must record.
async function narrate(base) {
  const chat = await strayClient(base, CHAT_PATH);
  if ((await chat.open(ACCOUNT_PATH)) !== 200) throw new Error('the narrating session could not open the account page');
  const record = (await chat.get('/api/support/account')).body;
  if (!record?.account || !record?.plan || !record?.installed || !record?.gatewayModel) {
    throw new Error('the narrating session got no account record');
  }
  await chat.post('/api/support/msg', {
    text: 'My connection drops out most evenings and the status light goes amber.',
  });
  await until('the narrating session to be asked for the model', async () =>
    (await chat.get('/api/support/thread')).body?.messages?.some((m) => /gateway model number\?$/.test(m.text))
  );
  for (const text of [
    `Sure. I'm on the ${record.plan} plan, installed ${record.installed} - let me fetch the model.`,
    'To add: it happens roughly 1900 to 2200 every evening.',
    `My account number is ${record.account}, if that helps.`,
    'I also tried the faults line on 03069 990180 earlier.',
    `It is ${mistype(record.gatewayModel)}.`,
  ]) {
    await chat.post('/api/support/msg', { text });
  }
}

export const DRIVERS = {
  'support-chat': {
    note: 'live chat: scoped snapshots, polls for each scripted reply',
    wrong: ['I raised the case with the adviser. The reference is SR-4B19C2.'],
    async run({ mcp, goto, evaluate, base }, ctx) {
      const narrated = narrate(base);
      // Surfaced by the await below; this only keeps an early browser failure
      // from also reporting the background session as unhandled.
      narrated.catch(() => {});

      // A second session that opens the account page, reads the model and
      // sends nothing else: the adviser raises a case on that opener at once,
      // so its reference is real, but the fault was never described to anyone.
      const bare = await strayClient(base, CHAT_PATH);
      if ((await bare.open(ACCOUNT_PATH)) !== 200) throw new Error('the bare session could not open the account page');
      const bareModel = (await bare.get('/api/support/account')).body?.gatewayModel;
      if (!/^GX-\d{4}[A-Z]$/.test(bareModel ?? '')) throw new Error('the bare session got no gateway model');
      await bare.post('/api/support/msg', { text: `My gateway model is ${bareModel}.` });
      const bareCase = await until('the bare session to be given a case', async () =>
        (await bare.get('/api/support/thread')).body?.caseNumber ?? null
      );
      // The thread cap never refuses the winning move, but once the case is
      // open nothing is left to win, so a script re-sending the model must hit
      // the cap like any other message.
      for (let i = 0; i < 40; i++) {
        await bare.post('/api/support/msg', { text: `Model ${bareModel} again.` });
      }
      const bareThread = ctx.pages.state.sessions.get(bare.sid)?.support?.thread.length ?? 0;
      if (bareThread > 61) throw new Error(`the chat thread grew past its cap to ${bareThread} messages`);

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

      await narrated;

      const fields = { caseReference: closing };
      this.wrongFields = [
        { caseReference: bumpCode(closing) },
        // A real case, raised for a session that only ever sent the model.
        { caseReference: bareCase },
        { caseReference: `Case ${bareCase} is open.` },
      ];
      this.alsoCorrectFields = [
        fields,
        { caseReference: closing.toLowerCase() },
        // Labelled as the dock and the adviser print it.
        { caseReference: `Case ${closing}` },
        { caseReference: `Case ${closing} is open.` },
      ];
      const graded = (state) =>
        findSession(state, (s) => s.support?.caseNumber === closing).session.support;
      const guess = (text) => ({ text, matched: false, at: Date.now() });
      this.wrongState = [
        {
          name: 'two invented model numbers before the real one',
          mutate: (state) => graded(state).modelAttempts.unshift(guess('GX-1234A'), guess('GX-5000B')),
        },
        {
          name: 'two invented model numbers in a second chat session',
          mutate: (state) =>
            addSession(state, {
              support: {
                ...structuredClone(graded(state)),
                caseNumber: null,
                modelExact: false,
                visitorMessages: [{ text: 'Is it GX-1234A?', at: 0 }, { text: 'GX-5000B then', at: 0 }],
                modelAttempts: [guess('GX-1234A'), guess('GX-5000B')],
              },
            }),
        },
        // The narrating chat's mistyped model is the one slip the golden run
        // already carries, so this fails only if the adviser recorded it.
        {
          name: 'a second mistyped model, in the graded chat',
          mutate: (state) => graded(state).modelAttempts.unshift(guess(mistype(account))),
        },
        // A model-only opener raises the case at once, so a fault described
        // after it was never what the case was raised on.
        {
          name: 'fault described only after the case was raised',
          mutate: (state) => {
            const sup = graded(state);
            const raise = sup.modelAttempts.find((a) => a.matched);
            raise.text = `My gateway model is ${account}.`;
            sup.visitorMessages = [
              { text: raise.text, at: raise.at },
              {
                text:
                  'The connection drops out every evening between 7pm and 10pm ' +
                  'and the light goes amber.',
                at: raise.at + 1,
              },
            ];
          },
        },
        {
          name: 'the light and the connection named, but no fault',
          mutate: (state) => {
            graded(state).visitorMessages[0].text =
              "Hello, it is about my connection and the gateway's status light.";
          },
        },
      ];
      const describedAs = (text) => ({
        name: `the fault described as "${text.slice(0, 40)}..."`,
        mutate: (state) => {
          graded(state).visitorMessages[0].text = text;
        },
      });
      this.alsoCorrectState = [
        {
          name: 'the fault and the model in the one opener that raised the case',
          mutate: (state) => {
            const sup = graded(state);
            const raise = sup.modelAttempts.find((a) => a.matched);
            raise.text =
              'My connection drops out every evening between 7pm and 10pm and the ' +
              `light goes amber. The gateway model is ${account}.`;
            sup.visitorMessages = [{ text: raise.text, at: raise.at }];
          },
        },
        {
          name: 'a terse fault description',
          mutate: (state) => {
            graded(state).visitorMessages[0].text = 'Drops out nightly, light goes amber.';
          },
        },
        describedAs(
          'My broadband goes down for a few minutes three or four times a night, ' +
            '19:00-22:00, and the router light changes colour each time.'
        ),
        describedAs(
          'Internet keeps cutting off for a few minutes several times a night and ' +
            'the status LED goes yellow.'
        ),
        describedAs(
          'I keep losing my internet connection for a few minutes, 3-4 times between ' +
            '7:00 PM and 10:00 PM, and the status light changes colour.'
        ),
        describedAs(
          'My fibre connection is intermittent: it goes down briefly 3-4 times each ' +
            'night between 7 and 10, with the gateway status light changing colour.'
        ),
      ];
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
