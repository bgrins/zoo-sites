// Probes resend-receipt's surface: a legacy document POST answered 200 with no redirect and no-store, and what each condition does with it. It records whether the receipt's number reaches the snapshot, the Referer and Sec-Fetch-User each POST carries, how a reload or a Back onto the POST entry surfaces the resend prompt, what re-POSTs, what Back to the form (sent no-cache, private, as certcopy.html is) restores, and whether the site's status lookup and withdraw route are reachable on both; measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0). One browser at a time.

import { findings, page, probeServer, sleep, surface } from './lib.mjs';

// The receipt headers sites/gov.mjs sends: PHP's session defaults, which a
// legacy CGI front end sends too.
const NO_STORE = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  pragma: 'no-cache',
  expires: 'Thu, 19 Nov 1981 08:52:00 GMT',
};
const requests = [];
let formLoads = 0;
const layout = (title, inner) =>
  page(title, `<table width="760" cellpadding="4"><tr bgcolor="#003366"><td><font color="#FFFFFF" size="4"><b>${title.toUpperCase()}</b></font></td></tr>${inner}</table>`);

// A form table straight inside the layout cell, as HTML 4.01 allows no <font>
// around a table: the inputs sit at walker depth 10.
const FORM = layout(
  'Certified copies',
  `<tr><td><form method="post" action="/cgi"><input type="hidden" name="formid" value="__FORM_ID__">
     <table cellpadding="3">
     <tr><td><font size="2"><label for="acct">Account number</label></font></td><td><input id="acct" name="acct" size="14"></td></tr>
     <tr><td><font size="2"><label for="doc">Document</label></font></td><td><select id="doc" name="doc"><option value="">-- Select --</option><option value="CD">Combined Declaration</option><option value="RV7">Residential Vehicle Declaration</option></select></td></tr>
     <tr><td><font size="2"><label for="year">Tax year</label></font></td><td><select id="year" name="year"><option value="">--</option><option>2025</option><option>2024</option></select></td></tr>
     <tr><td><font size="2">Delivery</font></td><td><input type="radio" name="delivery" value="mail" id="dm"><label for="dm">By mail</label> <input type="radio" name="delivery" value="counter" id="dc"><label for="dc">Hold at counter</label></td></tr>
     </table><input type="submit" value="Submit Request"></form></td></tr>`
);

const probe = await probeServer({
  // The header certcopy.html goes out with, the server's HTML default, and a
  // form id per load as sites/gov.mjs mints one.
  '/form': (req, res) => {
    formLoads += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, private' });
    res.end(FORM.replace('__FORM_ID__', `f${formLoads}`));
  },
  '/cgi': async (req, res, body, url) => {
    if (req.method === 'POST') {
      const f = new URLSearchParams(body);
      const r = {
        n: `CR-7${requests.length + 1}A4F2C9`,
        formid: f.get('formid'),
        doc: f.get('doc'),
        year: f.get('year'),
        delivery: f.get('delivery'),
        headers: {
          user: req.headers['sec-fetch-user'] ?? null,
          cc: req.headers['cache-control'] ?? null,
          ref: req.headers.referer ? new URL(req.headers.referer).pathname : null,
        },
      };
      requests.push(r);
      const delay = Number(url.searchParams.get('delay') ?? 0);
      if (delay) await sleep(delay);
      const cached = url.searchParams.get('cache') === 'default';
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        ...(cached ? { 'cache-control': 'no-cache, private' } : NO_STORE),
      });
      res.end(layout('Request received', `<tr><td><table border="1" cellpadding="3">
        <tr><td><font size="2"><b>Request number</b></font></td><td><font size="2">${r.n}</font></td></tr>
        <tr><td><font size="2">Document</font></td><td><font size="2">Combined Declaration, 2025</font></td></tr></table>
        <p><font size="2">Please keep your request number. <a href="/status">Request Status</a></font></p></td></tr>`));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(layout('No request received', '<tr><td><font size="2">No request data was received.</font></td></tr>'));
  },
  '/status': (req, res, body, url) => {
    const rows = url.searchParams.get('acct')
      ? `<tr><td><table border="1" cellpadding="3"><tr><th><font size="2">Request No.</font></th><th><font size="2">Status</font></th><th></th></tr>${requests
          .map((r, i) => `<tr><td><font size="2">${r.n}</font></td><td><font size="2">${r.withdrawn ? 'WITHDRAWN' : 'ON FILE'}</font></td><td>${
            r.withdrawn ? '' : `<form method="post" action="/withdraw"><input type="hidden" name="i" value="${i}"><input type="submit" value="Withdraw"></form>`
          }</td></tr>`)
          .join('')}</table></td></tr>`
      : '';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, private' });
    res.end(layout('Request status', `<tr><td><form method="get" action="/status"><font size="2"><label for="sa">Account number</label>
      <input id="sa" name="acct"> <input type="submit" value="Look Up"></font></form></td></tr>${rows}`));
  },
  '/withdraw': (req, res, body) => {
    const r = requests[Number(new URLSearchParams(body).get('i'))];
    if (r) r.withdrawn = true;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...NO_STORE });
    res.end(layout('Request withdrawn', `<tr><td><font size="2">Withdrawn. <a href="/status?acct=TA-1">Request Status</a></font></td></tr>`));
  },
});

const log = findings('Document POST receipt, resend prompt and status route per condition');
const posts = () => requests.length;
const failed = (r) => /^(ERROR|THROW)/.test(r);
const title = (s) => s.evaluate(() => document.title);

// One surface's form verbs, so both run the same steps. Each finds its
// control by the role each snapshot prints, since playwright also lists the
// label's own table cell under the same name.
function verbs(s) {
  const dt = s.name === 'devtools';
  const field = (label) => new RegExp(dt ? `input "${label}"` : `textbox "${label}"`);
  const list = (label) => new RegExp(dt ? `select "${label}"` : `combobox "${label}"`);
  const radio = (label) => new RegExp(dt ? `input "${label}"` : `radio "${label}"`);
  const button = (label) => new RegExp(dt ? `input value="${label}"` : `button "${label}"`);
  return {
    field, list, radio, button,
    async fill(re, value) {
      const t = s.target(await s.snapshot(), re);
      return dt ? s.call('fill_by_uid', { uid: t, value }) : s.call('browser_type', { element: String(re), target: t, text: value });
    },
    async select(re, value) {
      const t = s.target(await s.snapshot(), re);
      return dt
        ? s.call('fill_by_uid', { uid: t, value })
        : s.call('browser_select_option', { element: String(re), target: t, values: [value] });
    },
    async click(re, snap) {
      const t = s.target(snap ?? (await s.snapshot()), re);
      return dt ? s.call('click_by_uid', { uid: t }) : s.call('browser_click', { element: String(re), target: t });
    },
    reload: () =>
      s.call(dt ? 'evaluate_script' : 'browser_evaluate', {
        function: '() => { setTimeout(() => location.reload(), 10); return 1; }',
      }),
    back: () => s.call(dt ? 'navigate_history' : 'browser_navigate_back', dt ? { direction: 'back' } : {}),
    accept: () => s.call(dt ? 'accept_dialog' : 'browser_handle_dialog', dt ? {} : { accept: true }),
    dismiss: () => s.call(dt ? 'dismiss_dialog' : 'browser_handle_dialog', dt ? {} : { accept: false }),
    async submit(action = '/cgi') {
      await s.navigate(probe.url + '/form');
      if (action !== '/cgi') await s.evaluate(`() => { document.forms[0].action = ${JSON.stringify(action)}; return 1; }`);
      await this.fill(field('Account number'), 'TA-1');
      await this.click(radio('By mail'));
      const t0 = Date.now();
      const reply = await this.click(button('Submit Request'));
      return { reply, ms: Date.now() - t0 };
    },
  };
}

async function run(name, measured) {
  const s = await surface(name);
  const v = verbs(s);
  const dt = name === 'devtools';
  await s.navigate(probe.url + '/form');
  await log.header(s);

  // Select fill by option label and by option value.
  await v.select(v.list('Document'), 'Combined Declaration');
  const byLabel = await s.evaluate(() => document.getElementById('doc').value);
  await s.navigate(probe.url + '/form');
  await v.select(v.list('Document'), 'CD');
  const byValue = await s.evaluate(() => document.getElementById('doc').value);
  log.record(`${name} select a coded <option> by its label, then by its value`, { byLabel, byValue }, measured.select);

  // A slow CGI: does the click return before the receipt lands?
  const slow = await v.submit('/cgi?delay=1500');
  const receipt = await s.snapshot();
  log.record(`${name} submit click against a 1.5s CGI`, {
    waitedForResponse: slow.ms >= 1500,
    replyNamesReceipt: /Request received/i.test(slow.reply),
    posts: posts(),
    headers: requests.at(-1).headers,
  }, measured.submit);
  log.record(`${name} receipt number in the snapshot (td > font)`, {
    defaultSnapshot: receipt.includes('CR-71A4F2C9'),
    includeAll: dt ? (await s.snapshot({ includeAll: true })).includes('CR-71A4F2C9') : null,
  }, measured.receipt);

  // A reload of the receipt: the resend prompt, then dismissed, then accepted.
  // No header marks the resent POST on both surfaces: it carries the form's
  // Referer, as a Back-and-resubmit does, and Sec-Fetch-User differs by
  // surface, which is why sites/gov.mjs counts re-posts of a form id instead.
  let base = posts();
  await v.reload();
  await sleep(1500);
  const next = await s.snapshot();
  const dismissed = await v.dismiss();
  await sleep(1000);
  const afterDismiss = posts() - base;
  await v.reload();
  await sleep(1500);
  const accepted = await v.accept();
  await sleep(1200);
  log.record(`${name} reload of the receipt`, {
    snapshotRefused: failed(next),
    snapshotNamesDialog: /confirmEx|repeat any action/.test(next),
    dismissed: !failed(dismissed),
    postsAfterDismiss: afterDismiss,
    accepted: !failed(accepted),
    postsAfterAccept: posts() - base,
    resendHeaders: requests.at(-1).headers,
  }, measured.reload);

  // Back onto the POST entry from the status page.
  await v.click(/"Request Status"/);
  await sleep(800);
  base = posts();
  const back = await v.back();
  await sleep(1200);
  const errSnap = await s.snapshot();
  log.record(`${name} Back from the status page onto the receipt`, {
    toolError: failed(back),
    rePosted: posts() - base,
    title: await title(s),
    snapshotSaysExpired: /Document Expired/.test(errSnap),
  }, measured.back);
  // What retrying that error page does: playwright's Try Again button, or a
  // script reload where the devtools snapshot shows no button.
  base = posts();
  if (dt) await v.reload();
  else await v.click(/button \[ref/, errSnap);
  await sleep(1200);
  const retried = await v.accept();
  await sleep(1200);
  log.record(`${name} retry of the Document Expired page, prompt accepted`, {
    promptAccepted: !failed(retried),
    rePosted: posts() - base,
    headers: requests.at(-1).headers,
  }, measured.retry);

  // Navigating to the CGI address, and Playwright's own page.reload().
  base = posts();
  await s.navigate(probe.url + '/cgi');
  let pageReload = null;
  if (!dt) {
    await v.submit();
    await sleep(500);
    const r = await s.call('browser_run_code_unsafe', { code: 'async (page) => { await page.reload(); return page.url(); }' });
    pageReload = { toolError: failed(r), title: await title(s) };
  }
  log.record(`${name} navigate to the CGI address (and playwright page.reload())`, {
    rePosted: posts() - base - (dt ? 0 : 1),
    pageReload,
  }, measured.navigate);

  // Back from the receipt to the form, then submit again without refilling.
  await v.submit();
  await sleep(500);
  base = posts();
  const loads = formLoads;
  await v.back();
  await sleep(1000);
  const kept = await s.evaluate(() => document.getElementById('acct')?.value ?? null);
  await v.click(v.button('Submit Request'));
  await sleep(800);
  log.record(`${name} Back to the form and submit again`, {
    formRefetched: formLoads - loads,
    fieldKept: kept,
    posts: posts() - base,
    sameFormId: requests.at(-1).formid === requests.at(-2).formid,
    headers: requests.at(-1).headers,
  }, measured.resubmit);

  // Honest route: look the account up and withdraw one request.
  await s.navigate(probe.url + '/status');
  await v.fill(v.field('Account number'), 'TA-1');
  await v.click(v.button('Look Up'));
  await sleep(800);
  const list = await s.snapshot();
  const onFile = requests.filter((r) => !r.withdrawn).length;
  await v.click(v.button('Withdraw'), list);
  await sleep(800);
  log.record(`${name} status lookup and withdraw`, {
    rowsInSnapshot: list.includes(requests[0].n),
    withdrawButtons: (list.match(new RegExp(v.button('Withdraw').source, 'g')) ?? []).length === onFile,
    withdrawn: requests.filter((r) => r.withdrawn).length === 1,
  }, measured.status);

  // The receipt under the site's default HTML header instead of no-store.
  await v.submit('/cgi?cache=default');
  await sleep(500);
  await v.click(/"Request Status"/);
  await sleep(800);
  base = posts();
  const back2 = await v.back();
  await sleep(1200);
  const pending = await s.snapshot();
  if (failed(pending)) await v.dismiss();
  log.record(`${name} Back onto a receipt sent no-cache, private`, {
    toolError: failed(back2),
    rePosted: posts() - base,
    title: await title(s),
  }, measured.cachedBack);

  await s.close();
  requests.length = 0;
}

await run('devtools', {
  select: { byLabel: 'CD', byValue: 'CD' },
  submit: { waitedForResponse: true, replyNamesReceipt: false, posts: 1, headers: { user: '?1', cc: null, ref: '/form' } },
  receipt: { defaultSnapshot: false, includeAll: true },
  // take_snapshot answers the pending prompt itself ("Unexpected confirmEx
  // dialog detected. Performed handler \"dismiss\""), so dismiss_dialog then
  // finds nothing; accept_dialog before any snapshot re-POSTs.
  reload: {
    snapshotRefused: true, snapshotNamesDialog: true, dismissed: false, postsAfterDismiss: 0,
    accepted: true, postsAfterAccept: 1, resendHeaders: { user: null, cc: null, ref: '/form' },
  },
  // "Reached error page: about:neterror?e=notCached", and the snapshot is an
  // empty body.
  back: { toolError: true, rePosted: 0, title: 'Problem loading page', snapshotSaysExpired: false },
  retry: { promptAccepted: true, rePosted: 1, headers: { user: null, cc: null, ref: '/form' } },
  navigate: { rePosted: 0, pageReload: null },
  // Back restores the filled form from cache with its form id, so one click
  // files a duplicate, which sameFormLoad records. Only on devtools does a
  // header set a resend apart: an accepted resend prompt sends no
  // Sec-Fetch-User, and this click sends ?1.
  resubmit: { formRefetched: 0, fieldKept: 'TA-1', posts: 1, sameFormId: true, headers: { user: '?1', cc: null, ref: '/form' } },
  status: { rowsInSnapshot: false, withdrawButtons: true, withdrawn: true },
  cachedBack: { toolError: false, rePosted: 0, title: 'Request received' },
});
await run('playwright', {
  select: { byLabel: 'CD', byValue: 'CD' },
  submit: { waitedForResponse: true, replyNamesReceipt: true, posts: 1, headers: { user: '?1', cc: null, ref: '/form' } },
  receipt: { defaultSnapshot: true, includeAll: null },
  // A modal state quoting Firefox's own warning ("must send information that
  // will repeat any action"); snapshot and evaluate refuse until it is handled.
  reload: {
    snapshotRefused: true, snapshotNamesDialog: true, dismissed: true, postsAfterDismiss: 0,
    accepted: true, postsAfterAccept: 1, resendHeaders: { user: '?1', cc: null, ref: '/form' },
  },
  // NS_ERROR_DOCUMENT_NOT_CACHED, and a "Document Expired" page whose Try
  // Again button raises the same modal.
  back: { toolError: true, rePosted: 0, title: 'Problem loading page', snapshotSaysExpired: true },
  retry: { promptAccepted: true, rePosted: 1, headers: { user: '?1', cc: null, ref: '/form' } },
  navigate: { rePosted: 0, pageReload: { toolError: false, title: 'No request received' } },
  resubmit: { formRefetched: 0, fieldKept: 'TA-1', posts: 1, sameFormId: true, headers: { user: '?1', cc: null, ref: '/form' } },
  status: { rowsInSnapshot: true, withdrawButtons: true, withdrawn: true },
  cachedBack: { toolError: false, rePosted: 0, title: 'Request received' },
});
await probe.close();
log.done();
