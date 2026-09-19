// Probes the browser HTTP cache: which of each condition's navigate, link-click and reload routes reuse a max-age=300 response or revalidate an ETag, as the server sees it; measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).

import { findings, page, probeServer, sleep, surface } from './lib.mjs';

const probe = await probeServer({
  '/home': page('Tracking', '<a href="/fresh">Tracking (cached)</a> <a href="/tagged">Tracking (tagged)</a>'),
  '/fresh': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, max-age=300' });
    res.end(page('Fresh', `<p id="slot">Slot served ${Date.now()}</p>`));
  },
  '/tagged': (req, res) => {
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304, { etag: '"v1"', 'cache-control': 'no-cache' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"v1"', 'cache-control': 'no-cache' });
    res.end(page('Tagged', '<p>Tagged</p>'));
  },
});
const log = findings('HTTP cache per condition');
const hits = (path) => probe.requests.filter((r) => r.path === path);

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/home');
await pw.navigate(probe.url + '/home');
await log.header(dt, pw);

for (const s of [dt, pw]) {
  const click = async (re) => {
    await s.navigate(probe.url + '/home');
    const snap = await s.snapshot();
    const target = s.target(snap, re);
    if (s.name === 'devtools') await s.call('click_by_uid', { uid: target });
    else await s.call('browser_click', { element: String(re), target });
    await sleep(600);
  };
  probe.requests.length = 0;
  await s.navigate(probe.url + '/fresh');
  await s.navigate(probe.url + '/fresh');
  const afterNavigate = hits('/fresh').length;
  await click(/"Tracking \(cached\)"/);
  const afterClick = hits('/fresh').length;
  await s.evaluate(() => {
    setTimeout(() => location.reload(), 10);
    return 1;
  });
  await sleep(800);
  log.record(`${s.name} max-age=300 page: server hits after navigate x2, link click, script reload`, {
    navigate: afterNavigate,
    click: afterClick - afterNavigate,
    reload: hits('/fresh').length - afterClick,
  }, { navigate: 1, click: 0, reload: 1 });

  probe.requests.length = 0;
  await s.navigate(probe.url + '/tagged');
  await s.navigate(probe.url + '/tagged');
  log.record(`${s.name} ETag page navigated twice`, hits('/tagged').map((r) => r.headers['if-none-match'] ?? null), [null, '"v1"']);
}

await dt.close();
await pw.close();
await probe.close();
log.done();
