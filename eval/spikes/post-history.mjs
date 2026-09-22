// Probes a document form POST with no redirect: what a reload and history traversal onto the POST entry do through each condition (resend prompt, re-POST, error); measured on firefox-devtools-mcp 0.9.15 and 0.10.3 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).

import { findings, page, probeServer, sleep, surface } from './lib.mjs';

const probe = await probeServer({
  '/form': page(
    'Certified copy',
    `<form method="post" action="/submit"><label for="n">Account</label> <input id="n" name="n">
     <button>Send request</button></form>`
  ),
  '/submit': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page('Receipt', '<h1>Request received</h1><a href="/status">Check status</a>'));
  },
  '/status': page('Status', '<h1>Status</h1>'),
});
const log = findings('Document POST history per condition');
const posts = () => probe.requests.filter((r) => r.method === 'POST' && r.path === '/submit').length;
const where = (s) => s.evaluate(() => location.pathname);
const failed = (r) => /^(ERROR|THROW)/.test(r);

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/form');
await pw.navigate(probe.url + '/form');
await log.header(dt, pw);

{
  await dt.navigate(probe.url + '/form');
  let snap = await dt.snapshot();
  await dt.call('fill_by_uid', { uid: dt.target(snap, /"Account"/), value: 'TA-1' });
  snap = await dt.snapshot();
  await dt.call('click_by_uid', { uid: dt.target(snap, /button "Send request"/) });
  await sleep(1000);
  const base = posts();
  await dt.evaluate(() => {
    setTimeout(() => location.reload(), 10);
    return 1;
  });
  await sleep(1500);
  const beforeAccept = posts() - base;
  const accept = await dt.call('accept_dialog', {});
  await sleep(1000);
  log.record('devtools reload of a POST result (no reload tool; via script)', {
    postsBeforeAccept: beforeAccept,
    promptAccepted: !failed(accept),
    postsAfterAccept: posts() - base,
  }, { postsBeforeAccept: 0, promptAccepted: true, postsAfterAccept: 1 });

  snap = await dt.snapshot();
  await dt.call('click_by_uid', { uid: dt.target(snap, /"Check status"/) });
  await sleep(1000);
  const before = posts();
  const back = await dt.call('navigate_history', { direction: 'back' });
  await sleep(1500);
  log.record('devtools navigate_history back onto the POST entry', {
    toolError: failed(back),
    rePosted: posts() - before,
  }, { toolError: true, rePosted: 0 });

  const before2 = posts();
  await dt.call('navigate_page', { url: probe.url + '/submit' });
  await sleep(800);
  log.record('devtools navigate_page to the receipt URL', {
    rePosted: posts() - before2,
    gets: probe.requests.filter((r) => r.method === 'GET' && r.path === '/submit').length,
  }, { rePosted: 0, gets: 1 });
}

{
  await pw.navigate(probe.url + '/form');
  let snap = await pw.snapshot();
  await pw.call('browser_type', { element: 'Account', target: pw.target(snap, /"Account"/), text: 'TA-1' });
  snap = await pw.snapshot();
  await pw.call('browser_click', { element: 'Send request', target: pw.target(snap, /button "Send request"/) });
  await sleep(1000);
  const base = posts();
  await pw.call('browser_evaluate', { function: '() => { setTimeout(() => location.reload(), 10); return 1; }' });
  await sleep(1000);
  const next = await pw.call('browser_snapshot', {});
  const modal = /Modal state/i.test(next);
  const handled = await pw.call('browser_handle_dialog', { accept: true });
  await sleep(1200);
  log.record('playwright reload of a POST result', {
    modalState: modal,
    promptAccepted: !failed(handled),
    postsAfterAccept: posts() - base,
  }, { modalState: true, promptAccepted: true, postsAfterAccept: 1 });

  snap = await pw.snapshot();
  await pw.call('browser_click', { element: 'Check status', target: pw.target(snap, /"Check status"/) });
  await sleep(800);
  const before = posts();
  const back = await pw.call('browser_navigate_back', {});
  await sleep(1200);
  log.record('playwright browser_navigate_back onto the POST entry', {
    toolError: failed(back),
    modalState: /Modal state/i.test(back),
    rePosted: posts() - before,
    at: await where(pw),
  }, { toolError: true, modalState: false, rePosted: 0, at: '/submit' });
}

await dt.close();
await pw.close();
await probe.close();
log.done();
