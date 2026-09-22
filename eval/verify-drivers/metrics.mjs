// Golden path for T115 chart-escape (pages/metrics/). The graded figure is only
// ever drawn to a canvas, so the point of the task is finding the alternate
// representation every real dashboard ships. This driver takes the primary one —
// the "Table" toggle — and reads the rendered table back through the snapshot,
// never through evaluate_script, so a green run means our tool surface alone can
// win it.
//
// Two measured properties of that surface:
//   - the DEFAULT snapshot drops the whole <table>: after the toggle the only
//     new line is "18 monthly points, oldest f...". includeAll emits the rows;
//   - 18 rows push the page past the default line budget, so includeAll alone
//     shows the first ten months and silently cuts the rest. Both have to be set.
// Neither is worked around in the fixture.

import { addSession, findSession, textOf, uidOf, until } from './lib.mjs';

const PATH = '/metrics/';

const ROW = /th text="([A-Z][a-z]{2} \d{4})"\n\s*uid=\S+ td text="([\d,]+)"/g;

async function readTable(mcp) {
  const snap = textOf(await mcp('take_snapshot', { includeAll: true, maxLines: 600 }));
  const rows = [];
  for (const match of snap.matchAll(ROW)) {
    rows.push({ label: match[1], value: Number(match[2].replace(/,/g, '')) });
  }
  return rows;
}

export const DRIVERS = {
  'chart-escape': {
    note: 'canvas-only metric: takes the Table toggle, reads rows via includeAll+maxLines',
    alsoCorrectState: [
      {
        // Every session mints its own series, so a probe's target differs.
        name: 'a stray session minted first reads its own series',
        mutate(state) {
          const { session } = findSession(state, (s) => s.metrics);
          const m = session.metrics;
          addSession(
            state,
            {
              metrics: {
                ...m,
                points: m.points.map((p) => ({ ...p, value: p.value + 7 })),
                target: { ...m.target, value: m.target.value + 7, from: m.target.from + 7 },
                runnerUp: { ...m.runnerUp, value: m.runnerUp.value + 7, from: m.runnerUp.from + 7 },
                seriesReads: 1,
                directReads: 1,
                tableViews: 0,
                csvReads: 0,
              },
            },
            { first: true }
          );
        },
      },
    ],
    async run({ goto, mcp, snapshot }) {
      await goto(PATH);
      const chartSnap = await until('the seat series to load', async () => {
        const snap = await snapshot();
        return snap.includes('button "Table"') && !snap.includes('text="loading"') ? snap : null;
      }, { gap: 400 });
      if (!chartSnap.includes('a "Export CSV"')) {
        throw new Error('the CSV escape hatch is missing from the panel header');
      }
      const toggle = uidOf(chartSnap, 'button "Table"');
      if (!toggle) throw new Error('no Table toggle in the snapshot');
      await mcp('click_by_uid', { uid: toggle });

      const rows = await until('the table view to render 18 rows', async () => {
        const found = await readTable(mcp);
        return found.length === 18 ? found : null;
      }, { gap: 400 });

      let target = null;
      let runnerUp = null;
      for (let i = 1; i < rows.length; i++) {
        const fall = { at: i, drop: rows[i - 1].value - rows[i].value, from: rows[i - 1] };
        if (!target || fall.drop > target.drop) {
          runnerUp = target;
          target = fall;
        } else if (!runnerUp || fall.drop > runnerUp.drop) {
          runnerUp = fall;
        }
      }
      if (!target || target.drop <= 0) throw new Error('no month-over-month fall in the series');
      const month = rows[target.at];
      const second = rows[runnerUp.at];
      // The fixture's whole point: the two deepest falls are within a couple of
      // pixels of each other, and the winning figure is nowhere on the chart view.
      const margin = target.drop - runnerUp.drop;
      if (margin <= 0 || margin > 200) {
        throw new Error(`the two deepest falls are ${margin} seats apart, not a pixel apart`);
      }
      if (chartSnap.includes(month.value.toLocaleString('en-GB'))) {
        throw new Error(`${month.value} leaked into the chart view snapshot`);
      }
      // Not the runner-up on its own — the validator rejects that on the figure
      // alone. The phrasing worth keeping covered is the hedge a coin-flip agent
      // produces: pick the runner-up, quote the real answer as the close second.
      this.wrong =
        `${second.label} is my answer, with Active seats at ` +
        `${second.value.toLocaleString('en-GB')}; ${month.label} at ` +
        `${month.value.toLocaleString('en-GB')} is a close second.`;
      const answer =
        `Active seats fell furthest in ${month.label}, to ${month.value.toLocaleString('en-GB')} ` +
        `seats — down ${target.drop.toLocaleString('en-GB')} on ${target.from.label} ` +
        `(${target.from.value.toLocaleString('en-GB')}). The chart cannot settle it: ` +
        `${second.label} fell ${runnerUp.drop.toLocaleString('en-GB')}, ` +
        `only ${margin} seats less, so I read the exact figures from the Table view.`;

      // The series carries a deliberately planted single-month RISE. Describing it
      // with a superlative is ordinary analysis, so it must pass: a `claim` regex
      // that matches bare "largest" reads the sentence as asserting a rival
      // deepest FALL. The direction gate must not extend to an explicit
      // designation, so the second `wrong` string below — which names the wrong
      // month as the answer while talking about a climb — has to stay failing.
      let rise = null;
      for (let i = 1; i < rows.length; i++) {
        const gain = rows[i].value - rows[i - 1].value;
        if (gain > 0 && (!rise || gain > rise.gain)) rise = { gain, at: i };
      }
      if (rise) {
        const risen = rows[rise.at];
        this.alsoCorrect = [
          `${answer} For context the largest single-month increase in the window was ` +
            `${risen.label}, up ${rise.gain.toLocaleString('en-GB')} seats.`,
        ];
        this.wrong = [
          this.wrong,
          `My answer is ${risen.label}, where Active seats climbed the most. ` +
            `${month.label} sits at ${month.value.toLocaleString('en-GB')}.`,
        ];
      }
      const fields = { month: month.label, activeSeats: month.value };
      const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
        'August', 'September', 'October', 'November', 'December'];
      const parts = (label) => {
        const [mon, year] = label.split(' ');
        const m = FULL.findIndex((f) => f.startsWith(mon));
        return { mon, full: FULL[m], mm: String(m + 1).padStart(2, '0'), year: Number(year) };
      };
      const t = parts(month.label);
      const r = parts(second.label);
      const otherYear = t.year === 2026 ? 2025 : 2026;
      const yy = String(t.year).slice(2);
      const otherYY = String(otherYear).slice(2);
      this.wrongFields = [
        { month: second.label, activeSeats: second.value },
        { month: month.label, activeSeats: second.value },
        { month: month.label, activeSeats: null },
        // A wrong month beside the target's exact figure, so each fails on the
        // month alone.
        { month: second.label, activeSeats: month.value },
        { month: target.from.label, activeSeats: month.value },
        { month: `${t.mon} ${otherYear}`, activeSeats: month.value },
        { month: `${t.mon} '${otherYY}`, activeSeats: month.value },
        { month: `${t.mon}-${otherYY}`, activeSeats: month.value },
        { month: `${t.mon} ${otherYY}`, activeSeats: month.value },
        { month: `${r.mm}/${r.year}`, activeSeats: month.value },
        // The runner-up's month may be the target's in the other year; the
        // prior month keeps the case count fixed across draws.
        { month: r.full === t.full ? parts(target.from.label).full : r.full, activeSeats: month.value },
      ];
      // The ask never asks for a year, and the exact figure already names one
      // point, so a yearless month, a two-digit year (the axis ticks' own
      // "Mar'25") and a numeric month all pass, as does a field that names the
      // answer first and the month it fell from after.
      this.alsoCorrectFields = [
        fields,
        { month: month.label.toLowerCase(), activeSeats: month.value },
        { month: t.full, activeSeats: month.value },
        { month: `${t.mon} '${yy}`, activeSeats: month.value },
        { month: `${t.mon}'${yy}`, activeSeats: month.value },
        { month: `${t.mon}-${yy}`, activeSeats: month.value },
        { month: `${t.mon} ${yy}`, activeSeats: month.value },
        { month: `${t.mm}/${t.year}`, activeSeats: month.value },
        { month: `${t.year}-${t.mm}`, activeSeats: month.value },
        { month: `${month.label} (down from ${target.from.label})`, activeSeats: month.value },
      ];
      return { text: answer, fields };
    },
  },
};
