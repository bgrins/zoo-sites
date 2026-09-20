// Probes the native-permit form shape end to end on each condition: a select[multiple] of 14 streets, two datetime-local fields, a time field with step=900 and a datalist input, submitted as a real form POST whose parsed body the probe server records; measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).
//
// It runs one browser at a time. controls.mjs measures each control alone;
// this spike measures what reaches a server through each condition's honest
// route and through its naive one, which is what native-permit grades.

import { PINNED_PREFS } from '../mcp-stdio.mjs';
import { findings, packageVersions, page, probeServer, sleep, surface } from './lib.mjs';

// The fixture's streets, in its order: every initial differs, so typing a
// name into the listbox lands on that name's option.
const STREETS = [
  'Abrill Street', 'Dremmock Lane', 'Fettick Place', 'Gilvane Row', 'Holbrisk Road', 'Lumsick Walk',
  'Nadderly Road', 'Ombery Terrace', 'Pessick Street', 'Quistel Lane', 'Selbray Court', 'Umbrell Yard',
  'Wrothen Road', 'Yarrant Street',
];
const WANT = ['s2', 's5', 's9', 's12'];
const WANT_NAMES = WANT.map((v) => STREETS[Number(v.slice(1))]);

const posts = [];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const probe = await probeServer({
  '/apply': page(
    'Apply',
    `<form method="post" action="/check">
     <input type="hidden" name="nonce" value="n0">
     <label for="streets">Streets to close</label>
     <select id="streets" name="street" multiple size="8">${STREETS.map((s, i) => `<option value="s${i}">${s}</option>`).join('')}</select>
     <label for="start">Closure starts</label> <input type="datetime-local" id="start" name="start">
     <label for="end">Closure ends</label> <input type="datetime-local" id="end" name="end">
     <label for="quiet">Amplified sound stops</label> <input type="time" id="quiet" name="quiet" step="900">
     <label for="equipment">Equipment code</label> <input id="equipment" name="equipment" list="codes">
     <datalist id="codes"><option value="GEN-35">Generator, 3-5 kVA</option><option value="GEN-58">Generator, 5-8 kVA</option></datalist>
     <button type="submit">Continue</button>
     </form>`
  ),
  '/check': (req, res, body) => {
    const form = new URLSearchParams(body);
    const got = {
      streets: form.getAll('street'),
      start: form.get('start'),
      end: form.get('end'),
      quiet: form.get('quiet'),
      equipment: form.get('equipment'),
      dest: req.headers['sec-fetch-dest'] ?? null,
      mode: req.headers['sec-fetch-mode'] ?? null,
    };
    posts.push(got);
    // The fixture's check page: a summary list, one row per answer, with a
    // Change link in its own <dd>, and the streets as a list in theirs.
    const row = (key, value) =>
      `<div><dt>${key}</dt><dd>${value}</dd><dd><a href="/apply">Change<span hidden> ${key.toLowerCase()}</span></a></dd></div>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(
      page(
        'Check your answers',
        `<h1>Check your answers</h1><dl>
         ${row('Streets', `<ul>${got.streets.map((v) => `<li>${esc(STREETS[Number(v.slice(1))])}</li>`).join('')}</ul>`)}
         ${row('Starts', esc(got.start))}
         ${row('Ends', esc(got.end))}
         ${row('Sound stops', esc(got.quiet))}
         ${row('Equipment', esc(got.equipment))}</dl>`
      )
    );
  },
});
const log = findings('native-permit form controls per condition');
const values = (s) =>
  s.evaluate(() => ({
    streets: [...document.getElementById('streets').selectedOptions].map((o) => o.value),
    start: document.getElementById('start').value,
    end: document.getElementById('end').value,
    quiet: document.getElementById('quiet').value,
    equipment: document.getElementById('equipment').value,
  }));
const toolError = (r) =>
  /^(ERROR|THROW)/.test(r)
    ? (r.match(/Error: (?:browserBackend\.callTool: )?(?:Error: )?([^\n]+)/)?.[1] ?? r.split('\n')[0]).slice(0, 60)
    : null;
const lastPost = async () => {
  await sleep(300);
  return posts.at(-1) ?? null;
};
const versions = packageVersions();
const running = [];

{
  const dt = await surface('devtools', { prefs: () => PINNED_PREFS });
  const load = async (opts = {}) => {
    await dt.navigate(probe.url + '/apply');
    return dt.snapshot(opts);
  };
  const uid = (snap, label) => dt.target(snap, new RegExp(`"${label}"`));
  await load();
  running.push(`firefox-devtools-mcp ${versions.devtools} (Firefox ${await dt.firefox()})`);

  {
    const plain = await load();
    const all = await dt.snapshot({ includeAll: true });
    const optionLines = (snap) => snap.split('\n').filter((l) => /\boption\b/.test(l) && /uid=/.test(l));
    log.record(
      'devtools option lines with a uid: default snapshot, includeAll',
      [optionLines(plain).length, optionLines(all).length],
      [0, 14]
    );
    // The includeAll line for an option carries no selected state, so a
    // devtools snapshot cannot say which streets are chosen.
    const first = optionLines(all)[0] ?? '';
    log.record('devtools includeAll option line names a selected state', /selected/i.test(first), false);
    for (const name of WANT_NAMES) {
      const snap = await dt.snapshot({ includeAll: true });
      const line = snap.split('\n').find((l) => l.includes(name));
      await dt.call('click_by_uid', { uid: line.match(/uid=(\S+)/)[1] });
    }
    log.record('devtools click_by_uid on four options in turn', (await values(dt)).streets, WANT);
    {
      const snap = await dt.snapshot({ includeAll: true });
      const line = snap.split('\n').find((l) => l.includes(WANT_NAMES[1]));
      await dt.call('click_by_uid', { uid: line.match(/uid=(\S+)/)[1] });
    }
    log.record('devtools click_by_uid on a selected option again', (await values(dt)).streets, [WANT[0], WANT[2], WANT[3]]);
  }

  {
    const snap = await load();
    const r = await dt.call('fill_by_uid', { uid: uid(snap, 'Streets to close'), value: WANT_NAMES[0] });
    log.record('devtools fill select[multiple] one street name', { error: toolError(r), streets: (await values(dt)).streets }, {
      error: null, streets: [WANT[0]],
    });
  }

  const fillOne = async (label, value, key) => {
    const snap = await load();
    const r = await dt.call('fill_by_uid', { uid: uid(snap, label), value });
    return { error: toolError(r), [key]: (await values(dt))[key] };
  };
  log.record('devtools fill datetime-local ISO 2027-07-17T07:30', await fillOne('Closure starts', '2027-07-17T07:30', 'start'), {
    error: null, start: '7071-02-02T07:07',
  });
  log.record('devtools fill datetime-local ISO 2027-07-17T19:45', await fillOne('Closure ends', '2027-07-17T19:45', 'end'), {
    error: null, end: '7071-02-02T07:19',
  });
  log.record('devtools fill datetime-local typed 07/17/2027 07:30 AM', await fillOne('Closure starts', '07/17/2027 07:30 AM', 'start'), {
    error: null, start: '2027-07-17T07:30',
  });
  log.record('devtools fill datetime-local typed 07/17/2027 19:45', await fillOne('Closure ends', '07/17/2027 19:45', 'end'), {
    error: null, end: '2027-07-17T19:45',
  });
  log.record('devtools fill time 21:30', await fillOne('Amplified sound stops', '21:30', 'quiet'), { error: null, quiet: '21:30' });
  log.record('devtools fill time 09:30 PM', await fillOne('Amplified sound stops', '09:30 PM', 'quiet'), { error: null, quiet: '' });
  log.record('devtools fill datalist input GEN-35', await fillOne('Equipment code', 'GEN-35', 'equipment'), {
    error: null, equipment: 'GEN-35',
  });

  // Naive route: one fill per field, ISO datetimes, then Continue.
  {
    const snap = await load();
    await dt.call('fill_by_uid', { uid: uid(snap, 'Streets to close'), value: WANT_NAMES.join(', ') });
    await dt.call('fill_by_uid', { uid: uid(snap, 'Closure starts'), value: '2027-07-17T07:30' });
    await dt.call('fill_by_uid', { uid: uid(snap, 'Closure ends'), value: '2027-07-17T19:45' });
    await dt.call('fill_by_uid', { uid: uid(snap, 'Amplified sound stops'), value: '21:30' });
    await dt.call('fill_by_uid', { uid: uid(snap, 'Equipment code'), value: 'GEN-35' });
    const n = posts.length;
    await dt.call('click_by_uid', { uid: dt.target(snap, /button "Continue"/) });
    await sleep(500);
    log.record('devtools naive route: what the server parsed', posts.length > n ? await lastPost() : null, {
      streets: [WANT[0]], start: '7071-02-02T07:07', end: '7071-02-02T07:19', quiet: '21:30', equipment: 'GEN-35',
      dest: 'document', mode: 'navigate',
    });
    // The devtools walker keeps text only from div, span, p, li, ul and ol
    // (and headings, landmarks and controls) unless includeAll is set, so a
    // summary list's <dd> reaches the agent only through includeAll or
    // evaluate_script. The tag of every line carrying the parsed start, and
    // the count of street lines, which sit in <li> inside a <dd>.
    const tagsOf = (snap, needle) => snap.split('\n').filter((l) => l.includes(needle)).map((l) => l.trim().split(/\s+/)[1]);
    const echo = await dt.snapshot();
    const echoAll = await dt.snapshot({ includeAll: true });
    log.record(
      'devtools <dl> check page, default snapshot: tags carrying the parsed start, street lines',
      [tagsOf(echo, '7071-02-02T07:07'), tagsOf(echo, WANT_NAMES[0]).length],
      [[], 1]
    );
    log.record(
      'devtools <dl> check page, includeAll snapshot: tags carrying the parsed start',
      tagsOf(echoAll, '7071-02-02T07:07'),
      ['dd']
    );
  }

  // Honest route: option clicks from an includeAll snapshot, typed datetimes.
  {
    await load();
    for (const name of WANT_NAMES) {
      const snap = await dt.snapshot({ includeAll: true });
      const line = snap.split('\n').find((l) => l.includes(name));
      await dt.call('click_by_uid', { uid: line.match(/uid=(\S+)/)[1] });
    }
    const snap = await dt.snapshot();
    await dt.call('fill_by_uid', { uid: uid(snap, 'Closure starts'), value: '07/17/2027 07:30 AM' });
    await dt.call('fill_by_uid', { uid: uid(snap, 'Closure ends'), value: '07/17/2027 07:45 PM' });
    await dt.call('fill_by_uid', { uid: uid(snap, 'Amplified sound stops'), value: '21:30' });
    await dt.call('fill_by_uid', { uid: uid(snap, 'Equipment code'), value: 'GEN-35' });
    const n = posts.length;
    await dt.call('click_by_uid', { uid: dt.target(snap, /button "Continue"/) });
    await sleep(500);
    log.record('devtools honest route: what the server parsed', posts.length > n ? await lastPost() : null, {
      streets: WANT, start: '2027-07-17T07:30', end: '2027-07-17T19:45', quiet: '21:30', equipment: 'GEN-35',
      dest: 'document', mode: 'navigate',
    });
  }
  await dt.close();
}

{
  const pw = await surface('playwright');
  const load = async () => {
    await pw.navigate(probe.url + '/apply');
    return pw.snapshot();
  };
  const ref = (snap, label) => pw.target(snap, new RegExp(`"${label}"`));
  await load();
  running.push(`@playwright/mcp ${versions.playwright} (Firefox ${await pw.firefox()})`);

  {
    const snap = await load();
    const lines = snap.split('\n');
    log.record(
      'playwright snapshot: the listbox and its option lines',
      [lines.some((l) => /listbox "Streets to close"/.test(l)), lines.filter((l) => /- option "/.test(l)).length],
      [true, 14]
    );
    const r = await pw.call('browser_select_option', { element: 'Streets to close', target: ref(snap, 'Streets to close'), values: WANT_NAMES });
    log.record('playwright select_option four street names', { error: toolError(r), streets: (await values(pw)).streets }, {
      error: null, streets: WANT,
    });
    const after = await pw.snapshot();
    log.record(
      'playwright snapshot marks the chosen options [selected]',
      after.split('\n').filter((l) => /- option "[^"]+" \[selected\]/.test(l)).length,
      4
    );
    const other = STREETS[0];
    await pw.call('browser_click', { element: other, target: pw.target(after, new RegExp(`option "${other}"`)) });
    log.record('playwright plain click on another option', (await values(pw)).streets, ['s0']);
    const again = await pw.snapshot();
    await pw.call('browser_click', {
      element: WANT_NAMES[0], target: pw.target(again, new RegExp(`option "${WANT_NAMES[0]}"`)), modifiers: ['ControlOrMeta'],
    });
    log.record('playwright ControlOrMeta click adds an option', (await values(pw)).streets, ['s0', WANT[0]]);
  }

  const fillOne = async (label, value, key, type = 'textbox') => {
    const snap = await load();
    const r = await pw.call('browser_fill_form', { fields: [{ name: label, type, target: ref(snap, label), value }] });
    return { error: toolError(r), [key]: (await values(pw))[key] };
  };
  const typeOne = async (label, text, key) => {
    const snap = await load();
    const r = await pw.call('browser_type', { element: label, target: ref(snap, label), text });
    return { error: toolError(r), [key]: (await values(pw))[key] };
  };
  log.record('playwright fill_form datetime-local ISO', await fillOne('Closure starts', '2027-07-17T07:30', 'start'), {
    error: null, start: '2027-07-17T07:30',
  });
  log.record('playwright type datetime-local typed 07/17/2027 07:30 AM', await typeOne('Closure starts', '07/17/2027 07:30 AM', 'start'), {
    error: 'Malformed value', start: '',
  });
  log.record('playwright fill_form time 21:30', await fillOne('Amplified sound stops', '21:30', 'quiet'), { error: null, quiet: '21:30' });
  log.record('playwright type time 09:30 PM', await typeOne('Amplified sound stops', '09:30 PM', 'quiet'), {
    error: 'Malformed value', quiet: '',
  });
  {
    const line = (await load()).split('\n').find((l) => /"Equipment code"/.test(l) && /ref=/.test(l)) ?? '';
    log.record('playwright snapshot role of the datalist input', line.trim().match(/^- (\w+)/)?.[1] ?? null, 'combobox');
  }
  log.record('playwright fill_form datalist input GEN-35, type textbox', await fillOne('Equipment code', 'GEN-35', 'equipment'), {
    error: null, equipment: 'GEN-35',
  });
  // The type the snapshot's role suggests: fill_form treats combobox as a
  // <select>, so the likeliest first attempt on the datalist fails loudly.
  log.record(
    'playwright fill_form datalist input GEN-35, type combobox',
    await fillOne('Equipment code', 'GEN-35', 'equipment', 'combobox'),
    { error: 'Element is not a <select> element', equipment: '' }
  );
  {
    const snap = await load();
    const r = await pw.call('browser_fill_form', {
      fields: [{ name: 'Streets to close', type: 'combobox', target: ref(snap, 'Streets to close'), value: WANT_NAMES[0] }],
    });
    log.record('playwright fill_form combobox on the listbox', { error: toolError(r), streets: (await values(pw)).streets }, {
      error: null, streets: [WANT[0]],
    });
  }

  {
    const snap = await load();
    await pw.call('browser_select_option', { element: 'Streets to close', target: ref(snap, 'Streets to close'), values: WANT_NAMES });
    await pw.call('browser_fill_form', {
      fields: [
        { name: 'Closure starts', type: 'textbox', target: ref(snap, 'Closure starts'), value: '2027-07-17T07:30' },
        { name: 'Closure ends', type: 'textbox', target: ref(snap, 'Closure ends'), value: '2027-07-17T19:45' },
        { name: 'Amplified sound stops', type: 'textbox', target: ref(snap, 'Amplified sound stops'), value: '21:30' },
        { name: 'Equipment code', type: 'textbox', target: ref(snap, 'Equipment code'), value: 'GEN-35' },
      ],
    });
    const n = posts.length;
    await pw.call('browser_click', { element: 'Continue', target: pw.target(snap, /button "Continue"/) });
    await sleep(500);
    log.record('playwright honest route: what the server parsed', posts.length > n ? await lastPost() : null, {
      streets: WANT, start: '2027-07-17T07:30', end: '2027-07-17T19:45', quiet: '21:30', equipment: 'GEN-35',
      dest: 'document', mode: 'navigate',
    });
    const echo = await pw.snapshot();
    log.record(
      'playwright <dl> check page: the snapshot line carrying the parsed start',
      echo.split('\n').find((l) => l.includes('2027-07-17T07:30'))?.trim().replace(/ \[ref=[^\]]+\]/, '') ?? null,
      '- definition: 2027-07-17T07:30'
    );
  }
  await pw.close();
}

console.log(`\nrunning on: ${running.join(', ')}`);
await probe.close();
log.done();
