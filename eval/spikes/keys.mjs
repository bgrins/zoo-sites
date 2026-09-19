// Probes keyboard input: what devtools fill_by_uid sends as keys (WebDriver key codepoints included) and whether playwright browser_press_key activates a focused button; measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).

import { findings, page, probeServer, surface } from './lib.mjs';

// WebDriver's key codepoints (Private Use Area), which a text fill passes
// through to the browser's key actions.
const ENTER = String.fromCodePoint(0xe007);
const TAB = String.fromCodePoint(0xe004);
const SPACE = String.fromCodePoint(0xe00d);

const probe = await probeServer({
  '/keys': page(
    'Keys',
    `<form action="/sent" method="get"><label for="name">Name</label> <input id="name" name="name">
     <button id="send">Send</button></form>
     <button id="act" type="button" onclick="document.getElementById('out').textContent = 'activated detail=' + event.detail">Add to basket</button>
     <label for="notes">Notes</label> <textarea id="notes"></textarea>
     <output id="out"></output>`
  ),
  '/sent': page('Sent', '<h1>Sent</h1>'),
});
const log = findings('Keyboard input per condition');
const keysOf = (events) =>
  events.filter((e) => e.k === 'keydown').map((e) => `${e.d.key}${e.d.trusted ? '' : ' (untrusted)'}@${e.d.id}`);
const state = (s) =>
  s.evaluate(() => ({
    path: location.pathname,
    focus: document.activeElement?.id || document.activeElement?.tagName,
    out: document.getElementById('out')?.textContent ?? null,
  }));

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/keys');
await pw.navigate(probe.url + '/keys');
await log.header(dt, pw);

{
  const load = async () => {
    await dt.navigate(probe.url + '/keys');
    await probe.drain();
    return dt.snapshot();
  };
  let snap = await load();
  await dt.call('fill_by_uid', { uid: dt.target(snap, /"Name"/), value: 'abc' });
  log.record('devtools fill types trusted keydowns', keysOf(await probe.drain()), [
    'a@name', 'b@name', 'c@name',
  ]);

  snap = await load();
  await dt.call('fill_by_uid', { uid: dt.target(snap, /"Notes"/), value: 'ab\ncd\te' });
  log.record(
    'devtools fill of \\n and \\t into a textarea',
    { keys: keysOf(await probe.drain()), value: await dt.evaluate(() => document.getElementById('notes').value) },
    { keys: ['a@notes', 'b@notes', '\n@notes', 'c@notes', 'd@notes', '\t@notes', 'e@notes'], value: 'ab\ncd\te' }
  );

  snap = await load();
  await dt.call('fill_by_uid', { uid: dt.target(snap, /"Name"/), value: `Ann${ENTER}` });
  await probe.drain(800);
  log.record('devtools fill "Ann"+U+E007 in a form field', await state(dt), {
    path: '/sent', focus: 'BODY', out: null,
  });

  snap = await load();
  await dt.call('fill_by_uid', { uid: dt.target(snap, /"Name"/), value: TAB });
  log.record('devtools fill U+E004 (Tab) moves focus', (await state(dt)).focus, 'send');

  for (const [label, key] of [['U+E007 (Enter)', ENTER], ['U+E00D (Space)', SPACE]]) {
    snap = await load();
    const r = await dt.call('fill_by_uid', { uid: dt.target(snap, /button "Add to basket"/), value: key });
    log.record(
      `devtools fill ${label} on a button activates it`,
      { toolError: /^(ERROR|THROW)/.test(r), out: (await state(dt)).out },
      { toolError: false, out: 'activated detail=0' }
    );
  }
}

{
  const load = async () => {
    await pw.navigate(probe.url + '/keys');
    await probe.drain();
    return pw.snapshot();
  };
  let snap = await load();
  await pw.call('browser_click', { element: 'Name', target: pw.target(snap, /"Name"/) });
  await pw.call('browser_press_key', { key: 'Tab' });
  await pw.call('browser_press_key', { key: 'Tab' });
  log.record('playwright Tab Tab from Name reaches the basket button', (await state(pw)).focus, 'act');
  await probe.drain();
  await pw.call('browser_press_key', { key: 'Enter' });
  log.record('playwright press Enter on the focused button', {
    out: (await state(pw)).out,
    keys: keysOf(await probe.drain()),
  }, { out: 'activated detail=0', keys: ['Enter@act'] });

  snap = await load();
  await pw.call('browser_click', { element: 'Name', target: pw.target(snap, /"Name"/) });
  await pw.call('browser_press_key', { key: 'Tab' });
  await pw.call('browser_press_key', { key: 'Tab' });
  await pw.call('browser_press_key', { key: ' ' });
  log.record('playwright press Space on the focused button', (await state(pw)).out, 'activated detail=0');

  snap = await load();
  await pw.call('browser_type', { element: 'Name', target: pw.target(snap, /"Name"/), text: 'Ann', submit: true });
  await probe.drain(800);
  log.record('playwright type with submit', (await state(pw)).path, '/sent');
}

await dt.close();
await pw.close();
await probe.close();
log.done();
