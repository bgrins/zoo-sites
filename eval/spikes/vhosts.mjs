// Probes host-routed serving on one port: whether each condition's browser reaches <name>.localhost, keeps cookies per host, and treats the page as a secure context; measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).
//
// The probe server listens on 127.0.0.1 only, as server.mjs does, and routes
// on the Host header. Node itself resolves *.localhost to ::1 before
// 127.0.0.1 (node 25), so a harness helper should connect to 127.0.0.1 and
// send the Host header rather than depend on address fallback.

import { findings, page, probeServer, sleep, surface } from './lib.mjs';

const probe = await probeServer({
  '/set': (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': `sid=${req.headers.host.split('.')[0]}; Path=/; HttpOnly; SameSite=Lax`,
    });
    res.end(page('Set', '<p>set</p>'));
  },
  '/read': page('Read', '<p>read</p>'),
});
const log = findings('Host-routed *.localhost per condition');

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/read');
await pw.navigate(probe.url + '/read');
await log.header(dt, pw);

const at = (name, path) => `http://${name}.localhost:${probe.port}${path}`;
for (const s of [dt, pw]) {
  probe.requests.length = 0;
  await s.navigate(at('alpha', '/set'));
  await s.navigate(at('beta', '/set'));
  await s.navigate(at('alpha', '/read'));
  const secure = await s.evaluate(() => window.isSecureContext);
  await s.navigate(at('beta', '/read'));
  await sleep(300);
  const reads = probe.requests.filter((r) => r.path === '/read');
  log.record(`${s.name} alpha.localhost and beta.localhost on one port`, {
    reached: reads.map((r) => r.headers.host.split(':')[0]),
    cookies: reads.map((r) => r.headers.cookie ?? null),
    secureContext: secure,
  }, { reached: ['alpha.localhost', 'beta.localhost'], cookies: ['sid=alpha', 'sid=beta'], secureContext: true });
}

await dt.close();
await pw.close();
await probe.close();
log.done();
