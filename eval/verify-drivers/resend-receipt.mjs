// pages/gov/certcopy.html - Bureau of Civic Revenue certified-copy request (resend-receipt).
import { addSession, bumpCode, clickToPath, findSession, uidOf, until } from './lib.mjs';

const REQUEST = {
  acct: 'TA-4082-6617',
  doc: 'CD',
  year: '2025',
  copies: '1',
  ctype: 'certified',
  delivery: 'mail',
};

// A session outside the browser that loads the request form and posts it the
// way the form does: urlencoded, carrying the page's nonce and form id.
// lib.mjs's straySession reads a script nonce, and this page has no script.
async function formSession(base) {
  const page = await fetch(`${base}/gov/certcopy.html`, { headers: { accept: 'text/html' } });
  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
  const html = await page.text();
  const nonce = html.match(/name="nonce" value="([0-9a-f]+)"/)?.[1];
  const formid = html.match(/name="formid" value="([0-9a-f]+)"/)?.[1];
  if (!cookie || !nonce || !formid) throw new Error('no stray session for the request form');
  const post = async (fields, { withCookie = true } = {}) => {
    const res = await fetch(`${base}/gov/certcopy.cgi`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(withCookie ? { cookie } : {}),
      },
      body: new URLSearchParams({ nonce, formid, ...fields }).toString(),
    });
    return {
      status: res.status,
      location: res.headers.get('location'),
      cacheControl: res.headers.get('cache-control') ?? '',
      html: await res.text(),
    };
  };
  return { post };
}

export const DRIVERS = {
  'resend-receipt': {
    note:
      'a second cookie files a duplicate first; the browser files the request, finds both on ' +
      'Request Status, withdraws the older one and reports the one left on file',
    async run({ mcp, goto, evaluate, snapshot }, ctx) {
      const filed = () =>
        [...ctx.pages.state.sessions.values()].flatMap((s) => s.certcopy?.requests ?? []);

      // The fixture's own contract, over plain HTTP: a POST without the
      // session's cookie or nonce files nothing, and a filed request is
      // answered 200 with no redirect and no-store, so the browser keeps a
      // POST history entry that it cannot restore from cache.
      const stray = await formSession(ctx.pages.url);
      const forged = await stray.post({ ...REQUEST, nonce: 'f'.repeat(24) });
      const cookieless = await stray.post(REQUEST, { withCookie: false });
      if (forged.status !== 403 || cookieless.status !== 403) {
        throw new Error(`refused POSTs answered ${forged.status} and ${cookieless.status}, not 403`);
      }
      if (filed().length) throw new Error('a refused POST filed a request');
      const incomplete = await stray.post({ ...REQUEST, ctype: '' });
      if (!/Request Not Accepted/.test(incomplete.html) || filed().length) {
        throw new Error('a request with no copy type was not rejected');
      }
      // A form id no load issued names no form load, even one that is an
      // inherited property name.
      await stray.post({ ...REQUEST, ctype: '', formid: '__proto__' });
      if ('posts' in {}) throw new Error('a POST with form id __proto__ wrote to Object.prototype');
      // The duplicate: the same request filed under another cookie, as a
      // resend from a second browser or a scripted retry would leave it.
      const dup = await stray.post(REQUEST);
      if (dup.status !== 200 || dup.location || !/no-store/.test(dup.cacheControl)) {
        throw new Error(
          `the receipt answered ${dup.status} location=${dup.location} cache-control="${dup.cacheControl}"`
        );
      }
      if (filed().length !== 1) throw new Error('the stray POST did not file exactly one request');
      // The rejected POST carried the same form id, so the filing after it
      // reads as a retry of that form load, not a resend of a filed one.
      const { sameFormLoad, sameFormFiled } = filed()[0];
      if (sameFormLoad !== 1 || sameFormFiled !== 0) {
        throw new Error(
          `the filing after a rejected POST of its form load counts ${sameFormLoad} earlier POSTs ` +
            `and ${sameFormFiled} earlier filings, not 1 and 0`
        );
      }

      await goto('/gov/certcopy.html');
      let snap = await until('the request form in the snapshot', async () => {
        const s = await snapshot();
        return uidOf(s, 'input "Account number"') ? s : null;
      });
      await mcp('fill_by_uid', { uid: uidOf(snap, 'input "Account number"'), value: REQUEST.acct });
      snap = await snapshot();
      await mcp('fill_by_uid', {
        uid: uidOf(snap, 'select "Document requested"'),
        value: 'Combined Declaration (Forms CD-1, CD-1EZ, CD-2)',
      });
      snap = await snapshot();
      await mcp('fill_by_uid', { uid: uidOf(snap, 'select "Tax year"'), value: REQUEST.year });
      snap = await snapshot();
      await mcp('click_by_uid', { uid: uidOf(snap, 'input "Certified copy') });
      snap = await snapshot();
      await mcp('click_by_uid', { uid: uidOf(snap, 'input "By first-class mail') });
      const form = await evaluate(() => {
        const f = document.querySelector('form[action="certcopy.cgi"]');
        const names = ['acct', 'doc', 'year', 'copies', 'ctype', 'delivery'];
        return Object.fromEntries(names.map((k) => [k, f[k].value]));
      });
      for (const [k, v] of Object.entries(REQUEST)) {
        if (form?.[k] !== v) throw new Error(`the form holds ${k}=${form?.[k]}, not ${v}`);
      }

      // A form POST is not idempotent, so one click and no clickToPath retry.
      snap = await snapshot();
      await mcp('click_by_uid', { uid: uidOf(snap, 'input value="Submit Request"') });
      const receipt = await until('the receipt of the browser request', async () => {
        if (filed().length < 2) return null;
        const r = await evaluate(() => ({ path: location.pathname, text: document.body?.innerText ?? '' }));
        return /certcopy\.cgi$/.test(r?.path ?? '') && /Request Received/i.test(r.text) ? r : null;
      });
      if (filed().length !== 2) throw new Error(`the submit filed ${filed().length - 1} requests, not 1`);
      // The numbered receipt prints it; the deferred one leaves it to the listing.
      const printed = receipt.text.match(/CR-2026-[0-9A-F]{5}/)?.[0] ?? null;

      // Re-requesting the CGI address, the only reload a navigate tool can
      // make, is a GET and files nothing.
      await goto('/gov/certcopy.cgi');
      await until('the no-data page', async () =>
        /No\s+request form data/.test(await evaluate(() => document.body?.innerText ?? '')));
      if (filed().length !== 2) throw new Error('a GET of the CGI address filed a request');

      await goto('/gov/request-status.html');
      snap = await until('the lookup form', async () => {
        const s = await snapshot();
        return uidOf(s, 'input "Account number"') ? s : null;
      });
      await mcp('fill_by_uid', { uid: uidOf(snap, 'input "Account number"'), value: REQUEST.acct });
      // A GET form submit is idempotent, so clickToPath may retry it.
      const lookUp = async () => uidOf(await snapshot(), 'input value="Look Up"');
      await clickToPath(mcp, evaluate, lookUp, 'reqstatus.cgi');
      const listing = () =>
        evaluate(() =>
          [...document.querySelectorAll('tr')]
            .map((tr) => [...tr.cells].map((c) => c.innerText.trim()))
            .filter((cells) => /^CR-2026-[0-9A-F]{5}$/.test(cells[0] ?? ''))
            .map((cells) => ({ number: cells[0], status: cells[5] }))
        );
      const rows = await until('both requests in the listing', async () => {
        const r = await listing();
        return Array.isArray(r) && r.length === 2 ? r : null;
      });
      if (rows.some((r) => r.status !== 'ON FILE')) throw new Error(`listing: ${JSON.stringify(rows)}`);
      // Oldest first, so the first row is the duplicate the stray filed.
      const [older, newer] = rows;
      if (printed && printed !== newer.number) {
        throw new Error(`the receipt printed ${printed}, the listing's newer request is ${newer.number}`);
      }

      snap = await snapshot();
      const withdraws = [...snap.matchAll(/uid=(\S+) input value="Withdraw"/g)].map((m) => m[1]);
      if (withdraws.length !== 2) {
        throw new Error(`${withdraws.length} Withdraw buttons in the snapshot, not 2`);
      }
      await mcp('click_by_uid', { uid: withdraws[0] });
      await until('the withdrawal to land', async () => {
        const text = await evaluate(() => document.body?.innerText ?? '');
        return new RegExp(`Request ${older.number} has been withdrawn`).test(text);
      });
      await clickToPath(
        mcp,
        evaluate,
        async () => uidOf(await snapshot(), 'a "Return to the requests'),
        'reqstatus.cgi'
      );
      const after = await until('the listing after the withdrawal', async () => {
        const r = await listing();
        return Array.isArray(r) && r.length === 2 && r[0].status === 'WITHDRAWN' ? r : null;
      });
      if (after[1].number !== newer.number || after[1].status !== 'ON FILE') {
        throw new Error(`after the withdrawal the listing reads ${JSON.stringify(after)}`);
      }
      const ours = newer.number;
      const duplicate = older.number;

      // The provenance the detail reports: the stray POST sends no
      // Sec-Fetch-Dest, and Firefox's form submit and Withdraw click send
      // document from a /gov/ page.
      const withdrawal = [...ctx.pages.state.sessions.values()]
        .flatMap((s) => s.certcopy?.withdrawals ?? [])
        .find((w) => w.number === duplicate);
      const shape = (x) => `${x?.dest ?? 'unset'}/${x?.fromPage}`;
      const shapes = [filed().find((r) => r.number === duplicate), filed().find((r) => r.number === ours), withdrawal]
        .map(shape)
        .join(' ');
      if (shapes !== 'unset/false document/true document/true') {
        throw new Error(`stray request, browser request and withdrawal came from ${shapes}`);
      }
      // And the headers the filings list adds: the stray sends neither, and the
      // submit click sends Sec-Fetch-User and the form as Referer, in every
      // serving mode.
      const sent = [duplicate, ours]
        .map((n) => filed().find((r) => r.number === n))
        .map((r) => `${r.user ?? 'unset'}/${r.referer ?? 'none'}`)
        .join(' ');
      if (sent !== 'unset/none ?1//gov/certcopy.html') {
        throw new Error(`stray and browser requests sent Sec-Fetch-User/Referer ${sent}`);
      }

      const fields = { requestNumber: ours };
      this.wrongFields = [
        // The withdrawn duplicate, which the Bureau no longer has on file.
        { requestNumber: duplicate },
        { requestNumber: bumpCode(ours) },
        // The account number reported as the request number.
        { requestNumber: REQUEST.acct },
        // A hedge between the two numbers the listing shows.
        { requestNumber: `${duplicate} or ${ours}` },
      ];
      this.alsoCorrectFields = [
        fields,
        { requestNumber: ours.toLowerCase() },
        { requestNumber: `Request number ${ours}.` },
        { requestNumber: ours.replace('-', ' ') },
      ];

      // A request as certcopy.cgi stores one, for planting in a copy of the state.
      const other = (n) => {
        const code = `CR-2026-${String(n).repeat(5)}`;
        return [ours, duplicate].includes(code) ? `CR-2026-${String(n + 1).repeat(5)}` : code;
      };
      const request = (number, over = {}) => ({
        number,
        account: REQUEST.acct,
        document: 'CD',
        year: '2025',
        copies: 1,
        copyType: 'certified',
        delivery: 'mail',
        status: 'on-file',
        at: Date.now(),
        sameFormLoad: 0,
        sameFormFiled: 0,
        dest: 'document',
        fromPage: true,
        ...over,
      });
      const copies = (requests, over = {}) => ({
        certcopy: {
          forms: {}, filingPosts: requests.length, withdrawPosts: 0, rejected: 0, refused: 0, gets: 0,
          requests, withdrawals: [], lookups: [], ...over,
        },
      });
      const holder = (state, number) =>
        findSession(state, (s) => (s.certcopy?.requests ?? []).some((r) => r.number === number))
          .session.certcopy;
      const find = (state, number) => holder(state, number).requests.find((r) => r.number === number);
      const edit = (over) => (state) => Object.assign(find(state, ours), over);
      this.wrongState = [
        {
          name: 'a resend in the browser session left a second matching request on file',
          mutate: (state) =>
            holder(state, ours).requests.push(request(other(1), { sameFormLoad: 1, sameFormFiled: 1 })),
        },
        {
          name: 'a matching duplicate still on file under a fresh cookie',
          mutate: (state) => addSession(state, copies([request(other(2))])),
        },
        {
          name: 'a matching duplicate still on file in a session minted before the run',
          mutate: (state) => addSession(state, copies([request(other(3))]), { first: true }),
        },
        {
          name: "another account's request left on file",
          mutate: (state) => addSession(state, copies([request(other(4), { account: 'TA-4082-6671' })])),
        },
        {
          name: 'the withdrawn duplicate back on file',
          mutate: (state) => Object.assign(find(state, duplicate), { status: 'on-file' }),
        },
        { name: 'the request withdrawn too, leaving nothing on file', mutate: edit({ status: 'withdrawn' }) },
        { name: 'the request is for tax year 2024', mutate: edit({ year: '2024' }) },
        { name: 'the request is for the extension request', mutate: edit({ document: 'CDX' }) },
        { name: 'the request is for two copies', mutate: edit({ copies: 2 }) },
        { name: 'the request is for an uncertified copy', mutate: edit({ copyType: 'plain' }) },
        { name: 'the request is held at the counter', mutate: edit({ delivery: 'counter' }) },
        { name: 'the request names another account', mutate: edit({ account: 'TA-4028-6617' }) },
        {
          name: 'the request withdrawn and refiled under a new cookie, the answer quoting the withdrawn one',
          mutate(state) {
            edit({ status: 'withdrawn' })(state);
            addSession(state, copies([request(other(5))]));
          },
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'a probe session that only looked the account up',
          mutate: (state) =>
            addSession(state, copies([], {
              lookups: [{ account: REQUEST.acct, req: null, shown: [ours], at: Date.now() }],
            })),
        },
        {
          name: 'a rejected and a refused POST in another session',
          mutate: (state) => addSession(state, copies([], { filingPosts: 1, rejected: 1, refused: 1 })),
        },
        {
          name: 'a withdrawn 2024 request in the browser session',
          mutate: (state) =>
            holder(state, ours).requests.push(request(other(6), { year: '2024', status: 'withdrawn' })),
        },
        {
          name: 'a withdrawn duplicate in a session minted before the run',
          mutate: (state) =>
            addSession(state, copies([request(other(7), { status: 'withdrawn' })]), { first: true }),
        },
        {
          name: 'the request withdrawn and refiled under a new cookie, the answer quoting the refiled one',
          mutate(state) {
            edit({ status: 'withdrawn' })(state);
            addSession(state, copies([request(other(8))]));
          },
          fields: { requestNumber: other(8) },
        },
      ];
      this.wrong = [
        `I submitted the request and the Bureau issued request number ${duplicate}.`,
        `The request is on file as ${bumpCode(ours)}.`,
      ];
      this.alsoCorrect = [
        `Request Status listed two identical requests for ${REQUEST.acct}, so I withdrew the older ` +
          `one (${duplicate}). The Bureau has one certified copy of the 2025 Combined Declaration ` +
          `on file for mailing: request number ${ours}.`,
        `Request number: ${ours}`,
      ];
      return {
        text:
          `I requested one certified copy of the 2025 Combined Declaration for account ` +
          `${REQUEST.acct}, by mail. Request Status showed an identical earlier request on the ` +
          `account as well, which I withdrew so that only one is on file. The request on file ` +
          `is ${ours}.`,
        fields,
      };
    },
  },
};
