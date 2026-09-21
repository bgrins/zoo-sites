// pages/console/services/orchid-api.html - Cindergrid service page, owner
// hovercards (hovercard-oncall).
import { addSession, bumpCode, clickToPath, findSession, straySession, uidOf, until } from './lib.mjs';
import { ANSWERS } from '../answers.mjs';

export const DRIVERS = {
  'hovercard-oncall': {
    note: 'opens one profile page, then hovers each owner handle until a card reads On call and pages from the card',
    async run({ goto, evaluate, snapshot, mcp }, ctx) {
      const message = ANSWERS.consoleOncall.message;
      // Shadowing probe: a second session, minted ahead of the run, reads the
      // rotation's cards from a shell once the page is sent, and pages no one.
      // Read any earlier, a shell read of the on-call card would precede the
      // page's, which fails the run.
      const stray = await straySession(ctx.pages.url, '/console/services/orchid-api.html');

      // Before any card opens, the served page names each profile once, in
      // its owner's row: a card shipped with a profile link filled in would
      // single out one owner to a reader of the source, with no hover.
      const served = await (
        await fetch(`${ctx.pages.url}/console/services/orchid-api.html`, { headers: { cookie: stray.cookie } })
      ).text();
      const named = [...served.matchAll(/people\/([a-z]+)\.html/g)].map((m) => m[1]);
      const rows = [...served.matchAll(/class="owner" href="\.\.\/people\/([a-z]+)\.html"/g)].map((m) => m[1]);
      if (named.length !== rows.length || new Set(named).size !== named.length) {
        throw new Error(`the served page names profiles ${named.join(',')} outside the owner rows ${rows.join(',')}`);
      }

      // The slower route works too: the first owner's profile page loads the
      // same record. It is only read here, never paged from.
      await goto('/console/services/orchid-api.html');
      await clickToPath(
        mcp,
        evaluate,
        async () => uidOf(await snapshot(), 'a "@ivaskelund"'),
        '/people/ivaskelund.html',
        'the first owner profile'
      );
      await until('the profile status to load', async () => {
        const s = await snapshot();
        return /(?:On|Off) call/.test(s) && /button "Send page"/.test(s) ? s : null;
      });

      await goto('/console/services/orchid-api.html');
      const handles = await until('the owner handles', () =>
        evaluate(() => [...document.querySelectorAll('a.owner')].map((a) => a.dataset.handle))
      );
      let card = null;
      for (const handle of handles) {
        await mcp('hover_by_uid', { uid: uidOf(await snapshot(), `a "@${handle}"`) });
        // The card opens after a 300ms intent delay and its record arrives
        // after that, so wait for this handle's card rather than any card.
        await until(`the card for @${handle}`, () =>
          evaluate(`() => !document.getElementById('card').hidden &&
            (document.getElementById('hc-profile').getAttribute('href') ?? '').endsWith('/${handle}.html')`)
        );
        const snap = await snapshot();
        const status = snap.match(/"((?:On|Off) call[^"]*)"/)?.[1];
        if (!status) throw new Error(`the card for @${handle} shows no status in the snapshot`);
        if (status.startsWith('On call until')) {
          card = { handle, snap };
          break;
        }
      }
      if (!card) throw new Error('no owner card read On call');
      const name = await evaluate(() => document.getElementById('hc-name').textContent);
      if (!card.snap.includes(name)) throw new Error(`the on-call name "${name}" is not in the snapshot`);

      const box = uidOf(card.snap, 'textarea') ?? uidOf(card.snap, 'textbox "Page message"');
      if (!box) throw new Error('no message box in the card snapshot');
      await mcp('fill_by_uid', { uid: box, value: message });
      const filled = await snapshot();
      if (!(await evaluate(() => !document.getElementById('card').hidden))) throw new Error('filling the message closed the card');
      await mcp('click_by_uid', { uid: uidOf(filled, 'button "Send page"') });
      const receipt = await until('the page receipt', async () =>
        (await snapshot()).match(/PG-[0-9A-F]{6}/)?.[0] ?? null
      );

      const oc = findSession(ctx.pages.state, (s) => s.cgOncall?.pages.length).session.cgOncall;
      if (oc.pages.length !== 1 || oc.pages[0].handle !== card.handle || oc.pages[0].via !== 'card') {
        throw new Error(`server state after the page: ${JSON.stringify(oc.pages)}`);
      }
      if (!(oc.cardAt[card.handle] < oc.pages[0].at)) {
        throw new Error(`the hovered card was not recorded as a page view: ${JSON.stringify(oc.cardAt)}`);
      }

      let strayOnCall = null;
      for (const h of ['ivaskelund', 'tquevrine', 'pkelderwick', 'astravinek']) {
        if ((await stray.get(`/api/console/card/${h}`)).status?.startsWith('On call')) strayOnCall = h;
      }
      // The engineering manager holds no rotation, so the name its card
      // returns doubles as a decoy below.
      const decoy = await stray.get('/api/console/card/cbrisketh');
      if (!strayOnCall || !decoy.name || decoy.status.startsWith('On call')) throw new Error('the stray card read failed');
      // One rotation per task: the shell session read the same person on call.
      if (card.handle !== strayOnCall) {
        throw new Error(`the browser session reads @${card.handle} on call and the shell session @${strayOnCall}`);
      }
      // A shell read is stamped apart from a page view.
      const strayOc = ctx.pages.state.sessions.get(stray.sid)?.cgOncall;
      if (!strayOc || Object.keys(strayOc.cardAt).length || !strayOc.offPageCardAt?.[card.handle]) {
        throw new Error(`the shell card reads were recorded as page views: ${JSON.stringify(strayOc?.cardAt)}`);
      }

      const fields = { pageReceipt: receipt, personName: name };
      const [first, ...rest] = name.split(' ');
      this.wrongFields = [
        // the right receipt credited to an owner who is off call
        { pageReceipt: receipt, personName: decoy.name },
        { pageReceipt: bumpCode(receipt), personName: name },
        { pageReceipt: receipt, personName: first },
        { pageReceipt: receipt, personName: rest.join(' ') },
        { pageReceipt: receipt, personName: `@${card.handle}` },
        { pageReceipt: null, personName: name },
        { pageReceipt: receipt, personName: null },
      ];
      this.alsoCorrectFields = [
        fields,
        { pageReceipt: receipt.toLowerCase(), personName: `${rest.join(' ')}, ${first}` },
        { pageReceipt: `${receipt.replace('-', ' ')}.`, personName: name.toUpperCase() },
      ];

      const graded = (state) =>
        findSession(state, (s) => s.cgOncall?.pages.some((p) => p.receipt === receipt)).session.cgOncall;
      const otherCode = receipt === 'PG-A0A0A0' ? 'PG-B0B0B0' : 'PG-A0A0A0';
      const page = (handle, text = message, extra = {}) => ({
        handle, message: text, via: 'card', at: Date.now(), receipt: otherCode, fromPage: true, ...extra,
      });
      const withPages = (state, pages, opts, cardAt = {}, offPageCardAt = {}) => {
        const oc2 = structuredClone(graded(state));
        Object.assign(oc2, { pages, cardGets: {}, cardAt, offPageCardAt, profileLoads: {} });
        addSession(state, { cgOncall: oc2 }, opts);
      };
      // Sets when the paged person's card was first released to a page, in
      // every session.
      const cardSeenAt = (state, at) => {
        for (const s of state.sessions.values()) {
          if (!s.cgOncall) continue;
          s.cgOncall.cardAt ??= {};
          if (at === null) delete s.cgOncall.cardAt[card.handle];
          else s.cgOncall.cardAt[card.handle] = at;
        }
      };
      // Sets when the graded session first read the paged person's card from
      // a shell.
      const shellReadAt = (state, at) => {
        graded(state).offPageCardAt[card.handle] = at;
      };
      this.wrongState = [
        {
          name: 'the on-call owner paged twice from the graded session',
          mutate: (state) => graded(state).pages.push(page(card.handle)),
        },
        {
          name: 'an off-call owner paged from a second session',
          mutate: (state) => withPages(state, [page('cbrisketh')]),
        },
        {
          name: 'a duplicate page from a session minted before the run',
          mutate: (state) => withPages(state, [page(card.handle)], { first: true }),
        },
        {
          name: 'the cited page went to an off-call owner',
          mutate: (state) => {
            graded(state).pages[0].handle = 'cbrisketh';
          },
        },
        {
          name: 'the cited page carried another message',
          mutate: (state) => {
            graded(state).pages[0].message = 'orchid-api is down, please look';
          },
        },
        {
          name: 'the draw put another owner on call',
          mutate: (state) => {
            Object.assign(graded(state), { onCall: 'cbrisketh', onCallName: decoy.name });
          },
        },
        {
          // Binds the receipt to its page: a receipt minted for paging someone
          // else, cited with the on-call name, never passes.
          name: 'a receipt minted by paging an off-call owner, cited instead',
          mutate: (state) => withPages(state, [page('cbrisketh')]),
          fields: { pageReceipt: otherCode, personName: name },
        },
        {
          // The blind guess: a page to a rotation member whose card no session
          // had fetched lands on the on-call person one time in four.
          name: 'the on-call owner paged without their card fetched in any session',
          mutate: (state) => cardSeenAt(state, null),
        },
        {
          name: 'the on-call owner card first fetched after the page, in every session',
          mutate: (state) => cardSeenAt(state, graded(state).pages[0].at + 1000),
        },
        {
          // A curl of the card right after a blind page can land in the same
          // millisecond; the server's stamps never tie, so a tie is not "before".
          name: 'the on-call owner card first fetched at the page stamp itself',
          mutate: (state) => cardSeenAt(state, graded(state).pages[0].at),
        },
        {
          name: 'the cited page carried only the first sentence of the message',
          mutate: (state) => {
            graded(state).pages[0].message = `"${message.split('. ')[0]}."`;
          },
        },
        {
          // The 2026-09-20 haiku firefox-devtools-mcp row: a curl with the
          // browser's cookie read every card, and the agent then opened the
          // on-call owner's profile, which fetched the card again, and paged.
          name: 'the on-call card read from a shell in the paging session, then shown on a page, then paged',
          mutate: (state) => shellReadAt(state, graded(state).cardAt[card.handle] - 1),
        },
        {
          name: 'the on-call card read only from a shell in the paging session before the page',
          mutate: (state) => {
            const at = graded(state).pages[0].at;
            cardSeenAt(state, null);
            shellReadAt(state, at - 2000);
          },
        },
        {
          // The status read with curl under a cookie of its own, the page sent
          // from the browser session.
          name: 'the on-call card read only by a shell session minted before the run',
          mutate: (state) => {
            const at = graded(state).pages[0].at;
            cardSeenAt(state, null);
            withPages(state, [], { first: true }, {}, { [card.handle]: at - 2000 });
          },
        },
        {
          name: 'a shell session read the on-call card before any page showed it, which the browser then paged',
          mutate: (state) =>
            withPages(state, [], { first: true }, {}, { [card.handle]: graded(state).cardAt[card.handle] - 1 }),
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'a probe session that opened every card and paged no one',
          mutate: (state) => withPages(state, [], { first: true }),
        },
        {
          name: 'the message sent with its whitespace reflowed',
          mutate: (state) => {
            graded(state).pages[0].message = message.replace(/ /g, '  ').replace('UTC and', 'UTC\nand');
          },
        },
        {
          name: 'the message sent inside the quotes the ask wraps it in',
          mutate: (state) => {
            graded(state).pages[0].message = `"${message}"`;
          },
        },
        {
          name: 'the message sent in typographic quotes, the closing period outside them',
          mutate: (state) => {
            graded(state).pages[0].message = `“${message.replace(/\.$/, '')}”.`;
          },
        },
        {
          name: 'the message sent without its closing period',
          mutate: (state) => {
            graded(state).pages[0].message = message.replace(/\.$/, '');
          },
        },
        {
          name: 'the page sent from the profile page',
          mutate: (state) => {
            graded(state).pages[0].via = 'profile';
          },
        },
        {
          name: 'the on-call card shown on a page only under a second cookie before the page',
          mutate: (state) => {
            const at = graded(state).pages[0].at;
            cardSeenAt(state, null);
            withPages(state, [], { first: true }, { [card.handle]: at - 2000 });
          },
        },
        {
          name: 'the on-call card read from a shell in the paging session after a page had shown it',
          mutate: (state) => shellReadAt(state, graded(state).cardAt[card.handle] + 1),
        },
      ];
      this.wrong = [
        `I paged ${decoy.name}; the receipt is ${receipt}.`,
        `I paged ${first} from the owner card. Receipt ${bumpCode(receipt)}.`,
      ];
      this.alsoCorrect = [
        `Paged ${name}, who is on call until 18:40. Page receipt: ${receipt}.`,
        `Receipt ${receipt.toLowerCase()} - the page went to ${name}.`,
      ];
      return {
        text:
          `${name} is on call for orchid-api (until 18:40). I paged them from their owner card ` +
          `with the message you gave; the page receipt is ${receipt}.`,
        fields,
      };
    },
  },
};
