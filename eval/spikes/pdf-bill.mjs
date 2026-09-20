// Probes reading the two-page FlateDecode bill pdf-bill serves (billPdf in sites/utility.mjs) through each condition: what a bill link's name becomes when its date is visually hidden, what a click on it becomes, what the snapshot and the page's script can read, whether pdf.js has laid out page 2's text before it is scrolled to, whether the viewer's Save button saves a file, and whether the downloaded file decodes from a shell on the agent's PATH; measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).
//
// The browsers run one after the other, never together. The devtools browser
// launches with the download prefs eval/run.mjs passes (downloadPrefs),
// pointed into the spike's scratch directory.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { agentEnv } from '../agent-env.mjs';
import { downloadPrefs } from '../mcp-stdio.mjs';
import { billPdf, mintBills } from '../../sites/utility.mjs';
import { findings, page, probeServer, sleep, surface } from './lib.mjs';

const bill = mintBills(2, Buffer.from('0123456789abcdef'))[2];
const PDF = billPdf(bill);
const FILE = `grelsby-water-bill-${bill.issued}.pdf`;
const PAGE1 = 'SUMMARY OF CHARGES';
const PAGE2 = 'METER READINGS';
const ESTIMATE = 'Your meter could not be read on';

const probe = await probeServer({
  // The second link carries its date in a visually hidden span, as the
  // fixture's billing history does.
  '/account': page('My Account', `<style>.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}</style>
    <table><tr><td>03/06/2026</td><td><a href="/bill.pdf?b=t0k3n">Bill of 03/06/2026 (PDF, 4 KB)</a></td>
    <td><a href="/bill.pdf?b=t0k3n">Bill<span class="vh"> of 01/04/2026</span> (PDF, 4 KB)</a></td></tr></table>`),
  '/bill.pdf': (req, res) => {
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': PDF.length,
      'content-disposition': `inline; filename="${FILE}"`,
    });
    res.end(PDF);
  },
});
const log = findings('A two-page PDF bill per condition');
const pdfRequests = () => probe.requests.splice(0).filter((r) => r.path.startsWith('/bill.pdf'));
const headersOf = (r) => ({ dest: r.headers['sec-fetch-dest'] ?? null, mode: r.headers['sec-fetch-mode'] ?? null, range: !!r.headers.range });

// What a shell decode sees: every FlateDecode stream inflated, and the
// literal of each Tj.
function shellText(buf) {
  const s = buf.toString('latin1');
  const out = [];
  for (const m of s.matchAll(/\/FlateDecode >>\nstream\n/g)) {
    const start = m.index + m[0].length;
    const end = s.indexOf('\nendstream', start);
    const ops = inflateSync(buf.subarray(start, end)).toString('latin1');
    out.push([...ops.matchAll(/\((.*?)\) Tj/g)].map((t) => t[1]).join(' '));
  }
  return out.join('\n');
}

// The same decode in the agent's own tools, run under the environment
// eval/run.mjs hands an agent, so the PATH is the one an agent's shell has.
const PY = `import re,sys,zlib
d=open(sys.argv[1],'rb').read()
for m in re.finditer(rb'(?<!end)stream\\n(.*?)\\nendstream',d,re.S):
    print(' '.join(t.decode('latin1') for t in re.findall(rb'\\((.*?)\\) Tj',zlib.decompress(m.group(1)))))`;
const NODE = `const d=require('fs').readFileSync(process.argv[1]);const s=d.toString('latin1');
for(const m of s.matchAll(/(?<!end)stream\\n/g)){const e=s.indexOf('\\nendstream',m.index);if(e<0)continue;
console.log([...require('zlib').inflateSync(d.subarray(m.index+m[0].length,e)).toString('latin1').matchAll(/\\((.*?)\\) Tj/g)].map(t=>t[1]).join(' '))}`;
const onPath = (cmd, args) => {
  const r = spawnSync(cmd, args, { env: agentEnv('anthropic'), encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
};

{
  const dt = await surface('devtools', {
    prefs: (scratch) => downloadPrefs(join(scratch, 'downloads')),
  });
  await dt.navigate(probe.url + '/account');
  await log.header(dt);
  pdfRequests();
  let snap = await dt.snapshot();
  log.record('devtools name of a link with a visually hidden date', {
    name: snap.split('\n').find((l) => / a "Bill[ (]/.test(l) && !l.includes('03/06'))?.match(/ a "([^"]*)"/)?.[1] ?? null,
  }, { name: 'Bill (PDF, 4 KB)' });
  const click = await dt.call('click_by_uid', { uid: dt.target(snap, /"Bill of 03\/06\/2026/) });
  const layered = async () => dt.evaluate(() =>
    [...document.querySelectorAll('#viewer .page')].map((p) => p.querySelector('.textLayer')?.textContent.length ?? 0));
  let perPage = [];
  for (let i = 0; i < 20 && !(perPage[0] > 0); i++) {
    await sleep(250);
    perPage = await layered();
    if (!Array.isArray(perPage)) perPage = [];
  }
  const listed = await dt.call('list_downloads', {});
  const downloads = join(dt.scratch, 'downloads');
  log.record('devtools click the bill link', {
    clickMentionsPdf: /pdf|download/i.test(click),
    openedInViewer: await dt.evaluate(() => typeof window.PDFViewerApplication === 'object'),
    location: await dt.evaluate(() => location.pathname + location.search),
    listDownloadsNamesFile: listed.includes(FILE),
    savedToDownloadDir: existsSync(downloads) && readdirSync(downloads).length > 0,
    requests: pdfRequests().map(headersOf),
  }, {
    clickMentionsPdf: false,
    openedInViewer: true,
    location: '/bill.pdf?b=t0k3n',
    listDownloadsNamesFile: false,
    savedToDownloadDir: false,
    requests: [{ dest: 'document', mode: 'navigate', range: false }],
  });

  // Two seconds on, with nothing scrolled. The default snapshot is a 100-line
  // window over the viewer's toolbar and the top of page 1; every text run
  // is its own span, cut like any text node.
  await sleep(2000);
  const settled = await layered();
  const window100 = await dt.snapshot();
  const window500 = await dt.snapshot({ maxLines: 500 });
  log.record('devtools viewer, nothing scrolled', {
    pages: settled.length,
    textLayerFilled: settled.map((n) => n > 0),
    defaultTruncated: /truncated/i.test(window100),
    defaultHasBillNumber: window100.includes(bill.number),
    defaultHasPage1Summary: window100.includes(PAGE1),
    defaultHasPage2: window100.includes(PAGE2),
    maxLines500HasPage2: window500.includes(PAGE2),
    maxLines500HasCodeCell: window500.includes('text="E"'),
    estimateNoteAs: window500.match(/text="(Your meter could not[^"]*)"/)?.[1] ?? null,
    textLayerHasEstimateNote: String(await dt.evaluate(() =>
      document.querySelector('#viewer .page[data-page-number="2"] .textLayer')?.textContent ?? '')).includes(ESTIMATE),
  }, {
    pages: 2,
    textLayerFilled: [true, true],
    defaultTruncated: true,
    defaultHasBillNumber: true,
    defaultHasPage1Summary: false,
    defaultHasPage2: false,
    maxLines500HasPage2: true,
    maxLines500HasCodeCell: true,
    estimateNoteAs: 'Your meter could not be rea...',
    textLayerHasEstimateNote: true,
  });

  // pdf.js's own document API reads any page without rendering it.
  const api = await dt.evaluate(async () => {
    const doc = window.PDFViewerApplication.pdfDocument;
    const text = await (await doc.getPage(2)).getTextContent();
    return { pages: doc.numPages, page2: text.items.map((i) => i.str).join(' ') };
  });
  log.record('devtools pdf.js getTextContent through script', {
    pages: api?.pages ?? null,
    page2HasEstimateNote: String(api?.page2 ?? '').includes(ESTIMATE),
  }, { pages: 2, page2HasEstimateNote: true });

  // The viewer's own Save button, clicked and then called through script:
  // headless, neither saves a file, so a devtools agent has no download of the
  // bill to decode, and list_downloads has nothing to name.
  const save = await dt.call('click_by_uid', { uid: dt.target(await dt.snapshot(), /button "Save"/) });
  await sleep(2500);
  const afterClick = await dt.call('list_downloads', {});
  const called = await dt.evaluate(async () => {
    await window.PDFViewerApplication.downloadOrSave();
    return true;
  });
  await sleep(2500);
  const afterScript = await dt.call('list_downloads', {});
  log.record('devtools viewer Save button', {
    clickError: /^(ERROR|THROW)/.test(save),
    clickSaved: afterClick.includes(FILE),
    scriptCalled: called === true,
    scriptSaved: afterScript.includes(FILE),
    listDownloads: afterScript.trim(),
    savedToDownloadDir: existsSync(downloads) && readdirSync(downloads).length > 0,
  }, {
    clickError: false,
    clickSaved: false,
    scriptCalled: true,
    scriptSaved: false,
    listDownloads: 'No downloads tracked.',
    savedToDownloadDir: false,
  });
  await dt.close();
}

{
  const pw = await surface('playwright');
  await pw.navigate(probe.url + '/account');
  await log.header(pw);
  pdfRequests();
  const snap = await pw.snapshot();
  log.record('playwright name of a link with a visually hidden date', {
    name: snap.split('\n').find((l) => /link "Bill/.test(l) && l.includes('01/04'))?.match(/link "([^"]*)"/)?.[1] ?? null,
  }, { name: 'Bill of 01/04/2026 (PDF, 4 KB)' });
  const click = await pw.call('browser_click', { element: 'Bill link', target: pw.target(snap, /"Bill of 03\/06\/2026/) });
  await sleep(1000);
  const saved = click.match(/Downloaded file (\S+) to "?([^"\n]+?)"?\s*(?:\n|$)/);
  const out = join(pw.scratch, 'out');
  const file = existsSync(out) ? readdirSync(out).find((f) => f.endsWith('.pdf')) : null;
  const bytes = file ? readFileSync(join(out, file)) : null;
  log.record('playwright click the bill link', {
    resultNamesDownload: !!saved && saved[1] === FILE,
    tabStayed: await pw.evaluate(() => location.pathname),
    snapshotShowsBill: (await pw.snapshot()).includes(bill.number),
    savedUnderOutputDir: file === FILE,
    bytesIdentical: !!bytes && bytes.equals(PDF),
    requests: pdfRequests().map(headersOf),
  }, {
    resultNamesDownload: true,
    tabStayed: '/account',
    snapshotShowsBill: false,
    savedUnderOutputDir: true,
    bytesIdentical: true,
    requests: [{ dest: 'document', mode: 'navigate', range: false }],
  });

  const path = file ? join(out, file) : '/nonexistent';
  const python = onPath('python3', ['-c', PY, path]);
  const node = onPath('node', ['-e', NODE, path]);
  log.record('the downloaded file decodes in a shell', {
    rawBytesHaveText: !!bytes && bytes.toString('latin1').includes(ESTIMATE),
    inflatedHasBoth: !!bytes && [PAGE1, PAGE2, ESTIMATE, bill.number].every((t) => shellText(bytes).includes(t)),
    python3OnAgentPath: !!python && python.includes(ESTIMATE),
    nodeOnAgentPath: !!node && node.includes(ESTIMATE),
  }, { rawBytesHaveText: false, inflatedHasBoth: true, python3OnAgentPath: true, nodeOnAgentPath: true });

  // The route that needs no shell: fetch the PDF from the page and inflate it
  // with the browser's own DecompressionStream.
  const inPage = await pw.evaluate(`async () => {
    const buf = new Uint8Array(await (await fetch('/bill.pdf?b=t0k3n')).arrayBuffer());
    const s = new TextDecoder('latin1').decode(buf);
    let text = '';
    for (const m of s.matchAll(/(?<!end)stream\\n/g)) {
      const end = s.indexOf('\\nendstream', m.index);
      if (end < 0) continue;
      const part = buf.slice(m.index + m[0].length, end);
      const out = await new Response(new Blob([part]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
      text += new TextDecoder('latin1').decode(out);
    }
    return text.includes(${JSON.stringify(ESTIMATE)});
  }`);
  log.record('playwright in-page fetch and DecompressionStream', {
    readsEstimateNote: inPage === true,
    requests: pdfRequests().map(headersOf),
  }, { readsEstimateNote: true, requests: [{ dest: 'empty', mode: 'cors', range: false }] });
  await pw.close();
}

await probe.close();
log.done();
