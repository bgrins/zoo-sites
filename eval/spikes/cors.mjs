// Probes a CORS-blocked fetch: what each condition's console and network tools report for a preflight whose Allow-Origin names another origin, and whether the server ever sees the GET; measured on firefox-devtools-mcp 0.9.15 and 0.10.3 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).

import { findings, page, probeServer, sleep, surface } from './lib.mjs';

const probe = await probeServer({
  // The storefront on 127.0.0.1 calls the API on localhost, which still
  // allows only the storefront's old origin.
  '/product': (req, res) => {
    const port = req.socket.localPort;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      page(
        'Product',
        `<p id="s">Checking stock...</p>
         <script>
           fetch('http://localhost:${port}/stock?sku=1', { headers: { 'X-Session-Nonce': 'n' } })
             .then((r) => r.json())
             .then((j) => { document.getElementById('s').textContent = 'In stock: ' + j.stock; })
             .catch((e) => { document.getElementById('s').textContent = 'Stock unavailable'; console.warn('stock lookup failed', e.message); });
         </script>`
      )
    );
  },
  '/stock': (req, res) => {
    const cors = { 'access-control-allow-origin': 'http://old-store.example', 'x-edge-trace': 'ET-9A1C' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'access-control-allow-headers': 'x-session-nonce' });
      res.end();
      return;
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end('{"stock":4}');
  },
});
const log = findings('CORS failure per condition');

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/product');
await pw.navigate(probe.url + '/product');
await log.header(dt, pw);

for (const s of [dt, pw]) {
  probe.requests.length = 0;
  await s.navigate(probe.url + '/product');
  await sleep(1500);
  const devtools = s.name === 'devtools';
  const consoleText = await s.call(devtools ? 'list_console_messages' : 'browser_console_messages', {});
  const net = await s.call(devtools ? 'list_network_requests' : 'browser_network_requests', {});
  log.record(`${s.name} console and network after a blocked fetch`, {
    page: await s.evaluate(() => document.getElementById('s').textContent),
    consoleNamesCors: /CORS|Cross-Origin/i.test(consoleText),
    consoleNamesAllowedOrigin: /old-store\.example/.test(consoleText),
    networkListsPreflight: /OPTIONS/.test(net),
    serverSaw: probe.requests.filter((r) => r.path.startsWith('/stock')).map((r) => r.method),
  }, devtools
    ? { page: 'Stock unavailable', consoleNamesCors: true, consoleNamesAllowedOrigin: true, networkListsPreflight: true, serverSaw: ['OPTIONS'] }
    : { page: 'Stock unavailable', consoleNamesCors: true, consoleNamesAllowedOrigin: true, networkListsPreflight: false, serverSaw: ['OPTIONS'] });
}

await dt.close();
await pw.close();
await probe.close();
log.done();
