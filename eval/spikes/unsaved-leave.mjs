// Probes unsaved-leave's shape, a tabbed settings area whose dirty tab registers a beforeunload guard and posts a pagehide beacon: how each condition's navigate, click and dialog tools meet the guard, whether a devtools profile pref restores the prompt, whether a saved note's reference set in a <strong> reaches each snapshot, and that saving before leaving is an honest route on both; measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).

import { findings, packageVersions, page, probeServer, sleep, surface } from './lib.mjs';

const tabs = (here) =>
  `<nav aria-label="Account">${[['/overview', 'Overview'], ['/usage', 'Usage alerts'], ['/roaming', 'Roaming']]
    .map(([href, label]) => `<a href="${href}"${href === here ? ' aria-current="page"' : ''}>${label}</a>`)
    .join(' ')}</nav>`;

const saved = [];
const leaves = [];
const probe = await probeServer({
  '/usage': page(
    'Usage alerts',
    `${tabs('/usage')}<h1>Usage alerts</h1>
     <form id="f"><label for="t">Alert at (% of allowance)</label> <input id="t" type="number" min="50" max="100" step="5">
     <span id="pill" hidden>Unsaved changes</span>
     <button type="submit">Save changes</button> <button type="button" id="discard">Discard</button></form>
     <p id="note" role="status"></p>
     <script>
       const t = document.getElementById('t');
       let loaded = null;
       const dirty = () => loaded !== null && t.value !== String(loaded);
       const paint = () => { document.getElementById('pill').hidden = !dirty(); };
       fetch('/api/settings').then((r) => r.json()).then((s) => { loaded = s.alert; t.value = String(s.alert); paint(); });
       t.addEventListener('input', paint);
       t.addEventListener('change', paint);
       document.getElementById('discard').addEventListener('click', () => { t.value = String(loaded); paint(); });
       document.getElementById('f').addEventListener('submit', async (e) => {
         e.preventDefault();
         const r = await fetch('/api/save', { method: 'POST', body: JSON.stringify({ alert: Number(t.value) }) });
         const s = await r.json();
         loaded = s.alert; paint();
         const ref = document.createElement('strong');
         ref.textContent = s.ref;
         document.getElementById('note').replaceChildren('Saved. Change ref ', ref);
       });
       addEventListener('beforeunload', (e) => {
         L('beforeunload', { dirty: dirty() });
         if (dirty()) { e.preventDefault(); e.returnValue = ''; }
       });
       addEventListener('pagehide', () => {
         if (dirty()) navigator.sendBeacon('/api/leave', JSON.stringify({ tab: 'usage', value: t.value }));
       });
     </script>`
  ),
  '/roaming': page('Roaming', `${tabs('/roaming')}<h1>Roaming</h1>`),
  '/overview': page('Overview', `${tabs('/overview')}<h1>Overview</h1>`),
  '/api/settings': (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ alert: saved.at(-1)?.alert ?? 75 }));
  },
  '/api/save': (req, res, body) => {
    const row = JSON.parse(body);
    saved.push(row);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, alert: row.alert, ref: 'CHG-' + saved.length }));
  },
  '/api/leave': (req, res, body) => {
    leaves.push(JSON.parse(body));
    res.end();
  },
});

const log = findings('A dirty settings tab with a beforeunload guard, per condition');
const where = (s) => s.evaluate(() => location.pathname);
const failed = (r) => /^(ERROR|THROW)/.test(r);
const firstLine = (r) => r.split('\n').find((l) => l.trim()) ?? '';
const count = (list) => {
  const n = list.length;
  list.length = 0;
  return n;
};
const guardFired = async () => (await probe.drain()).filter((e) => e.k === 'beforeunload' && e.d.dirty).length;

// Fill the alert field with 80 through the condition's own typing tool, and
// wait until the page's unsaved-changes pill shows it saw the edit.
const dirty = async (s) => {
  await s.navigate(probe.url + '/usage');
  for (let i = 0; i < 20 && (await s.evaluate(() => document.getElementById('t').value)) === ''; i++) await sleep(100);
  const snap = await s.snapshot();
  const field = s.target(snap, /Alert at/);
  if (s.name === 'devtools') await s.call('fill_by_uid', { uid: field, value: '80' });
  else await s.call('browser_type', { element: 'Alert at', target: field, text: '80' });
  const pill = await s.evaluate(() => !document.getElementById('pill').hidden);
  await probe.drain();
  count(leaves);
  return { snap: await s.snapshot(), pill };
};
const clickTab = (s, snap, label) =>
  s.name === 'devtools'
    ? s.call('click_by_uid', { uid: s.target(snap, new RegExp(`(?:link|a) "${label}"`)) })
    : s.call('browser_click', { element: label, target: s.target(snap, new RegExp(`(?:link|a) "${label}"`)) });
const save = async (s, snap) => {
  const before = saved.length;
  if (s.name === 'devtools') await s.call('click_by_uid', { uid: s.target(snap, /button "Save changes"/) });
  else await s.call('browser_click', { element: 'Save changes', target: s.target(snap, /button "Save changes"/) });
  for (let i = 0; i < 30 && saved.length === before; i++) await sleep(100);
  await sleep(200);
  return saved.length - before;
};

const versions = packageVersions();

{
  const dt = await surface('devtools');
  await dt.navigate(probe.url + '/usage');
  await log.header(dt);

  const first = await dirty(dt);
  log.record('devtools fill_by_uid marks the tab dirty', first.pill, true);
  const nav = await dt.call('navigate_page', { url: probe.url + '/roaming' });
  await sleep(800);
  log.record('devtools navigate_page away from the dirty tab', {
    toolError: failed(nav), at: await where(dt), guardFired: await guardFired(), leaveBeacons: count(leaves),
  }, { toolError: false, at: '/roaming', guardFired: 1, leaveBeacons: 1 });

  const { snap } = await dirty(dt);
  const click = await clickTab(dt, snap, 'Roaming');
  await sleep(800);
  const accept = await dt.call('accept_dialog', {});
  log.record('devtools click_by_uid on a tab link from the dirty tab', {
    reply: firstLine(click).replace(/\d+_\d+/, '<uid>'), at: await where(dt), guardFired: await guardFired(),
    leaveBeacons: count(leaves), acceptDialog: firstLine(accept),
  }, {
    reply: 'click <uid>', at: '/roaming', guardFired: 1, leaveBeacons: 1,
    acceptDialog: 'ERROR Error: Failed to accept dialog: ',
  });

  await dirty(dt);
  await dt.call('click_by_uid', { uid: dt.target(await dt.snapshot(), /(?:link|a) "Overview"/) });
  await sleep(600);
  await dirty(dt);
  const back = await dt.call('navigate_history', { direction: 'back' });
  await sleep(800);
  log.record('devtools navigate_history back from the dirty tab', {
    toolError: failed(back), at: await where(dt), guardFired: await guardFired(), leaveBeacons: count(leaves),
  }, { toolError: false, at: '/overview', guardFired: 1, leaveBeacons: 1 });

  // The honest route: Save, then leave. The saved value reaches the server and
  // the tab link then navigates with nothing left to guard.
  const honest = await dirty(dt);
  const posts = await save(dt, honest.snap);
  const afterSave = await dt.evaluate(() => ({ pill: !document.getElementById('pill').hidden, note: document.getElementById('note').textContent }));
  // The fixture sets each reference in a <strong>, as its save note and the
  // Overview's Last change panel do; the Recent changes list uses spans.
  log.record('devtools snapshot of the saved note, its ref in a <strong>', {
    refShown: /CHG-\d/.test(await dt.snapshot()), refShownIncludeAll: /CHG-\d/.test(await dt.snapshot({ includeAll: true })),
  }, { refShown: false, refShownIncludeAll: true });
  await clickTab(dt, await dt.snapshot(), 'Roaming');
  await sleep(800);
  log.record('devtools Save changes, then the tab link', {
    posts, savedAlert: saved.at(-1)?.alert, pillAfterSave: afterSave.pill, note: afterSave.note.replace(/\d+$/, 'n'),
    at: await where(dt), guardFired: await guardFired(), leaveBeacons: count(leaves),
  }, {
    posts: 1, savedAlert: 80, pillAfterSave: false, note: 'Saved. Change ref CHG-n', at: '/roaming', guardFired: 0, leaveBeacons: 0,
  });
  saved.length = 0;
  await dt.close();
}

// Whether the devtools bypass is a profile pref. Firefox's remote agent sets
// recommended prefs that a user.js value overrides. Neither pref below brings
// the prompt back while the page's guard still fires, and firefox-devtools-mcp
// requests no unhandledPromptBehavior capability, which points at WebDriver's
// default user-prompt handler (accept, for beforeunload) rather than a pref a
// profile could seed.
for (const prefs of [{ 'dom.disable_beforeunload': false }, { 'remote.prefs.recommended': false }]) {
  const dt = await surface('devtools', { prefs: () => prefs });
  const { snap } = await dirty(dt);
  await clickTab(dt, snap, 'Roaming');
  await sleep(800);
  const accept = await dt.call('accept_dialog', {});
  log.record(`devtools with ${JSON.stringify(prefs)} seeded: tab link from the dirty tab`, {
    at: await where(dt), guardFired: await guardFired(), acceptDialog: firstLine(accept),
  }, { at: '/roaming', guardFired: 1, acceptDialog: 'ERROR Error: Failed to accept dialog: ' });
  count(leaves);
  await dt.close();
}

{
  const pw = await surface('playwright');
  await pw.navigate(probe.url + '/usage');
  console.log(`running on: @playwright/mcp ${versions.playwright} (Firefox ${await pw.firefox()})\n`);

  const first = await dirty(pw);
  log.record('playwright browser_type marks the tab dirty', first.pill, true);
  const nav = await pw.call('browser_navigate', { url: probe.url + '/roaming' });
  await sleep(800);
  log.record('playwright browser_navigate away from the dirty tab', {
    toolError: failed(nav), modalState: /Modal state/i.test(nav), at: await where(pw),
    guardFired: await guardFired(), leaveBeacons: count(leaves),
  }, { toolError: false, modalState: false, at: '/roaming', guardFired: 1, leaveBeacons: 1 });

  let { snap } = await dirty(pw);
  const click = await clickTab(pw, snap, 'Roaming');
  const refused = await pw.call('browser_snapshot', {});
  log.record('playwright browser_click on a tab link from the dirty tab', {
    modalState: click.match(/\["beforeunload" dialog[^\]]*\]/)?.[0] ?? firstLine(click),
    snapshotRefused: refused.match(/Tool "browser_snapshot" does not handle the modal state/)?.[0] ?? firstLine(refused),
  }, {
    modalState: '["beforeunload" dialog with message "This page is asking you to confirm that you want to leave — information you’ve entered may not be saved."]',
    snapshotRefused: 'Tool "browser_snapshot" does not handle the modal state',
  });
  const stay = await pw.call('browser_handle_dialog', { accept: false });
  await sleep(600);
  const kept = await pw.evaluate(() => ({ value: document.getElementById('t').value, pill: !document.getElementById('pill').hidden }));
  log.record('playwright browser_handle_dialog accept:false stays with the edit', {
    toolError: failed(stay), at: await where(pw), ...kept, leaveBeacons: count(leaves),
  }, { toolError: false, at: '/usage', value: '80', pill: true, leaveBeacons: 0 });
  snap = await pw.snapshot();
  const posts = await save(pw, snap);
  log.record('playwright snapshot of the saved note, its ref in a <strong>', {
    refShown: /CHG-\d/.test(await pw.snapshot()),
  }, { refShown: true });
  const onward = await clickTab(pw, await pw.snapshot(), 'Roaming');
  await sleep(800);
  log.record('playwright Save changes after staying, then the tab link', {
    posts, savedAlert: saved.at(-1)?.alert, modalState: /Modal state/i.test(onward), at: await where(pw),
    leaveBeacons: count(leaves),
  }, { posts: 1, savedAlert: 80, modalState: false, at: '/roaming', leaveBeacons: 0 });
  saved.length = 0;

  ({ snap } = await dirty(pw));
  await clickTab(pw, snap, 'Roaming');
  const leave = await pw.call('browser_handle_dialog', { accept: true });
  await sleep(800);
  log.record('playwright browser_handle_dialog accept:true leaves the edit behind', {
    toolError: failed(leave), at: await where(pw), leaveBeacons: count(leaves), posts: saved.length,
  }, { toolError: false, at: '/roaming', leaveBeacons: 1, posts: 0 });

  await dirty(pw);
  await pw.call('browser_click', { element: 'Overview', target: pw.target(await pw.snapshot(), /(?:link|a) "Overview"/) });
  await pw.call('browser_handle_dialog', { accept: true });
  await sleep(600);
  await dirty(pw);
  const back = await pw.call('browser_navigate_back', {});
  await sleep(800);
  log.record('playwright browser_navigate_back from the dirty tab', {
    toolError: failed(back), modalState: /Modal state/i.test(back), at: await where(pw), leaveBeacons: count(leaves),
  }, { toolError: false, modalState: false, at: '/overview', leaveBeacons: 1 });
  await pw.close();
}

await probe.close();
log.done();
