// The reporting rules that decide a row's reading without a browser, each
// checked on the case that made it and on the case it must not catch: reach's
// folded and joined matching, the copied-cut rule, the code echo and the
// image-only gate, the malformed-uid and scripted-write counters, script
// recovery, shell assistance, whole-path labels and transcription. It runs no browser
// and no model, so it costs the gate nothing (ruleCheckFailures); on its own:
//
//   node eval/scripts/rule-checks.mjs

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCallRecorder, malformedUid } from '../mcp-tap.mjs';
import { createReachRecorder, reachOf } from '../surface-reach.mjs';
import { shellAssisted } from './row-evidence.mjs';
import { failureClass, labelledValues, labelNames } from './triage.mjs';

// An Agent SDK exchange: each [tool, input, reply, isError, at] a call to the
// firefox server and its tool_result, whose reply is text or a list of
// content blocks, sent at `at` (ms) when given.
function sdkMessages(calls) {
  return calls.flatMap(([tool, input, reply, isError = false, at = null], i) => [
    { type: 'assistant', message: { id: `m${i}`, content: [{ type: 'tool_use', id: `t${i}`, name: `mcp__firefox__${tool}`, input }] } },
    {
      type: 'user',
      ...(at == null ? {} : { timestamp: new Date(at).toISOString() }),
      message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: isError, content: Array.isArray(reply) ? reply : [{ type: 'text', text: reply }] }] },
    },
  ]);
}
const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
const frictionOf = (calls) => {
  const rec = createCallRecorder('firefox');
  for (const m of sdkMessages(calls)) rec.observe(m);
  return rec.summary().friction;
};
const recovered = (calls) => {
  const rec = createCallRecorder('firefox');
  for (const m of sdkMessages(calls)) rec.observe(m);
  return rec.summary().tool_errors.map((e) => e.recovered);
};
const reachRecorder = (reply) => {
  const rec = createReachRecorder();
  for (const m of sdkMessages([['take_snapshot', {}, reply]])) rec.observe(m);
  return rec;
};
const labelled = (answer, path) => labelledValues(answer).some((l) => labelNames(path, l));

const CHECKS = {
  // search-decoy: the answer joins two lines a script returned under keys of
  // their own; the same parts out of order were not shown.
  'reach joins lines': () => {
    const reply = '{"text31": "Bureau of Civic Revenue, Declarations Unit", "text32": "PO Box 4410, Statehouse Plaza Station"}';
    const value = 'Bureau of Civic Revenue, Declarations Unit, PO Box 4410';
    const reversed = 'PO Box 4410, Declarations Unit, Bureau of Civic Revenue';
    return reachOf([value, reversed], reply)[value] === 'seen' && reachOf([reversed], reply)[reversed] !== 'seen';
  },
  'reach undoes YAML doubled quotes': () =>
    reachOf(["Don't miss the harvest sale"], "- paragraph [ref=e5]: 'Don''t miss the harvest sale'")["Don't miss the harvest sale"] === 'seen',
  'reach decodes HTML entities': () =>
    reachOf(['Fish & Chips Friday'], '<p class="menu">Fish &amp; Chips Friday</p>')['Fish & Chips Friday'] === 'seen',
  // news-extract copied firefox-devtools-mcp's 27-character cut; an agent
  // that shortened a title it saw whole wrote a cut no reply holds.
  'copied cut needs a reply that shows it': () =>
    reachRecorder('uid=4_7 link text="I built a spreadsheet that ..."').showsCut('I built a spreadsheet that ...') &&
    !reachRecorder('uid=4_7 link text="I built a spreadsheet that runs my whole week"').showsCut('I built a spreadsheet that ...'),
  'malformed uid read from the argument': () =>
    malformedUid({ uid: 'uid=1_59' }) && malformedUid({ elements: [{ uid: 'e12', value: 'x' }] }) &&
    !malformedUid({ uid: '1_59' }) && !malformedUid({ fromUid: '3_4', toUid: '3_9' }),
  // playwright-mcp reads a target that is no ref as a selector, so roster's
  // "ref=e29" and cabin-dates' pasted snapshot line failed with selector
  // errors, not the stale text; a selector or a frame ref is well formed.
  'malformed playwright ref read from the argument': () =>
    malformedUid({ target: '[ref=e27]' }) && malformedUid({ fields: [{ target: 'ref=e29', value: 'x' }] }) &&
    malformedUid({ target: 'button "Fri Sep 25 - open" [ref=e90]' }) && malformedUid({ startTarget: 'e3', endTarget: '#e9' }) &&
    !malformedUid({ target: 'e27' }) && !malformedUid({ target: 'f2e41' }) && !malformedUid({ target: '#checkin' }) &&
    !malformedUid({ startTarget: 'e3', endTarget: 'e9' }) && !malformedUid({ url: 'http://127.0.0.1:1/e27' }) &&
    frictionOf([['browser_click', { target: '[ref=e27]' }, '### Error\nError: "[ref=e27]" does not match any elements.', true]]).malformed_uid === 1,
  // native-permit's devtools rows set the closure datetimes and the street
  // multi-select by script; a script that reads, and a Playwright script
  // that clicks and fills through locators, write nothing by script.
  'scripted writes read from the script': () =>
    frictionOf([
      ['evaluate_script', { function: "() => { const s = document.querySelector('#streets'); [...s.options].forEach((o) => (o.selected = true)); s.dispatchEvent(new Event('change')); }" }, 'undefined'],
      ['evaluate_script', { function: "() => { document.querySelector('#start').value = '2026-12-19T06:45'; }" }, 'undefined'],
      ['browser_evaluate', { function: "() => document.querySelector('form').requestSubmit()" }, 'undefined'],
      ['browser_run_code_unsafe', { code: "async (page) => { await page.evaluate(() => document.querySelector('#go').click()); }" }, 'ok'],
    ]).scripted_writes === 4 &&
    frictionOf([
      ['evaluate_script', { function: '() => [...document.querySelectorAll("input")].map((e) => e.value)' }, '[]'],
      ['evaluate_script', { function: '() => document.querySelector("#a").value === "x"' }, 'false'],
      ['browser_run_code_unsafe', { code: "async (page) => { await page.getByRole('button', { name: 'Save' }).click(); return page.evaluate(() => document.title); }" }, 'ok'],
      ['click_by_uid', { uid: '1_4' }, 'click 1_4'],
    ]).scripted_writes === 0,
  // pdf-bill: playwright-mcp's reply to a fill echoes the code it ran, the
  // agent's own value included, which is no evidence the page showed it.
  'the code playwright ran is no reply': () => {
    const reply =
      "### Ran Playwright code\n```js\nawait page.getByRole('textbox', { name: 'Bill number' }).fill('GW-B-A034C4');\n```\n" +
      '### Page\n- Page URL: http://127.0.0.1:1/account/reading.html\n### Result\nRe-bill reference RB-EFC9CE';
    const reach = reachRecorder(reply).reach(['GW-B-A034C4', 'RB-EFC9CE']);
    return reach['GW-B-A034C4'] === 'absent' && reach['RB-EFC9CE'] === 'seen';
  },
  // pdf-bill: with the attempt's state, a bill whose page (its token's URL)
  // was never loaded, or loaded only after the last image, is absent, not
  // image-only; without state, any image reply marks it.
  'image-only needs an image after its page loaded': () => {
    const state = {
      sessions: new Map([['s1', { bills: [{ number: 'GW-B-111111', token: 'Tok3nAbC12' }, { number: 'GW-B-222222', token: 'Zz9Yy8Xx7W' }] }]]),
      ledger: [{ path: '/api/utility/bill.pdf?b=Tok3nAbC12', at: 2000 }],
    };
    const values = ['GW-B-111111', 'GW-B-222222'];
    const reachAt = (at, withState = true) => {
      const rec = createReachRecorder();
      for (const m of sdkMessages([['screenshot_page', {}, [IMAGE], false, at]])) rec.observe(m);
      return rec.reach(values, { truth: values, ...(withState ? { state } : {}) });
    };
    const after = reachAt(3000);
    const before = reachAt(1000);
    const stateless = reachAt(1000, false);
    return (
      after['GW-B-111111'] === 'image-only' && after['GW-B-222222'] === 'absent' &&
      before['GW-B-111111'] === 'absent' && stateless['GW-B-222222'] === 'image-only'
    );
  },
  // resend-receipt's answer dropped the last character of the CR-2026-26B0E
  // its listing showed; hovercard-oncall's read PG-8B1956 off a screenshot
  // as PG-881956. A different code of the same shape is no slip.
  'a claim one character off a delivered truth is a transcription': () => {
    const task = { truth: { values: () => ['CR-2026-26B0E', 'PG-8B1956'] } };
    const state = { sessions: new Map() };
    const events = sdkMessages([['take_snapshot', {}, 'uid=3_1 text="Receipt CR-2026-26B0E"'], ['screenshot_page', {}, [IMAGE]]]);
    const cls = (fields, detail) =>
      failureClass({ task: 't', condition: 'firefox-devtools-mcp', success: false, surface_calls: 1, fields, detail }, events, { state, task })?.class;
    return (
      cls({ receipt: 'CR-2026-26B0' }, 'receiptOk=false') === 'transcription' &&
      cls({ receipt: 'CR-2026-26B0E', page: 'PG-881956' }, 'pageOk=false') === 'transcription' &&
      cls({ receipt: 'CR-2026-9F41A' }, 'receiptOk=false') !== 'transcription'
    );
  },
  // brochure-minimal filled through a script the fields a fill tool could
  // not address; a script that only reads recovers no fill.
  'a script recovers only the job its code does': () => {
    const fill = ['fill_by_uid', { uid: '2_3', value: 'Ada' }, 'Element 2_3 is stale/invalid', true];
    const [byWrite] = recovered([fill, ['evaluate_script', { function: '() => { document.querySelector("#name").value = "Ada"; }' }, 'undefined']]);
    const [byRead] = recovered([fill, ['evaluate_script', { function: '() => document.title' }, '"Brochure"']]);
    return byWrite === true && byRead === false;
  },
  // body-only-ref's ref came in a 507 body a shell read with the browser's
  // cookie; a refusal, a cookieless page, a static page and a scripted row's
  // own driver fetches are not assistance.
  'shell assistance needs a graded answer': () => {
    const shell = (path, status, extra = {}) => ({ client: 'shell', method: 'GET', path, status, sid: 's1', ...extra });
    const hit = (ledger, backend) => shellAssisted(ledger, { backend });
    return (
      hit([shell('/api/depot/manifests', 507)])?.requests === 1 &&
      hit([shell('/gov/rv7.html', 200)])?.requests === 1 &&
      !hit([shell('/api/depot/manifests', 403)]) &&
      !hit([shell('/gov/rv7.html', 200, { sid: 'new', minted: true })]) &&
      !hit([shell('/ledger/page-2.html', 200)]) &&
      !hit([{ client: 'browser', dest: 'empty', path: '/api/depot/manifests', status: 507 }]) &&
      !hit([shell('/api/utility/bill.pdf', 200)], 'scripted')
    );
  },
  // price-compare: the winner's "**Price:**" names no Gadgetron price, which
  // a heading or label naming the store does.
  'a label names the whole field path': () =>
    !labelled('**Cheapest store:** Marrowgate\n**Price:** $274.50', 'perStore.Gadgetron.price') &&
    labelled('**Gadgetron:**\n- Price: $281.00', 'perStore.Gadgetron.price') &&
    labelled('Gadgetron price: $281.00', 'perStore.Gadgetron.price'),
};

// The names of the checks that fail.
export function ruleCheckFailures() {
  return Object.entries(CHECKS)
    .filter(([, check]) => {
      try {
        return !check();
      } catch {
        return true;
      }
    })
    .map(([name]) => name);
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const failed = ruleCheckFailures();
  for (const name of failed) console.error(`rule check failed: ${name}`);
  console.log(`${Object.keys(CHECKS).length - failed.length}/${Object.keys(CHECKS).length} reporting rule checks pass`);
  process.exit(failed.length ? 1 : 0);
}
