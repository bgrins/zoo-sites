// Golden path for T114 formula-repair (pages/calc/, the Abaca workbook).
//
// Driven entirely through the snapshot surface — take_snapshot / click_by_uid /
// fill_by_uid, no evaluate_script — because the point of the task is whether the
// dual representation of a cell (value in the grid, formula in the formula bar)
// reaches us at all. It does NOT for the grid: the sheet is a <table>, which the
// walker drops wholesale, so every number on this page is invisible to us. It
// DOES for the formula bar, because the walker reads the `value` DOM property of
// inputs. The route below is the only snapshot-visible one: the formula-audit
// pane's flag buttons select cells, and the formula bar then shows each flagged
// cell's definition one at a time.

import { bumpCode, uidOf } from './lib.mjs';

function flagButtons(snap) {
  return [...snap.matchAll(/uid=(\S+) button "([A-E]\d{1,2})"/g)].map((m) => ({
    uid: m[1],
    ref: m[2],
  }));
}

function formulaBar(snap) {
  const m = /uid=(\S+) input "Formula bar" value="([^"]*)"/.exec(snap);
  return m ? { uid: m[1], value: m[2] } : { uid: uidOf(snap, 'input "Formula bar"'), value: '' };
}

function nameBox(snap) {
  const m = /uid=(\S+) input "Cell reference" value="([^"]*)"/.exec(snap);
  return m ? { uid: m[1], value: m[2] } : { uid: null, value: '' };
}

// The cells a correct formula for `ref` has to cover: a depot quarter cell adds
// its three months, the all-depots row adds its column.
function requiredRefs(ref) {
  const col = ref[0];
  const row = Number(ref.slice(1));
  if (row === 14) {
    return Array.from({ length: 12 }, (_, i) => `${col}${i + 2}`);
  }
  return ['B', 'C', 'D'].map((c) => c + row);
}

function refsIn(formula) {
  const covered = new Set();
  const src = formula.replace(/\$/g, '').toUpperCase();
  let rest = src;
  for (const m of src.matchAll(/([A-E])(\d+)\s*:\s*([A-E])(\d+)/g)) {
    const [c1, c2] = [m[1].charCodeAt(0), m[3].charCodeAt(0)].sort((a, b) => a - b);
    const [r1, r2] = [Number(m[2]), Number(m[4])].sort((a, b) => a - b);
    for (let c = c1; c <= c2; c += 1) {
      for (let r = r1; r <= r2; r += 1) covered.add(String.fromCharCode(c) + r);
    }
    rest = rest.replace(m[0], ' ');
  }
  for (const m of rest.matchAll(/\b([A-E])(\d+)\b/g)) covered.add(m[1] + m[2]);
  return covered;
}

export const DRIVERS = {
  'formula-repair': {
    note: 'snapshot-only: the grid is invisible (table), the formula bar is not',
    wrong: [
      'The workbook total was short because the August column total in C14 used a split ' +
        'range. I replaced it with =SUM(C2:C13) and the sheet reconciles now.',
    ],
    async run({ goto, mcp, snapshot, sleep }) {
      await goto('/calc/');

      let snap = '';
      for (let i = 0; i < 150; i += 1) {
        snap = await snapshot();
        if (flagButtons(snap).length >= 8 && /Ledger control total/.test(snap)) break;
        await sleep(200);
      }
      const flags = flagButtons(snap).map((f) => f.ref);
      if (flags.length < 8) throw new Error(`formula audit listed ${flags.length} flags, expected 8`);
      if (/Ardsley|Havenscar|Lowdham/.test(snap)) {
        throw new Error('grid text unexpectedly present in the snapshot; fixture markup changed');
      }

      // Open each flagged cell in the formula bar and keep the one whose formula
      // does not cover everything that cell is supposed to add.
      let culprit = null;
      // The name box updates synchronously on selection while the formula bar is
      // filled from an async read, so "the name box says E7" is not proof the bar
      // has caught up: wait for the text to actually change as well. Every seeded
      // formula on this sheet is distinct, so that is unambiguous.
      let shown = null;
      for (const ref of flags) {
        const fresh = await snapshot();
        const button = flagButtons(fresh).find((f) => f.ref === ref);
        if (!button) throw new Error(`flag button for ${ref} vanished`);
        await mcp('click_by_uid', { uid: button.uid });
        let bar = { value: '' };
        for (let i = 0; i < 150; i += 1) {
          const after = await snapshot();
          bar = formulaBar(after);
          if (nameBox(after).value === ref && bar.value.startsWith('=') && bar.value !== shown) {
            break;
          }
          await sleep(200);
        }
        if (!bar.value.startsWith('=') || bar.value === shown) {
          throw new Error(`no formula shown for ${ref}`);
        }
        shown = bar.value;
        if (bar.value.endsWith('...')) {
          throw new Error(`formula for ${ref} was truncated by the snapshot: ${bar.value}`);
        }
        const covered = refsIn(bar.value);
        if (!requiredRefs(ref).every((r) => covered.has(r))) culprit = { ref, formula: bar.value };
      }
      if (!culprit) throw new Error(`none of ${flags.join(',')} dropped data`);

      const col = culprit.ref[0];
      const row = Number(culprit.ref.slice(1));
      const fix = row === 14 ? `=SUM(${col}2:${col}13)` : `=SUM(B${row}:D${row})`;

      // Re-select the culprit through the name box, so the repair is committed to
      // the cell the formula bar is actually pointing at.
      let live = await snapshot();
      if (nameBox(live).value !== culprit.ref) {
        await mcp('fill_by_uid', { uid: nameBox(live).uid, value: culprit.ref });
        live = await snapshot();
        await mcp('click_by_uid', { uid: uidOf(live, 'button "Go to"') });
      }

      // Wait for the CELL READ to land in the formula bar before typing over it.
      // The name box is set synchronously when a cell is selected, but the bar is
      // filled from an async fetch, so matching on the name box alone would race
      // the page and let the fetch clobber the repair.
      let bar = { uid: null, value: '' };
      for (let i = 0; i < 150; i += 1) {
        live = await snapshot();
        bar = formulaBar(live);
        if (nameBox(live).value === culprit.ref && bar.value === culprit.formula) break;
        await sleep(200);
      }
      if (bar.value !== culprit.formula) {
        throw new Error(`formula bar never settled on ${culprit.ref}: ${bar.value}`);
      }

      await mcp('fill_by_uid', { uid: bar.uid, value: fix });
      live = await snapshot();
      await mcp('click_by_uid', { uid: uidOf(live, 'button "Enter"') });

      let checksum = null;
      for (let i = 0; i < 150; i += 1) {
        const after = await snapshot();
        checksum = /RC-[0-9A-F]{6}/.exec(after)?.[0] ?? null;
        if (checksum && /text="Reconciled"/.test(after)) break;
        await sleep(200);
      }
      if (!checksum) throw new Error('the workbook never issued a reconciliation checksum');

      const fields = { cellReference: culprit.ref, checksum };
      this.wrongFields = [
        { cellReference: culprit.ref, checksum: 'RC-000000' },
        { cellReference: 'B2', checksum },
      ];
      this.alsoCorrectFields = [
        fields,
        { cellReference: `$${culprit.ref[0]}$${culprit.ref.slice(1)}`, checksum: checksum.slice(3) },
      ];
      const decoyFlag = flags.find((ref) => ref !== culprit.ref);
      this.wrong = [
        this.wrong[0],
        `The audit flag on ${decoyFlag} was the fault; after tidying that formula ` +
          `the sheet reconciled with checksum ${checksum}.`,
        `I repaired ${culprit.ref} and the workbook reconciled; the checksum is ` +
          `${bumpCode(checksum)}.`,
      ];
      this.alsoCorrect = [
        `Cell corrected: ${culprit.ref}\nNew formula: ${fix}\nReconciliation checksum: ${checksum}`,
        `${culprit.ref} held ${culprit.formula}, which leaves part of its range out ` +
          `of the sum; with ${fix} in place the ledger control total matches and the ` +
          `workbook issued checksum ${checksum}.`,
        `The corrected cell is $${col}$${row}; the reconciliation checksum reads ` +
          `${checksum.toLowerCase()}.`,
      ];
      return {
        text:
          `The quarter total was short because ${culprit.ref} held ${culprit.formula}, which leaves ` +
          `data out of the sum. I replaced it with ${fix}; the workbook now agrees with the ledger ` +
          `control total, all twelve depot rows and all four column totals reconcile, and the ` +
          `reconciliation checksum is ${checksum}.`,
        fields,
      };
    },
  },
};
