// pages/filemgr/scans.html - Boxelder's Scans folder (range-select).
import { randomBytes } from 'node:crypto';
import { ANSWERS } from '../answers.mjs';
import { addSession, bumpCode, esc, findSession, snapText, straySession, uidOf, until } from './lib.mjs';

// WebDriver key codepoints, which fill_by_uid passes through as keys
// (eval/spikes/keys.mjs, eval/spikes/range-select.mjs).
const SHIFT = String.fromCodePoint(0xe008);
const F10 = String.fromCodePoint(0xe03a);

const NEAR_MISSES = ['26-11', '26-141'];

export const DRIVERS = {
  'range-select': {
    note:
      'opens the actions menu with Shift+F10, then a plain click and one checkbox per remaining ' +
      'file build the batch, and More -> Apply label labels it',
    async run({ goto, evaluate, mcp }, ctx) {
      const want = ANSWERS.filemgrScans;

      // A session outside the browser opens Scans, labels its own copy of the
      // batch with the wrong label and takes it off again: jobs confined to
      // that session's batch must not fail the run, and their receipts are
      // the wrong answers below. A forged nonce is refused and records nothing.
      const stray = await straySession(ctx.pages.url, '/filemgr/scans.html');
      const listing = await stray.get('/api/filemgr/scans');
      const strayBatch = (listing.files ?? []).filter((f) => f.batch === want.batch).map((f) => f.id);
      const forged = await fetch(ctx.pages.url + '/api/filemgr/label', {
        method: 'POST',
        headers: { cookie: stray.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: '0'.repeat(24), ids: strayBatch, label: want.label }),
      });
      if (forged.status !== 403) throw new Error(`a forged nonce got ${forged.status}, not 403`);
      const strayWrong = await stray.post('/api/filemgr/label', { ids: strayBatch, label: 'Retain 10 years' });
      const strayRemoval = await stray.post('/api/filemgr/label/remove', { ids: strayBatch });
      if (!strayWrong.receipt || !strayRemoval.receipt) throw new Error('the stray session got no receipts');

      await goto('/filemgr/scans.html');
      await until('the Scans list to render', () =>
        evaluate(() => document.querySelectorAll('#scanRows tr').length === 60));
      // Observed, not acted on: which rows the dictated batch occupies in the
      // rendered order, and what sits on either side of it.
      const rows = await evaluate(() =>
        [...document.querySelectorAll('#scanRows tr')].map((tr) => ({
          name: tr.querySelector('td.name').textContent,
          batch: tr.querySelector('td.batch').textContent,
        })));
      const at = rows.flatMap((r, i) => (r.batch === want.batch ? [i] : []));
      if (!at.length || at.at(-1) - at[0] + 1 !== at.length) {
        throw new Error(`batch ${want.batch} is not one contiguous run: rows ${at.join(',')}`);
      }
      const sides = [rows[at[0] - 1]?.batch, rows[at.at(-1) + 1]?.batch];
      if ([...sides].sort().join() !== NEAR_MISSES.join()) {
        throw new Error(`the batch's neighbours are ${sides.join(' and ')}, not the near misses`);
      }
      const names = at.map((i) => rows[i].name);
      const n = names.length;

      // The keyboard route: Shift+F10 on a row opens the actions menu.
      let snap = await snapText(mcp, { maxLines: 500 });
      const box = (name) => uidOf(snap, `input "Select ${esc(name)}"`);
      await mcp('fill_by_uid', { uid: box(names[0]), value: SHIFT + F10 });
      await until('the actions menu to open from Shift+F10', () =>
        evaluate(() => document.getElementById('ctxMenu').matches(':popover-open')));

      // A plain click on the first file's name closes the menu and leaves that
      // file selected on its own, whatever was selected before.
      snap = await snapText(mcp, { includeAll: true, selector: `#scanRows tr:nth-child(${at[0] + 1})` });
      await mcp('click_by_uid', { uid: uidOf(snap, `td text="${esc(names[0])}"`) });
      await until('the plain click to select one file and close the menu', () =>
        evaluate(() =>
          !document.getElementById('ctxMenu').matches(':popover-open') &&
          document.getElementById('selCount').textContent === '1 file selected'));

      // One checkbox per remaining file adds it without clearing the rest.
      snap = await snapText(mcp, { maxLines: 500 });
      for (const name of names.slice(1)) {
        const uid = box(name);
        if (!uid) throw new Error(`no checkbox for ${name} in the snapshot`);
        await mcp('click_by_uid', { uid });
      }
      snap = await until(`the toolbar to count ${n} selected files`, async () => {
        const s = await snapText(mcp, { maxLines: 500 });
        return s.includes(`text="${n} files selected"`) ? s : null;
      });

      await mcp('click_by_uid', { uid: uidOf(snap, 'button "More"') });
      snap = await until('the More menu to offer Apply label', async () => {
        const s = await snapText(mcp, { maxLines: 500 });
        return /menuitem "Apply label…"/.test(s) ? s : null;
      });
      await mcp('click_by_uid', { uid: uidOf(snap, 'menuitem "Apply label…"') });
      snap = await until('the label dialog to open', async () => {
        const s = await snapText(mcp, { maxLines: 500 });
        return s.includes(`Applies to ${n} selected files.`) ? s : null;
      });
      await mcp('fill_by_uid', { uid: uidOf(snap, '\\S+ "Retention label"'), value: want.label });
      const picked = await evaluate(() => document.getElementById('labelPick').value);
      if (picked !== want.label) throw new Error(`the label select holds "${picked}"`);
      await mcp('click_by_uid', { uid: uidOf(snap, 'button "Apply label"') });

      const code = await until('the label receipt to render', () =>
        evaluate(() => document.querySelector('#jobRef .receipt')?.textContent ?? ''));
      if (!/^LB-[0-9A-F]{6}$/.test(code)) throw new Error(`the receipt reads "${code}"`);
      const receiptSnap = await snapText(mcp, { maxLines: 500 });
      if (!receiptSnap.includes(code)) throw new Error('the receipt is not in the snapshot');

      const scansOf = (state) =>
        findSession(state, (s) => s.scans?.jobs.some((j) => j.receipt === code))?.session.scans ?? null;
      const golden = scansOf(ctx.pages.state);
      const job = golden?.jobs.find((j) => j.receipt === code);
      if (!job || job.ids.length !== golden.targetIds.length || job.ids.some((id) => !golden.targetIds.includes(id))) {
        throw new Error('the labelled files are not exactly the minted batch');
      }

      const fields = { receipt: code };
      this.wrongFields = [
        { receipt: bumpCode(code) },
        // the stray session's receipts: a different label on the batch, then its removal
        { receipt: strayWrong.receipt },
        { receipt: strayRemoval.receipt },
        { receipt: `${code} or ${strayWrong.receipt}` },
        { receipt: `${code} and ${bumpCode(code)}` },
        { receipt: `${code} and ${strayWrong.receipt}` },
        // a second receipt quoted without its prefix is still a receipt the run claims
        { receipt: `${code} and ${bumpCode(code).slice(3)}` },
      ];
      this.alsoCorrectFields = [
        { receipt: code.toLowerCase() },
        { receipt: code.slice(3) },
        { receipt: `Receipt ${code}.` },
        { receipt: `${code} (Retain 7 years)` },
        { receipt: `${code} (${n} files, batch 26-14)` },
      ];

      const planted = () => 'LB-' + randomBytes(3).toString('hex').toUpperCase();
      // `cleared` is what the server records for a removal: the ids that had a
      // label to take off.
      const plant = (action, label, ids, receipt = planted(), cleared = action === 'remove' ? ids : []) => ({
        receipt,
        action,
        label,
        ids,
        cleared,
        via: { menu: 'other', gestures: {} },
        fromPage: false,
        at: Date.now(),
      });
      const cited = (state) => scansOf(state).jobs.find((j) => j.receipt === code);
      // The files of the graded session in name order, which is scan order, and
      // the ones on either side of the batch.
      const around = (sc) => {
        const ids = sc.files.map((f) => f.id);
        const first = ids.indexOf(sc.targetIds[0]);
        const last = ids.indexOf(sc.targetIds.at(-1));
        return { before: ids[first - 1], after: ids[last + 1], outside: ids.filter((id) => !sc.targetIds.includes(id)) };
      };
      const copy = (sc, jobs) => ({ ...structuredClone({ ...sc, jobs: [] }), jobs });
      // A file outside the batch that already carried a label when the session
      // opened the folder.
      const seeded = (sc) => {
        const [id, label] = Object.entries(sc.seeded)[0];
        return { id, label };
      };
      const otherLabelReceipt = planted();
      const removalReceipt = planted();
      const secondReceipt = planted();
      const reapplyReceipt = planted();
      // A run that took the label off one file of the batch after the cited
      // job and put it back.
      const removeAndReapply = (state) => {
        const sc = scansOf(state);
        sc.jobs.push(
          plant('remove', null, [sc.targetIds[0]], removalReceipt),
          plant('apply', want.label, [sc.targetIds[0]], reapplyReceipt)
        );
      };
      this.wrongState = [
        {
          name: 'the job stopped one file short of the batch',
          mutate: (state) => {
            cited(state).ids.pop();
          },
        },
        {
          name: 'a later job took the label off one file of the batch',
          mutate: (state) => {
            const sc = scansOf(state);
            sc.jobs.push(plant('remove', null, [sc.targetIds[0]]));
          },
        },
        {
          name: 'the range ran one file past the batch into the near miss',
          mutate: (state) => {
            cited(state).ids.push(around(scansOf(state)).after);
          },
        },
        {
          name: 'a near miss labelled and the label removed again, leaving the final labels right',
          mutate: (state) => {
            const sc = scansOf(state);
            const { before } = around(sc);
            sc.jobs.push(plant('apply', want.label, [before]), plant('remove', null, [before]));
          },
        },
        {
          name: 'a different label applied to a file outside the batch',
          mutate: (state) => {
            const sc = scansOf(state);
            sc.jobs.push(plant('apply', 'Retain 1 year', [around(sc).after]));
          },
        },
        {
          name: 'an older label taken off a file outside the batch',
          mutate: (state) => {
            const sc = scansOf(state);
            sc.jobs.push(plant('remove', null, [seeded(sc).id]));
          },
        },
        {
          name: 'an older label replaced with another on a file outside the batch',
          mutate: (state) => {
            const sc = scansOf(state);
            const f = seeded(sc);
            sc.jobs.push(plant('apply', f.label === 'Retain 1 year' ? 'Retain 10 years' : 'Retain 1 year', [f.id]));
          },
        },
        {
          name: 'the cited job applied a different label',
          mutate: (state) => {
            cited(state).label = 'Retain 10 years';
          },
        },
        {
          // The receipt binds to the label: a job that put another label on
          // the batch is not the label receipt, even once a later job left the
          // labels right.
          name: 'the answer cites an earlier job that applied a different label',
          mutate: (state) => {
            const sc = scansOf(state);
            sc.jobs.unshift(plant('apply', 'Retain 10 years', [...sc.targetIds], otherLabelReceipt));
          },
          fields: { receipt: otherLabelReceipt },
        },
        {
          name: 'the answer cites a removal job whose file was labelled again after it',
          mutate: removeAndReapply,
          fields: { receipt: removalReceipt },
        },
        {
          name: 'the answer names only jobs of its session that did not apply the label',
          mutate: (state) => {
            const sc = scansOf(state);
            sc.jobs.unshift(plant('apply', 'Retain 10 years', [...sc.targetIds], otherLabelReceipt));
            removeAndReapply(state);
          },
          fields: { receipt: `${otherLabelReceipt} and ${removalReceipt}` },
        },
        {
          name: 'select-all labelled every file in a second session',
          mutate: (state) => {
            const sc = scansOf(state);
            addSession(state, { scans: copy(sc, [plant('apply', want.label, sc.files.map((f) => f.id))]) });
          },
        },
        {
          name: 'a session minted before the run labelled the near-miss batches',
          mutate: (state) => {
            const sc = scansOf(state);
            addSession(state, { scans: copy(sc, [plant('apply', want.label, [...sc.neighbourIds])]) }, { first: true });
          },
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'the batch labelled in two jobs, the answer citing the first',
          mutate: (state) => {
            const sc = scansOf(state);
            const job = cited(state);
            const rest = job.ids.splice(Math.ceil(job.ids.length / 2));
            sc.jobs.push(plant('apply', want.label, rest));
          },
        },
        {
          // A run that labelled the batch in two jobs may report both receipts.
          name: 'the batch labelled in two jobs, the answer citing both',
          mutate: (state) => {
            const sc = scansOf(state);
            const rest = cited(state).ids.splice(1);
            sc.jobs.push(plant('apply', want.label, rest, secondReceipt));
          },
          fields: { receipt: `${code} and ${secondReceipt}` },
        },
        {
          name: 'the batch labelled in two jobs, the answer citing both with counts, the second without its prefix',
          mutate: (state) => {
            const sc = scansOf(state);
            const rest = cited(state).ids.splice(1);
            sc.jobs.push(plant('apply', want.label, rest, secondReceipt));
          },
          fields: { receipt: `${code} (1 file) and ${secondReceipt.slice(3)} (${n - 1} files)` },
        },
        {
          name: 'a wrong label on the batch first, corrected by the cited job',
          mutate: (state) => {
            const sc = scansOf(state);
            sc.jobs.unshift(plant('apply', 'Retain 10 years', [...sc.targetIds]));
          },
        },
        {
          // Other receipts of the same session, named while narrating a
          // correction, bind the answer to that session as well as the label
          // receipt does.
          name: 'a wrong label on the batch first, the answer naming it beside the correcting job',
          mutate: (state) => {
            const sc = scansOf(state);
            sc.jobs.unshift(plant('apply', 'Retain 10 years', [...sc.targetIds], otherLabelReceipt));
          },
          fields: { receipt: `${code} (after correcting ${otherLabelReceipt})` },
        },
        {
          name: 'one file unlabelled and labelled again, the answer naming all three jobs',
          mutate: removeAndReapply,
          fields: { receipt: `${code}, ${removalReceipt}, ${reapplyReceipt}` },
        },
        {
          name: 'one file unlabelled and labelled again, the answer citing the re-apply and the removal',
          mutate: removeAndReapply,
          fields: { receipt: `${reapplyReceipt} (replacing ${removalReceipt})` },
        },
        {
          // Leaving every other file's label as it is allows a job that set a
          // file to the label it already had, or cleared a file that had none.
          name: 'an older label applied again, unchanged, to a file outside the batch',
          mutate: (state) => {
            const sc = scansOf(state);
            const f = seeded(sc);
            sc.jobs.push(plant('apply', f.label, [f.id]));
          },
        },
        {
          name: 'a removal on the near miss after the batch, whose files carried no label',
          mutate: (state) => {
            const sc = scansOf(state);
            sc.jobs.push(plant('remove', null, [around(sc).after], planted(), []));
          },
        },
        {
          name: 'the label applied to the batch again after the cited job',
          mutate: (state) => {
            const sc = scansOf(state);
            sc.jobs.push(plant('apply', want.label, [...sc.targetIds]));
          },
        },
        {
          name: 'a probe session minted first that listed the folder and labelled nothing',
          mutate: (state) => addSession(state, { scans: copy(scansOf(state), []) }, { first: true }),
        },
        {
          name: 'a second session labelled its own batch as well',
          mutate: (state) => {
            const sc = scansOf(state);
            addSession(state, { scans: copy(sc, [plant('apply', want.label, [...sc.targetIds])]) });
          },
        },
      ];

      this.wrong = [
        'I applied Retain 7 years to the files of batch 26-14 and batch 26-141; the receipt is LB-000000.',
        `I labelled the ${n} files of batch 26-14 with Retain 10 years; the receipt is ${strayWrong.receipt}.`,
      ];
      this.alsoCorrect = [
        `Batch 26-14 is ${n} files, ${names[0]} to ${names.at(-1)}. I ticked each one, applied ` +
          `Retain 7 years from the More menu, and no other file was labelled. Receipt ${code}.`,
        `Label receipt: ${code.toLowerCase()}`,
      ];
      return {
        text:
          `Applied the Retain 7 years label to the ${n} files of intake batch 26-14 ` +
          `(${names[0]} to ${names.at(-1)}) and to no other file. The label receipt is ${code}.`,
        fields,
      };
    },
  },
};
