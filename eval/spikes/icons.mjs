// Probes icon-only controls: what each condition's snapshot shows for an empty icon element with and without a title, and for the options of a native select; measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).

import { findings, page, probeServer, surface } from './lib.mjs';

const probe = await probeServer({
  // Icon-font glyphs: an empty <i> whose ::before content is a Private Use
  // Area codepoint, set from script so no escape sits in this file. A tooltip
  // helper that moves title into data-original-title on init, as Bootstrap's
  // does, leaves the icon with no accessible name at all.
  '/library': page(
    'Recordings',
    `<style>.ico{display:inline-block;width:20px;cursor:pointer}</style>
     <script>
       const glyphs = document.createElement('style');
       const pua = (n) => String.fromCodePoint(0xe900 + n);
       glyphs.textContent = '.ico-archive::before{content:"' + pua(0) + '"}.ico-delete::before{content:"' + pua(1) + '"}';
       document.head.append(glyphs);
     </script>
     <div class="row"><span>Shipping forecast 0520</span>
       <i class="ico ico-archive" title="Archive" onclick="document.title='archived'"></i>
       <i class="ico ico-delete" data-original-title="Delete permanently" onclick="document.title='deleted'"></i>
     </div>
     <label for="bulk">Bulk actions</label>
     <select id="bulk"><option>Choose...</option><option>Move to archive</option><option>Delete permanently</option></select>`
  ),
});
const log = findings('Icon-only controls per condition');

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/library');
await pw.navigate(probe.url + '/library');
await log.header(dt, pw);

for (const s of [dt, pw]) {
  const snap = await s.snapshot();
  const lines = snap.split('\n');
  const full = s.name === 'devtools' ? (await s.snapshot({ includeAll: true })).split('\n') : lines;
  log.record(`${s.name} snapshot of the row and the select`, {
    titledIcon: lines.some((l) => /"Archive"/.test(l)),
    titledIconWithIncludeAll: full.some((l) => /"Archive"/.test(l)),
    unnamedIconLines: full.filter((l) => /generic \[ref=\w+\] \[cursor=pointer\](:.*)?$|uid=\S+ i$/.test(l.trim())).length,
    selectOptions: /Move to archive/.test(snap),
  }, s.name === 'devtools'
    ? { titledIcon: false, titledIconWithIncludeAll: true, unnamedIconLines: 1, selectOptions: false }
    : { titledIcon: true, titledIconWithIncludeAll: true, unnamedIconLines: 1, selectOptions: true });
}

await dt.close();
await pw.close();
await probe.close();
log.done();
