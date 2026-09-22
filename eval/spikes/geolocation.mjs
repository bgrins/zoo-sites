// Probes navigator.geolocation.getCurrentPosition with an 8s timeout: whether it resolves, errors or never settles through each condition; measured on firefox-devtools-mcp 0.9.15 and 0.10.3 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).
//
// The permission prompt is browser chrome no page tool reaches, and the
// API's timeout starts only once permission is granted.

import { findings, page, probeServer, sleep, surface } from './lib.mjs';

const probe = await probeServer({
  '/stock': page(
    'Check stock',
    `<button id="loc">Use my location</button><output id="out">idle</output>
     <script>
       document.getElementById('loc').addEventListener('click', () => {
         const out = document.getElementById('out');
         out.textContent = 'finding';
         navigator.geolocation.getCurrentPosition(
           (p) => { out.textContent = 'position'; },
           (e) => { out.textContent = 'error ' + e.code; },
           { timeout: 8000 }
         );
       });
     </script>`
  ),
});
const log = findings('Geolocation per condition');

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/stock');
await pw.navigate(probe.url + '/stock');
await log.header(dt, pw);

for (const s of [dt, pw]) {
  const snap = await s.snapshot();
  const target = s.target(snap, /"Use my location"/);
  if (s.name === 'devtools') await s.call('click_by_uid', { uid: target });
  else await s.call('browser_click', { element: 'Use my location', target });
  await sleep(9500);
  log.record(`${s.name} 9.5s after Use my location`, await s.evaluate(() => document.getElementById('out').textContent), 'finding');
}

await dt.close();
await pw.close();
await probe.close();
log.done();
