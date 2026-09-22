// Probes typing into a contenteditable editor: whether each condition's fill keeps existing content, what beforeinput events an editor's input rules would see, and keyboard text selection; measured on firefox-devtools-mcp 0.9.15 and 0.10.3 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).

import { findings, page, probeServer, surface } from './lib.mjs';

const probe = await probeServer({
  '/compose': page(
    'Incident update',
    `<div id="ed" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Update body"
          style="border:1px solid;min-height:60px"><p>Investigating</p></div>`
  ),
});
const log = findings('contenteditable per condition');
const typed = (events) => {
  const before = events.filter((e) => e.k === 'beforeinput');
  return {
    beforeinput: before.length,
    inputTypes: [...new Set(before.map((e) => e.d.it))].sort(),
    trusted: before.every((e) => e.d.trusted),
  };
};
const body = (s) => s.evaluate(() => document.getElementById('ed').innerHTML);

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/compose');
await pw.navigate(probe.url + '/compose');
await log.header(dt, pw);

{
  const snap = await dt.snapshot();
  await probe.drain();
  await dt.call('fill_by_uid', { uid: dt.target(snap, /"Update body"/), value: '- Monitoring' });
  log.record('devtools fill_by_uid on the editor', { ...typed(await probe.drain()), html: await body(dt) }, {
    beforeinput: 12, inputTypes: ['insertText'], trusted: true, html: '- Monitoring',
  });
}

for (const slowly of [false, true]) {
  await pw.navigate(probe.url + '/compose');
  const snap = await pw.snapshot();
  await probe.drain();
  await pw.call('browser_type', { element: 'Update body', target: pw.target(snap, /"Update body"/), text: '- Monitoring', slowly });
  log.record(`playwright browser_type${slowly ? ' slowly' : ''} on the editor`, { ...typed(await probe.drain()), html: await body(pw) },
    slowly
      ? { beforeinput: 12, inputTypes: ['insertText'], trusted: true, html: '<p>- MonitoringInvestigating</p>' }
      : { beforeinput: 1, inputTypes: ['insertCompositionText'], trusted: true, html: '- Monitoring' });
}

{
  for (let i = 0; i < 10; i++) await pw.call('browser_press_key', { key: 'Shift+ArrowLeft' });
  log.record('playwright Shift+ArrowLeft x10 selects text', await pw.evaluate(() => getSelection().toString()), 'Monitoring');
}

await dt.close();
await pw.close();
await probe.close();
log.done();
