// Probes files: where an attachment download lands and how each condition reports it, what an inline application/pdf becomes, and uploading through a label over a hidden file input; measured on firefox-devtools-mcp 0.9.15 and 0.10.3 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).
//
// The devtools browser runs on a profile whose download prefs point into the
// spike's scratch directory, the fix a per-attempt download directory needs;
// without them the file lands in the OS download folder (~/Downloads,
// measured 2026-09-19), which this spike never writes to.

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findings, page, probeServer, sleep, surface } from './lib.mjs';

// A one-page PDF 1.4 with an uncompressed text stream.
function pdf(text) {
  const content = `BT /F1 14 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const STATEMENT = 'Statement ref ST-9QX4 closing balance 4,812.07';
const probe = await probeServer({
  '/files': page(
    'Documents',
    `<a href="/sheet.csv">Download reading sheet (CSV)</a> <a href="/bill.pdf">Statement (PDF)</a>
     <label for="up" style="border:1px solid;padding:4px">Choose sheet</label>
     <input type="file" id="up" accept=".csv" style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden">
     <output id="chosen"></output>
     <script>document.getElementById('up').addEventListener('change', (e) => { document.getElementById('chosen').textContent = [...e.target.files].map((f) => f.name).join(','); });</script>`
  ),
  '/sheet.csv': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="reading-sheet-7F3A.csv"' });
    res.end('room_key,reading_c\nR-19A2,\n');
  },
  '/bill.pdf': (req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="statement.pdf"' });
    res.end(pdf(STATEMENT));
  },
});
const log = findings('Downloads, PDFs and uploads per condition');

const dt = await surface('devtools', {
  prefs: (scratch) => ({
    'browser.download.folderList': 2,
    'browser.download.useDownloadDir': true,
    'browser.download.dir': join(scratch, 'downloads'),
  }),
});
const downloads = join(dt.scratch, 'downloads');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/files');
await pw.navigate(probe.url + '/files');
await log.header(dt, pw);

const upload = join(pw.scratch, 'reading-sheet.csv');
writeFileSync(upload, 'room_key,reading_c\nR-19A2,3.4\n');

{
  let snap = await dt.snapshot();
  const click = await dt.call('click_by_uid', { uid: dt.target(snap, /"Download reading sheet/) });
  await sleep(1500);
  const listed = await dt.call('list_downloads', {});
  log.record('devtools click an attachment link', {
    clickMentionsDownload: /download/i.test(click),
    listDownloadsNamesFile: /reading-sheet-7F3A\.csv/.test(listed),
    landedInPrefDir: existsSync(downloads) && readdirSync(downloads).includes('reading-sheet-7F3A.csv'),
  }, { clickMentionsDownload: false, listDownloadsNamesFile: true, landedInPrefDir: true });

  await dt.navigate(probe.url + '/bill.pdf');
  await sleep(2500);
  snap = await dt.snapshot();
  const layer = await dt.evaluate(() => document.querySelector('.textLayer')?.textContent ?? null);
  log.record('devtools navigate to an inline PDF', {
    snapshotTruncated: /truncated/i.test(snap),
    snapshotHasFullLine: snap.includes(STATEMENT),
    textLayerViaScript: layer,
  }, { snapshotTruncated: true, snapshotHasFullLine: false, textLayerViaScript: STATEMENT });

  await dt.navigate(probe.url + '/files');
  snap = await dt.snapshot();
  const input = dt.target(snap, /"Choose sheet"/);
  const r = await dt.call('upload_file_by_uid', { uid: input, filePath: upload });
  await sleep(500);
  const full = await dt.snapshot({ includeAll: true });
  log.record('devtools upload through a label over a visually hidden input', {
    inputInSnapshot: !!input,
    inputInIncludeAll: /uid=\S+ input/.test(full),
    toolError: /^(ERROR|THROW)/.test(r),
    chosen: await dt.evaluate(() => document.getElementById('chosen').textContent),
  }, { inputInSnapshot: false, inputInIncludeAll: false, toolError: true, chosen: '' });
}

{
  let snap = await pw.snapshot();
  const click = await pw.call('browser_click', { element: 'Download', target: pw.target(snap, /"Download reading sheet/) });
  log.record('playwright click an attachment link', {
    resultNamesSavedPath: /Downloaded file reading-sheet-7F3A\.csv to/.test(click),
  }, { resultNamesSavedPath: true });

  const nav = await pw.call('browser_navigate', { url: probe.url + '/bill.pdf' });
  await sleep(1500);
  log.record('playwright navigate to an inline PDF', {
    becameDownload: /Downloaded file/.test(nav),
    tabStayed: await pw.evaluate(() => location.pathname),
    tabShowsPdf: /ST-9QX4/.test(await pw.snapshot()),
  }, { becameDownload: true, tabStayed: '/files', tabShowsPdf: false });

  await pw.navigate(probe.url + '/files');
  snap = await pw.snapshot();
  const chooser = await pw.call('browser_click', { element: 'Choose sheet', target: pw.target(snap, /"Choose sheet"/) });
  const r = await pw.call('browser_file_upload', { paths: [upload] });
  await sleep(500);
  log.record('playwright click the label, then browser_file_upload', {
    chooserModal: /Modal state[\s\S]*File chooser/i.test(chooser),
    toolError: /^(ERROR|THROW)/.test(r),
    chosen: await pw.evaluate(() => document.getElementById('chosen').textContent),
  }, { chooserModal: true, toolError: false, chosen: 'reading-sheet.csv' });
}

await dt.close();
await pw.close();
await probe.close();
log.done();
