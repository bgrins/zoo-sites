// Probes clipboard paste into a grid: playwright copy and paste through browser_press_key, and a synthetic ClipboardEvent dispatched through devtools evaluate_script; measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).

import { findings, page, probeServer, surface } from './lib.mjs';

const TSV = 'SKU-1\t4\nSKU-2\t9';
const probe = await probeServer({
  '/order': page(
    'Quick order',
    `<label for="src">Notes</label> <textarea id="src"></textarea>
     <div id="grid" tabindex="0" role="grid" aria-label="Quick order grid" style="border:1px solid;min-height:40px">Paste lines here</div>
     <script>
       document.getElementById('grid').addEventListener('paste', (e) => {
         e.preventDefault();
         const text = e.clipboardData?.getData('text/plain') ?? '';
         document.getElementById('grid').dataset.pasted = JSON.stringify({ trusted: e.isTrusted, text });
       });
     </script>`
  ),
});
const log = findings('Clipboard paste per condition');
const pasted = (s) => s.evaluate(() => JSON.parse(document.getElementById('grid').dataset.pasted ?? 'null'));

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/order');
await pw.navigate(probe.url + '/order');
await log.header(dt, pw);

{
  const snap = await pw.snapshot();
  await pw.call('browser_type', { element: 'Notes', target: pw.target(snap, /"Notes"/), text: TSV });
  await pw.call('browser_press_key', { key: 'ControlOrMeta+a' });
  await pw.call('browser_press_key', { key: 'ControlOrMeta+c' });
  await pw.call('browser_click', { element: 'grid', target: pw.target(snap, /grid "Quick order grid"/) });
  await pw.call('browser_press_key', { key: 'ControlOrMeta+v' });
  log.record('playwright copy from a textarea, paste on the grid', await pasted(pw), { trusted: true, text: TSV });
}

{
  await dt.evaluate(`() => {
    const data = new DataTransfer();
    data.setData('text/plain', ${JSON.stringify(TSV)});
    document.getElementById('grid').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return 1;
  }`);
  log.record('devtools synthetic ClipboardEvent through evaluate_script', await pasted(dt), { trusted: false, text: '' });
}

await dt.close();
await pw.close();
await probe.close();
log.done();
