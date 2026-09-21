// The reporting rules that decide a row's reading without a browser, each
// checked on the case that made it and on the case it must not catch: reach's
// folded and joined matching, the copied-cut rule, the malformed-uid counter,
// script recovery, shell assistance and whole-path labels. It runs no browser
// and no model, so it costs the gate nothing (ruleCheckFailures); on its own:
//
//   node eval/scripts/rule-checks.mjs

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCallRecorder, malformedUid } from '../mcp-tap.mjs';
import { createReachRecorder, reachOf } from '../surface-reach.mjs';
import { shellAssisted } from './row-evidence.mjs';
import { labelledValues, labelNames } from './triage.mjs';

// An Agent SDK exchange: each [tool, input, reply, isError] a call to the
// firefox server and its tool_result.
function sdkMessages(calls) {
  return calls.flatMap(([tool, input, reply, isError = false], i) => [
    { type: 'assistant', message: { id: `m${i}`, content: [{ type: 'tool_use', id: `t${i}`, name: `mcp__firefox__${tool}`, input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: isError, content: [{ type: 'text', text: reply }] }] } },
  ]);
}
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
