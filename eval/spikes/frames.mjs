// Probes iframes: whether each condition's snapshot descends into a same-origin and a cross-origin frame, and whether it can type and click inside the cross-origin one; measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).
//
// The page is served on 127.0.0.1 and the cross-origin frame on localhost at
// the same port: a different host, so a different origin and site, with one
// listener. Paid runs produce it only under --vhosts, where each site has its
// own host; per-origin ports on 127.0.0.1 are one site.

import { findings, page, probeServer, sleep, surface } from './lib.mjs';

const probe = await probeServer({
  '/checkout': (req, res) => {
    const port = req.socket.localPort;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      page(
        'Checkout',
        `<h1>Checkout</h1>
         <iframe title="Delivery slots" src="/slots" width="400" height="80"></iframe>
         <iframe title="Secure card payment" src="http://localhost:${port}/card" width="400" height="120"></iframe>`
      )
    );
  },
  '/slots': page('Slots', '<p>Next slot Tue 10:40</p>'),
  '/card': page(
    'Card',
    `<label for="cc">Card number</label> <input id="cc">
     <button onclick="navigator.sendBeacon('/__log', JSON.stringify({ k: 'tokenise', d: { pan: document.getElementById('cc').value }, t: Date.now(), n: 0 }))">Tokenise</button>`
  ),
});
const log = findings('iframes per condition');

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/checkout');
await pw.navigate(probe.url + '/checkout');
await log.header(dt, pw);

for (const s of [dt, pw]) {
  await s.navigate(probe.url + '/checkout');
  await sleep(1000);
  const snap = await s.snapshot();
  const reach = await s.evaluate(() =>
    [...document.querySelectorAll('iframe')].map((f) => {
      try {
        return f.contentDocument ? 'document' : 'null';
      } catch (error) {
        return `threw ${error.name}`;
      }
    })
  );
  log.record(`${s.name} snapshot and script reach into frames`, {
    sameOriginText: /Next slot/.test(snap),
    crossOriginField: /Card number/.test(snap),
    contentDocument: reach,
  }, s.name === 'devtools'
    ? { sameOriginText: true, crossOriginField: false, contentDocument: ['document', 'null'] }
    : { sameOriginText: true, crossOriginField: true, contentDocument: ['document', 'null'] });

  if (s.name === 'devtools') continue;
  await probe.drain();
  await s.call('browser_type', { element: 'Card number', target: s.target(snap, /"Card number"/), text: '4111111111111111' });
  const again = await s.snapshot();
  await s.call('browser_click', { element: 'Tokenise', target: s.target(again, /"Tokenise"/) });
  const tokenised = (await probe.drain(600)).find((e) => e.k === 'tokenise');
  log.record('playwright types and clicks inside the cross-origin frame', tokenised?.d.pan ?? null, '4111111111111111');
}

await dt.close();
await pw.close();
await probe.close();
log.done();
