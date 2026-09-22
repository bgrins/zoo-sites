// Probes native form controls (date, time, datetime-local, range, select, select[multiple], datalist) through each condition's fill tools; measured on firefox-devtools-mcp 0.9.15 and 0.10.3 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).

import { findings, page, probeServer, surface } from './lib.mjs';

const probe = await probeServer({
  '/controls': page(
    'Controls',
    `<form>
     <label for="d">Pickup date</label> <input type="date" id="d">
     <label for="tm">Start time</label> <input type="time" id="tm" step="900">
     <label for="dt">Closure starts</label> <input type="datetime-local" id="dt">
     <label for="rg">Volume</label> <input type="range" id="rg" min="0" max="100" value="50">
     <label for="one">Borough</label> <select id="one"><option>Aldmoor</option><option>Brisk Hill</option></select>
     <label for="many">Regions</label> <select id="many" multiple size="5"><option>North</option><option>South</option><option>East</option><option>West</option><option>Central</option></select>
     <label for="dl">Commodity</label> <input id="dl" list="codes"><datalist id="codes"><option value="0303.11 Sockeye salmon, frozen"><option value="0303.12 Other Pacific salmon"></datalist>
     </form>`
  ),
});
const log = findings('Native form controls per condition');
const values = (s) =>
  s.evaluate(() => ({
    d: document.getElementById('d').value,
    tm: document.getElementById('tm').value,
    dt: document.getElementById('dt').value,
    rg: document.getElementById('rg').value,
    one: document.getElementById('one').value,
    many: [...document.getElementById('many').selectedOptions].map((o) => o.value),
    dl: document.getElementById('dl').value,
  }));
// A failed call's own message, without playwright's call log or the uid.
const toolError = (r) =>
  /^(ERROR|THROW)/.test(r)
    ? (r.match(/Error: (?:browserBackend\.callTool: )?(?:Error: )?([^\n]+)/)?.[1] ?? r.split('\n')[0]).slice(0, 60)
    : null;

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/controls');
await pw.navigate(probe.url + '/controls');
await log.header(dt, pw);

{
  const fill = async (label, value) => {
    await dt.navigate(probe.url + '/controls');
    const snap = await dt.snapshot();
    const r = await dt.call('fill_by_uid', { uid: dt.target(snap, new RegExp(`"${label}"`)), value });
    return { error: toolError(r), ...(await values(dt)) };
  };
  const pick = (v, key) => ({ error: v.error, [key]: v[key] });
  log.record('devtools fill date ISO', pick(await fill('Pickup date', '2027-03-04'), 'd'), { error: null, d: '2027-03-04' });
  log.record('devtools fill date as typed (03/04/2027)', pick(await fill('Pickup date', '03/04/2027'), 'd'), { error: null, d: '' });
  log.record('devtools fill time 14:30', pick(await fill('Start time', '14:30'), 'tm'), { error: null, tm: '14:30' });
  log.record('devtools fill datetime-local ISO', pick(await fill('Closure starts', '2027-03-04T15:00'), 'dt'), { error: null, dt: '7030-02-02T04:15' });
  log.record('devtools fill datetime-local as typed', pick(await fill('Closure starts', '03/04/2027 03:00 PM'), 'dt'), { error: null, dt: '2027-03-04T15:00' });
  log.record('devtools fill range 70', pick(await fill('Volume', '70'), 'rg'), { error: null, rg: '50' });
  log.record('devtools fill select "Brisk Hill"', pick(await fill('Borough', 'Brisk Hill'), 'one'), { error: null, one: 'Brisk Hill' });
  log.record('devtools fill select[multiple] "South"', pick(await fill('Regions', 'South'), 'many'), { error: null, many: ['South'] });
  {
    const snap = await dt.snapshot();
    const uid = dt.target(snap, /"Regions"/);
    const after = async (value) => {
      await dt.call('fill_by_uid', { uid, value });
      return (await values(dt)).many;
    };
    log.record(
      'devtools fill select[multiple] "West", then "Nowhere", then ""',
      [await after('West'), await after('Nowhere'), await after('')],
      [['West'], ['North'], ['North', 'South', 'East', 'West', 'Central']]
    );
  }
  log.record(
    'devtools fill datalist input',
    pick(await fill('Commodity', '0303.11 Sockeye salmon, frozen'), 'dl'),
    { error: null, dl: '0303.11 Sockeye salmon, frozen' }
  );
}

{
  const load = async () => {
    await pw.navigate(probe.url + '/controls');
    return pw.snapshot();
  };
  const form = async (label, type, value) => {
    const snap = await load();
    const r = await pw.call('browser_fill_form', {
      fields: [{ name: label, type, target: pw.target(snap, new RegExp(`"${label}"`)), value }],
    });
    return { error: toolError(r), ...(await values(pw)) };
  };
  const type = async (label, text) => {
    const snap = await load();
    const r = await pw.call('browser_type', { element: label, target: pw.target(snap, new RegExp(`"${label}"`)), text });
    return { error: toolError(r), ...(await values(pw)) };
  };
  const pick = (v, key) => ({ error: v.error, [key]: v[key] });
  log.record('playwright fill_form date ISO', pick(await form('Pickup date', 'textbox', '2027-03-04'), 'd'), { error: null, d: '2027-03-04' });
  log.record('playwright type date as typed (03/04/2027)', pick(await type('Pickup date', '03/04/2027'), 'd'), {
    error: 'Malformed value', d: '',
  });
  log.record('playwright fill_form time 14:30', pick(await form('Start time', 'textbox', '14:30'), 'tm'), { error: null, tm: '14:30' });
  log.record('playwright fill_form datetime-local ISO', pick(await form('Closure starts', 'textbox', '2027-03-04T15:00'), 'dt'), {
    error: null, dt: '2027-03-04T15:00',
  });
  log.record('playwright type datetime-local as typed', pick(await type('Closure starts', '03/04/2027 03:00 PM'), 'dt'), {
    error: 'Malformed value', dt: '',
  });
  log.record('playwright fill_form slider 70', pick(await form('Volume', 'slider', '70'), 'rg'), { error: null, rg: '70' });
  log.record('playwright fill_form combobox "Brisk Hill"', pick(await form('Borough', 'combobox', 'Brisk Hill'), 'one'), {
    error: null, one: 'Brisk Hill',
  });
  const snap = await load();
  const r = await pw.call('browser_select_option', {
    element: 'Regions', target: pw.target(snap, /"Regions"/), values: ['South', 'West'],
  });
  log.record('playwright select_option multiple South+West', { error: toolError(r), many: (await values(pw)).many }, {
    error: null, many: ['South', 'West'],
  });
}

await dt.close();
await pw.close();
await probe.close();
log.done();
