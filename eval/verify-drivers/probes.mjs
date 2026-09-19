// Golden paths, one per task, for verify.mjs. Each driver performs the real
// interaction through our own MCP server and returns the answer text a correct
// agent would produce.
//
// Shape:
//   '<task id>': {
//     canned?: true,   // prose/judgment task: interaction is real, prose is not
//     note?: string,   // shown by --list
//     wrong?: string,  // a wrong answer the validator MUST reject (default given)
//     run: async ({ mcp, base, goto, evaluate, snapshot, sleep, mark }, ctx) => answerText
//   }
//
// Keep drivers honest: do the work the way an agent would have to, and do not
// read the answer out of ctx.pages.state unless the task is unsolvable without
// it (fog-of-war, server-held word) — say so in `note` when you do.
//
// `mark(label)` stamps a named point into the Gecko profile that
// `node verify.mjs --profile` records, so a cost in the profile can be pinned to
// a step rather than to the task as a whole. verify.mjs already brackets every
// task; call this to split the inside of one, e.g.
//
//   await mark('grid-rendered');
//
// It is a no-op without --profile, so a driver may call it freely. Labels only
// need to be unique within their own driver, since the running task's id is
// prefixed for you.

import { bumpCode, textOf, uidOf, until } from './lib.mjs';

// A second session that never touched the browser: the fixture server mints a
// cookie and a nonce for any HTML GET, so a curl probe (or a re-minted cookie)
// can shadow the graded session. Drivers use this to prove that winner selection
// ignores a session which did no work.
export async function straySession(base, path) {
  const res = await fetch(base + path, { headers: { accept: 'text/html' } });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const nonce = (await res.text()).match(/const NONCE = '([0-9a-f]+)'/)?.[1] ?? null;
  if (!cookie || !nonce) throw new Error(`no stray session for ${path}`);
  return {
    nonce,
    async post(apiPath, body) {
      const r = await fetch(base + apiPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ nonce, ...body }),
      });
      return r.json();
    },
  };
}

export const DRIVERS = {
  // --- static extraction: no server gate, answer is derived from the page ---
  'dead-images': {
    note: 'naturalWidth scan; snapshot cannot see load state',
    wrong: ['All twelve product photos loaded correctly.'],
    async run({ goto, evaluate }) {
      await goto('/gallery/');
      // img.complete stays false until each load attempt settles; poll rather
      // than sleep, or a warm browser reports zero broken images. Proceed on
      // timeout: the broken-count assertion below is the real gate.
      await until(
        'every image load attempt to settle',
        () => evaluate(() => [...document.images].every((img) => img.complete)),
        { tries: 20 }
      ).catch(() => {});
      const broken = await evaluate(() => {
        const out = [];
        for (const card of document.querySelectorAll('.card, li, article')) {
          const img = card.querySelector('img');
          if (img && img.complete && img.naturalWidth === 0) {
            const name = card.querySelector('h2, h3, .name, .title');
            if (name) out.push(name.textContent.trim());
          }
        }
        return out;
      });
      if (broken.length !== 3) throw new Error(`expected 3 broken images, saw ${broken.length}`);
      const loaded = (
        await evaluate(() => {
          const out = [];
          for (const card of document.querySelectorAll('.card, li, article')) {
            const img = card.querySelector('img');
            if (img && img.complete && img.naturalWidth > 0) {
              const name = card.querySelector('h2, h3, .name, .title');
              if (name) out.push(name.textContent.trim());
            }
          }
          return out;
        })
      ).filter((name) => !broken.includes(name));
      if (!loaded.length) throw new Error('no loaded product to use as a decoy');
      const fields = { brokenProducts: broken };
      this.wrongFields = [
        { brokenProducts: [] },
        { brokenProducts: broken.slice(0, 2) },
        { brokenProducts: [...broken, 'Halberd'] },
        { brokenProducts: [broken[0], broken[1], 'Halberd'] },
        { brokenProducts: [broken[0], broken[1], loaded[0]] },
      ];
      this.alsoCorrectFields = [fields, { brokenProducts: [...broken].reverse() }];
      this.wrong = [
        this.wrong[0],
        `Only ${broken[0]} and ${broken[1]} have broken photos; the ${broken[2]} ` +
          `image loaded fine on a second look.`,
        `Four product photos failed to load: ${broken.join(', ')} and ${loaded[0]}.`,
      ];
      this.alsoCorrect = [
        `I checked all twelve cards for images with naturalWidth of zero. Nine ` +
          `photos rendered correctly; the products whose photos are broken are ` +
          `${broken.join(', ')}.`,
        `Broken product photos:\n${broken.map((n) => `- ${n}`).join('\n')}`,
        `${[...broken].reverse().join(', ')} are the three products with broken ` +
          `photos; every other photo loaded.`,
      ];
      return {
        text: `These product photos failed to load: ${broken.join(', ')}. The other nine loaded fine.`,
        fields,
      };
    },
  },

  // --- hit-testing probe: the covered button must never fire ---
  'promo-zindex': {
    note: 'real click at the overlap point',
    wrong: ['I claimed the offer but no voucher code appeared.'],
    async run({ goto, evaluate, mcp, snapshot, sleep }) {
      await goto('/promo/');
      const snap = await snapshot();
      // The snapshot lists BOTH claim buttons and the covered one can come
      // first — that ambiguity is the probe. Resolve each candidate back to a
      // selector and click the one that is actually the top offer, through the
      // tool surface so hit-testing is genuinely exercised.
      const uids = [...snap.matchAll(/uid=(\S+) button "Claim offer"/g)].map((m) => m[1]);
      if (!uids.length) throw new Error('no Claim offer button in the snapshot');
      let target = null;
      for (const uid of uids) {
        const r = await mcp('resolve_uid_to_selector', { uid });
        if (/claim-top/.test(textOf(r))) target = uid;
      }
      if (!target) throw new Error(`none of ${uids.length} candidate uids resolved to #claim-top`);
      await mcp('click_by_uid', { uid: target });
      await sleep(600);
      const voucher = await evaluate(() => document.getElementById('result')?.textContent ?? '');
      const code = String(voucher).match(/[A-Z]{3}-[A-Z0-9]{4}/);
      if (!code) throw new Error(`no voucher rendered; result read "${voucher}"`);
      const bumped = bumpCode(code[0]);
      const fields = { voucherCode: code[0] };
      this.wrongFields = [{ voucherCode: 'VLT-0000' }, { voucherCode: bumped }];
      this.alsoCorrectFields = [fields, { voucherCode: code[0].toLowerCase() }];
      this.wrong = [
        this.wrong[0],
        `I claimed the Midweek Bakery offer; the voucher code printed on the ` +
          `board is LM-121.`,
        `The claim went through and the screen printed voucher code ${bumped}.`,
      ];
      this.alsoCorrect = [
        `Two Claim offer buttons overlap and only the top one actually receives ` +
          `the click. After clicking it, the result line read "Offer claimed. ` +
          `Your voucher code: ${code[0]}".`,
        `Voucher code: ${code[0]}`,
        `The offer was claimed; the voucher code is ${code[0].toLowerCase()}.`,
      ];
      return {
        text: `I claimed the offer that was actually on top. The voucher code is ${code[0]}.`,
        fields,
      };
    },
  },

  // --- shadow DOM: content lives inside two nested open roots ---
  'shadow-unlock': {
    note: 'reaches through two open shadow roots',
    wrong: ['The widget said access denied.'],
    // The message is the same for every session, so what binds the answer to
    // this run is the server having seen a correct-code unlock at all.
    wrongState: [
      {
        name: 'every unlock the server saw carried a wrong code',
        mutate(state) {
          for (const b of state.beacons) if (b.kind === 'shadow-unlock') b.data.code = 'ORCHID-21';
        },
      },
    ],
    async run({ base, goto, evaluate }, ctx) {
      // A cookie+nonce curl unlock is accepted by policy (sec-fetch is not
      // browser proof), but it must be LEGIBLE: the beacon it mints has to be
      // marked off-page, or a shell run is byte-identical to a widget run.
      const page = await fetch(base + '/shadow/');
      const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
      const nonce = (await page.text()).match(/NONCE = '([0-9a-f]+)'/)?.[1];
      if (!cookie || !nonce) throw new Error('forge probe could not mint a session');
      await fetch(base + '/api/shadow/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ nonce, code: 'ORCHID-22' }),
      });
      const forged = ctx.pages.state
        .beaconsOf('shadow-unlock')
        .find((b) => b.data?.code === 'ORCHID-22');
      if (!forged || forged.data.fromPage !== false) {
        throw new Error('a curl unlock is not legible as off-page in the beacon');
      }
      await goto('/shadow/');
      await evaluate(() => {
        const panel = document.querySelector('fx-panel');
        const inner = panel.shadowRoot.querySelector('fx-input');
        const input = inner.shadowRoot.querySelector('input');
        input.value = 'ORCHID-22';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        inner.shadowRoot.querySelector('button').click();
      });
      // The widget shows "Checking…" until the unlock answers, so wait for a
      // message that placeholder cannot be.
      const msg = await until('the unlock message to render', async () => {
        const text = await evaluate(() => {
          const panel = document.querySelector('fx-panel');
          const inner = panel.shadowRoot.querySelector('fx-input');
          return inner.shadowRoot.querySelector('.msg')?.textContent?.trim() ?? '';
        });
        return typeof text === 'string' && text && !/^Checking/.test(text) ? text : null;
      });
      if (!/Metronome/i.test(msg)) throw new Error(`unlock message not rendered; read "${msg}"`);
      const fields = { message: msg };
      this.wrongFields = [{ message: 'Access denied: invalid code' }];
      this.alsoCorrectFields = [fields, { message: `"${msg.toLowerCase()}".` }];
      this.wrong = [
        this.wrong[0],
        `I typed ORCHID-22 into the widget but the panel replied: Access denied: invalid code.`,
      ];
      this.alsoCorrect = [
        `I reached through both open shadow roots, entered ORCHID-22 and pressed ` +
          `the button. The widget's unlock message reads: ${msg}`,
        `Unlock message: ${msg}`,
        `The panel unlocked. It says "${msg}".`,
      ];
      return { text: `The widget unlocked and showed: ${msg}`, fields };
    },
  },

  // --- canvas coordinate click, no per-cell DOM ---
  'canvas-pick': {
    note: 'dispatches a MouseEvent at the orange cell coordinates',
    wrong: ['I clicked a cell but no code appeared.'],
    async run({ base, goto, evaluate }) {
      await goto('/canvas/swatch.html');
      const found = await evaluate(() => {
        const c = document.querySelector('canvas');
        const ctx = c.getContext('2d');
        const { width, height } = c;
        for (let y = 10; y < height; y += 10) {
          for (let x = 10; x < width; x += 10) {
            const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
            if (r > 200 && g > 100 && g < 170 && b < 60) {
              const rect = c.getBoundingClientRect();
              c.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                clientX: rect.left + x,
                clientY: rect.top + y,
              }));
              return { x, y };
            }
          }
        }
        return null;
      });
      if (!found) throw new Error('no orange cell found on the canvas');
      // The status line reads "Checking swatch ..." until the reveal lands, and
      // the page's static work-order number also matches a bare LETTERS-digits
      // pattern, so wait on the reveal line itself turning ok.
      const code = await until('the orange cell to reveal its code', async () => {
        const revealed = await evaluate(() => {
          const el = document.getElementById('revealed');
          return el?.classList.contains('ok') ? el.textContent : '';
        });
        return String(revealed).match(/AMBER-\d{3}/);
      });
      // Repeat-pick forge, in its own session: the same wrong cell four times,
      // then the orange one. Only two distinct cells precede that hit, so it
      // fails on its own five picks, which no other gate here catches.
      const repeater = await straySession(base, '/canvas/swatch.html');
      let repeatCode = null;
      for (const cell of ['C3R2', 'C3R2', 'C3R2', 'C3R2', 'C4R2']) {
        const r = await repeater.post('/api/canvas/reveal', { cell });
        if (r.code) repeatCode = r.code;
      }
      if (!repeatCode) throw new Error('the repeat-pick probe never leaked a code');
      // Blind-sweep forge: 48 reveal POSTs with zero canvas interaction leak the
      // code, and the answer they produce must fail. Run the sweep AFTER the
      // honest pick, so the exploration-order gate leaves the honest pick a
      // winner while the sweep session's own late hit can never become one. The
      // sweep mints its own session, which is the shape that defeats any gate
      // keyed to the graded session alone.
      const page = await fetch(base + '/canvas/swatch.html');
      const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
      const nonce = (await page.text()).match(/NONCE = '([0-9a-f]+)'/)?.[1];
      if (!cookie || !nonce) throw new Error('sweep probe could not mint a session');
      let sweptCode = null;
      for (let row = 1; row <= 6; row++) {
        for (let col = 1; col <= 8; col++) {
          const res = await fetch(base + '/api/canvas/reveal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ nonce, cell: `C${col}R${row}` }),
          });
          const body = await res.json().catch(() => ({}));
          if (body.code) sweptCode = body.code;
        }
      }
      if (!sweptCode) throw new Error('the sweep never leaked a code');
      this.wrong = [
        this.wrong[0],
        `I checked every swatch methodically; the orange cell is C4R2 and the ` +
          `calibration code is ${sweptCode}.`,
      ];
      this.alsoCorrect = [
        `The orange swatch sits at column 4, row 2, and clicking it revealed ` +
          `${code[0].toLowerCase().replace('-', '–')}.`,
      ];
      const fields = { code: code[0] };
      this.wrongFields = [
        { code: sweptCode === code[0] ? 'AMBER-000' : sweptCode },
        { code: repeatCode === code[0] ? 'AMBER-000' : repeatCode },
        { code: 'AMBER-000' },
      ];
      this.alsoCorrectFields = [fields, { code: code[0].toLowerCase() }];
      return { text: `The orange cell revealed the code ${code[0]}.`, fields };
    },
  },

  // --- retry loop: the endpoint fails twice per session before succeeding ---
  'flaky-retry': {
    note: 'clicks Load/Retry until the report renders',
    wrong: ['The report never loaded, so there is no revenue figure.'],
    async run({ goto, evaluate, snapshot, mcp, sleep }) {
      await goto('/flaky/');
      let figure = '';
      for (let attempt = 0; attempt < 6 && !figure; attempt++) {
        const snap = await snapshot();
        const m = snap.match(/uid=(\S+) button "(?:Load Report|Retry)"/i);
        if (!m) throw new Error('no Load Report / Retry button in the snapshot');
        await mcp('click_by_uid', { uid: m[1] });
        await sleep(700);
        figure = await evaluate(() => {
          const t = document.body.innerText;
          const m2 = t.match(/\$[\d,]{5,}/);
          return m2 ? m2[0] : '';
        });
      }
      if (!figure) throw new Error('report never rendered after 6 attempts');
      const numeric = Number(String(figure).replace(/[$,]/g, ''));
      // The "Open receivables" tile is the on-page figure most likely to be
      // misreported as the revenue.
      const receivables = await evaluate(() => {
        const tile = [...document.querySelectorAll('.tile')].find((t) =>
          /Open receivables/i.test(t.textContent)
        );
        return tile?.querySelector('b')?.textContent.trim() ?? '';
      });
      const receivablesNum = Number(String(receivables).replace(/[$,]/g, ''));
      if (!Number.isFinite(receivablesNum) || !receivablesNum || receivablesNum === numeric) {
        throw new Error(`open-receivables decoy tile unusable; read "${receivables}"`);
      }
      const fields = { q3Revenue: numeric };
      this.wrongFields = [
        { q3Revenue: numeric + 1000 },
        { q3Revenue: null },
        { q3Revenue: receivablesNum },
      ];
      this.alsoCorrectFields = [fields];
      this.wrong = [
        this.wrong[0],
        `The report loaded after two failures. Q3 total revenue is ` +
          `$${receivables}, with open receivables of ${figure}.`,
      ];
      this.alsoCorrect = [
        `The first two loads failed with server errors; the third attempt ` +
          `rendered the report. Total Q3 revenue: ${figure}.`,
        `Q3 revenue: ${figure}`,
        `After retrying, the consolidated report puts Q3 total revenue at ` +
          `${numeric.toLocaleString('en-US')} dollars.`,
      ];
      return {
        text: `The backend failed twice, then the report loaded. Q3 revenue is ${figure}.`,
        fields,
      };
    },
  },

  // --- server-gated multi-step form; server measures the submitted payload ---
  'brochure-minimal': {
    note:
      'fills name+email and submits through the tool surface, skips the nag by ' +
      'its button uid, and reads the BRQ code off the snapshot - proving the ' +
      'designed route end to end',
    wrong: ['I requested the brochure but saw no confirmation number.'],
    async run({ mcp, goto, snapshot, evaluate }) {
      await goto('/forms/kestrel/brochure.html');
      const snap = await snapshot();
      // The inputs carry no accessible names (A5), so address the first two
      // by document order: name, then email.
      const inputs = [...snap.matchAll(/uid=(\S+) input/g)].map((m) => m[1]);
      if (inputs.length < 2) throw new Error('name and email inputs not in the snapshot');
      await mcp('fill_by_uid', { uid: inputs[0], value: 'Dana Reyes' });
      await mcp('fill_by_uid', { uid: inputs[1], value: 'dana.reyes@example.com' });
      const submit = uidOf(snap, 'button "Request brochure"');
      if (!submit) throw new Error('no Request brochure button in the snapshot');
      await mcp('click_by_uid', { uid: submit });

      // The optional-details nag pre-exists hidden, and the snapshot leaks the
      // text of hidden nodes - so wait on the DOM for it to actually show
      // before trusting a fresh uid for its skip button.
      await until(
        'the optional-details nag to appear',
        () => evaluate(() => !document.getElementById('nag').hidden)
      );
      const skip = uidOf(await snapshot(), 'button "Skip and submit"');
      if (!skip) throw new Error('no Skip and submit button in the snapshot');
      await mcp('click_by_uid', { uid: skip });

      const code = await until(
        'the confirmation number to reach the snapshot',
        async () => (await snapshot()).match(/BRQ-[0-9A-F]{6}/)
      );
      const bumped = bumpCode(code[0]);
      const fields = { confirmationNumber: code[0] };
      this.wrongFields = [
        { confirmationNumber: 'BR-000000' },
        { confirmationNumber: bumped },
      ];
      this.alsoCorrectFields = [fields, { confirmationNumber: code[0].toLowerCase() }];
      this.wrong = [
        this.wrong[0],
        `The brochure request went through; the confirmation number shown was ${bumped}.`,
      ];
      this.alsoCorrect = [
        `I filled only the name and email fields, skipped the optional-details ` +
          `nag, and the request was accepted. Confirmation number: ${code[0]}.`,
        `Confirmation number: ${code[0]}`,
        `Request confirmed as ${code[0].toLowerCase()}.`,
      ];
      return {
        text: `Requested with name and email only. Confirmation number ${code[0]}.`,
        fields,
      };
    },
  },

  // --- judgment/prose task: interaction is real, the verdict cannot be scripted ---
  'phish-pick': {
    canned: true,
    note: 'visits both pages; the verdict prose is canned',
    // wrong[1..2]: the right pick supported only by a description of the LEGITIMATE
    // page's logo, or the bare word "square" — the logo tell is too wide to score,
    // so neither may pass. alsoCorrect: contrastive and imperative negations, which
    // a NEG_FRAUD gap or a bare copula 'not' misreads as a denial of the pick or as
    // an accusation of the real bank.
    wrong: [
      'Both pages looked legitimate to me.',
      'The fraudulent page is /bank/caldmoor-bank-login/ and the legitimate one is ' +
        '/bank/caldmoorbank-online/. Two things gave it away: the header logo is not the navy ' +
        'rounded square a bank would use, and the sign-in form asks for the whole password ' +
        'on the first screen instead of a two-step flow.',
      '/bank/caldmoor-bank-login/ is the phishing site; /bank/caldmoorbank-online/ is the real one. ' +
        'The logo shape is wrong (a square where the real page has something else) and the ' +
        'copy reads like a scam.',
    ],
    alsoCorrect: [
      '/bank/caldmoorbank-online/ is not a phishing clone; /bank/caldmoor-bank-login/ is the ' +
        'fraudulent one. On the fake page the footer legal name reads "CaldmoorBenk Holdings, ' +
        'N.A." and it paints its own "Verified Secure Connection" SiteTrust seal into the page.',
      'Do not use /bank/caldmoor-bank-login/ - it is a phishing clone. Sign in only at ' +
        '/bank/caldmoorbank-online/. On the fake, the footer legal name reads "CaldmoorBenk ' +
        'Holdings, N.A." and there is a "Verified Secure Connection" SiteTrust badge ' +
        'painted into the page body.',
      '/bank/caldmoor-bank-login/ is not the legitimate page - /bank/caldmoorbank-online/ is. On ' +
        'the fake, the footer legal name reads "CaldmoorBenk Holdings, N.A.", and it paints its ' +
        'own "Verified Secure Connection" SiteTrust seal into the page.',
      'The fake is /bank/caldmoor-bank-login/. /bank/caldmoorbank-online/ is not the phishing page ' +
        '- it is the bank\'s own sign-in. Tells on the fake: the footer legal name reads ' +
        '"CaldmoorBenk Holdings, N.A.", and it paints its own "Verified Secure Connection" ' +
        'SiteTrust seal into the page.',
    ],
    async run({ goto, evaluate }) {
      await goto('/bank/caldmoorbank-online/');
      const legit = await evaluate(() => document.body.innerText);
      await goto('/bank/caldmoor-bank-login/');
      // Read the WHOLE page: the footer typo and the fake seal sit below the
      // fold by design, so a truncated read misses the tells entirely.
      const fake = await evaluate(() => document.body.innerText);
      // Prove the tells are actually present before asserting them in prose.
      if (!/CaldmoorBenk/i.test(fake)) throw new Error('footer typo tell missing from the lookalike');
      if (/CaldmoorBenk/i.test(legit)) throw new Error('typo tell leaked onto the legitimate page');
      const fields = {
        fraudulentUrl: '/bank/caldmoor-bank-login/',
        legitimateUrl: '/bank/caldmoorbank-online/',
        tells: [
          'footer reads "CaldmoorBenk Holdings", a misspelling of the bank name',
          'a "Verified Secure Connection" SiteTrust seal rendered as page content',
        ],
      };
      this.wrongFields = [
        { ...fields, fraudulentUrl: '/bank/caldmoorbank-online/', legitimateUrl: '/bank/caldmoor-bank-login/' },
        { ...fields, tells: ['it just looks suspicious overall'] },
        { fraudulentUrl: null, legitimateUrl: '/bank/caldmoorbank-online/', tells: fields.tells },
      ];
      this.alsoCorrectFields = [
        fields,
        { ...fields, fraudulentUrl: 'caldmoor-bank-login', legitimateUrl: 'caldmoorbank-online' },
      ];
      return {
        text: [
          'The fraudulent page is /bank/caldmoor-bank-login/ and the legitimate one is /bank/caldmoorbank-online/.',
          'Two concrete tells on the fake: its footer reads "CaldmoorBenk Holdings" (a misspelling of the',
          'bank name), and it shows a "Verified Secure Connection" SiteTrust seal, which is page content',
          'rather than a real browser indicator. I did not enter any credentials.',
        ].join(' '),
        fields,
      };
    },
  },
};
