// Probes a beforeunload guard on a dirty form: whether each condition's navigate and click tools show it, bypass it, or block on it; measured on firefox-devtools-mcp 0.9.15 and 0.10.3 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).

import { findings, page, probeServer, sleep, surface } from './lib.mjs';

const probe = await probeServer({
  '/settings': page(
    'Usage alerts',
    `<h1>Usage alerts</h1><label for="t">Alert at</label> <input id="t">
     <a href="/roaming" id="away">Roaming</a>
     <script>
       let dirty = false;
       document.getElementById('t').addEventListener('input', () => { dirty = true; });
       addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
     </script>`
  ),
  '/roaming': page('Roaming', '<h1>Roaming</h1>'),
});
const log = findings('beforeunload on a dirty form per condition');
const where = (s) => s.evaluate(() => location.pathname);

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/settings');
await pw.navigate(probe.url + '/settings');
await log.header(dt, pw);

const dirty = async (s) => {
  await s.navigate(probe.url + '/settings');
  const snap = await s.snapshot();
  const target = s.target(snap, /"Alert at"/);
  if (s.name === 'devtools') await s.call('fill_by_uid', { uid: target, value: '80' });
  else await s.call('browser_type', { element: 'Alert at', target, text: '80' });
  return s.snapshot();
};

{
  await dirty(dt);
  const nav = await dt.call('navigate_page', { url: probe.url + '/roaming' });
  await sleep(1000);
  log.record('devtools navigate_page away from a dirty form', { toolError: /^(ERROR|THROW)/.test(nav), at: await where(dt) }, {
    toolError: false, at: '/roaming',
  });
  const snap = await dirty(dt);
  await dt.call('click_by_uid', { uid: dt.target(snap, /"Roaming"/) });
  await sleep(1000);
  const accept = await dt.call('accept_dialog', {});
  log.record('devtools click a link away from a dirty form', { at: await where(dt), dialogPending: !/^(ERROR|THROW)/.test(accept) }, {
    at: '/roaming', dialogPending: false,
  });
}

{
  await dirty(pw);
  const nav = await pw.call('browser_navigate', { url: probe.url + '/roaming' });
  await sleep(800);
  log.record('playwright browser_navigate away from a dirty form', { toolError: /^(ERROR|THROW)/.test(nav), at: await where(pw) }, {
    toolError: false, at: '/roaming',
  });
  const snap = await dirty(pw);
  const click = await pw.call('browser_click', { element: 'Roaming', target: pw.target(snap, /"Roaming"/) });
  const modal = /Modal state[\s\S]*?(beforeunload|leave)/i.test(click);
  const blocked = await pw.call('browser_snapshot', {});
  log.record('playwright browser_click a link away from a dirty form', {
    modalState: modal,
    otherToolsRefused: /does not handle the modal state|modal state/i.test(blocked),
  }, { modalState: true, otherToolsRefused: true });
  await pw.call('browser_handle_dialog', { accept: true });
  await sleep(800);
  log.record('playwright after browser_handle_dialog accept', await where(pw), '/roaming');
}

await dt.close();
await pw.close();
await probe.close();
log.done();
