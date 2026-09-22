// Golden-path driver. See probes.mjs for the contract.
//
// Family: pages/forms/draymere/upload.html — the Draymere depot attestation intake
// (suite task id `file-upload`), the one task where the agent has to produce a
// file on the local filesystem and hand it to the browser.
//
// Driven entirely through the tool surface: take_snapshot to locate the
// controls, upload_file_by_uid for the file, click_by_uid for the confirmation
// checkbox and the Transmit button. Two snapshot gaps shape it:
//   * a control's `type` never reaches the snapshot, so the file input and the
//     confirmation checkbox both appear as a bare `input` and have to be told
//     apart by position and by the value the browser reports afterwards
//     (value="C:\fakepath\<name>" for the file input, value="on" for the box);
//   * a checked checkbox is byte-identical to an unchecked one in the snapshot,
//     so the tick is confirmed through the page's own "Count confirmed" chip.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bumpCode, notAfterToday, notBeforeToday, straySession } from './lib.mjs';
import { act, untilSnap } from './forms.mjs';

// The console's dates move with the day the session opened (sites/forms.mjs):
// tonight's shift is that day, the filed nights and the maintenance history lie
// before it, and the bookings and inspections the fleet list names lie ahead.
async function draymereNight(evaluate, today) {
  const pages = await evaluate(async () => {
    const nonce = document.documentElement.innerHTML.match(/NONCE = '([0-9a-f]+)'/)?.[1];
    const out = { filing: await (await fetch('/api/draymere/filing', { headers: { 'X-Session-Nonce': nonce } })).text() };
    for (const name of ['index.html', 'queue.html', 'dispatch.html', 'receiving.html', 'status.html', 'vehicles.html',
      'upload.html', 'excursion-log.html', 'count-summary.html', 'period-movements.html', 'inventory.html']) {
      out[name] = await (await fetch(name)).text();
    }
    return out;
  });
  const leftover = Object.keys(pages).filter((name) => /__DRAYMERE_/.test(pages[name]));
  if (leftover.length) throw new Error(`unrendered console dates on ${leftover.join(', ')}`);
  const one = (name, re) => {
    const m = re.exec(pages[name]);
    if (!m) throw new Error(`${name} prints no ${re}`);
    return m[1];
  };
  const tonight = (name, text) => {
    notBeforeToday(name, text, { today });
    notAfterToday(name, text, { today });
  };
  const at = new Date(Math.floor(today / 86400000) * 86400000);
  const period = `${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
  tonight('index.html', one('index.html', /depot 41, (\d{1,2} [A-Z][a-z]+ \d{4})</));
  tonight('dispatch.html', one('dispatch.html', /dispatch board &mdash; (\d{1,2} [A-Z][a-z]+ \d{4})</));
  tonight('receiving.html', one('receiving.html', /receipts &mdash; (\d{1,2} [A-Z][a-z]+ \d{4})</));
  tonight('status.html', one('status.html', /as of (\d{1,2} [A-Z][a-z]+ \d{4}),/));
  tonight('queue.html', one('queue.html', /id="p-tonight"><td>[\d-]+<\/td><td>(\d{1,2} [A-Z][a-z]{2}),/));
  if (one('queue.html', /id="p-tonight"><td>([\d-]+)</) !== period || one('index.html', /period (\d\d-\d\d)</) !== period) {
    throw new Error(`the console's open period is not ${period}, the session's night`);
  }
  if (JSON.parse(pages.filing).period !== period) throw new Error(`the filing API reports period ${pages.filing}`);
  for (const [, text] of pages['queue.html'].matchAll(/<td>(\d{1,2} [A-Z][a-z]{2}), 22:00[^<]*<\/td><td>op\./g)) {
    notAfterToday('queue.html', text, { today, behind: 1 });
  }
  for (const [, text] of pages['status.html'].matchAll(/<tr><td>(\d{2} [A-Z][a-z]{2} \d{4})<\/td>/g)) {
    notAfterToday('status.html', text, { today, behind: 1 });
  }
  const ahead = [...pages['vehicles.html'].matchAll(/<td>(\d{2} [A-Z][a-z]{2} \d{4})<\/td>|booked for (\d{1,2} [A-Z][a-z]{2})</g)];
  if (ahead.length < 10) throw new Error(`vehicles.html prints ${ahead.length} fleet dates`);
  for (const m of ahead) notBeforeToday('vehicles.html', m[1] ?? m[2], { today, ahead: 1 });
}

// The two form controls are indistinguishable by tag in the snapshot; the file
// input is the one that precedes the "No file attached" line.
const controlUids = (snap) => {
  const uids = [...snap.matchAll(/uid=(\S+) input/g)].map((m) => m[1]);
  if (uids.length < 2) throw new Error(`expected two inputs in the snapshot, saw ${uids.length}`);
  return { file: uids[0], confirm: uids[1] };
};

export const DRIVERS = {
  'file-upload': {
    note: 'writes a temp .txt, uploads it with upload_file_by_uid',
    wrong: ['I uploaded the attestation file. The receipt code is RCPT-000000.'],
    async run({ goto, snapshot, mcp, evaluate, base }, ctx) {
      // Stray uploads the intake accepts and the task must not: the wrong
      // line sent as if from the page, and the right line sent from a shell
      // with neither Sec-Fetch-Site nor a Referer.
      const strayReceipt = async (content, headers) => {
        const stray = await straySession(base, '/forms/draymere/upload.html');
        const { receipt } = await stray.upload('/api/upload', {
          fields: { attested: 'yes' },
          file: { field: 'doc', filename: 'count.txt', content },
          headers,
        });
        if (!receipt) throw new Error('the intake refused a stray upload');
        return receipt;
      };
      const failedLine = await strayReceipt('INVENTORY-FAILED\n', { 'sec-fetch-site': 'same-origin' });
      const offPage = await strayReceipt('INVENTORY-OK\n', {});
      // The Referer alone must mark an upload as from the page, in whichever
      // shape serves the page: under /forms/draymere/ here, at the origin's
      // root under --origins.
      const draymere = ctx.pages.origins.find((o) => o.dir === 'forms/draymere');
      const referred = await straySession(base, '/forms/draymere/upload.html');
      await referred.upload('/api/upload', {
        fields: { attested: 'yes' },
        file: { field: 'doc', filename: 'count.txt', content: 'INVENTORY-OK\n' },
        origin: draymere?.url ?? base,
        headers: {
          referer: draymere ? `${draymere.url}/upload.html` : `${base}/forms/draymere/upload.html`,
        },
      });
      const viaReferer = [...ctx.pages.state.sessions.values()]
        .find((s) => s.nonce === referred.nonce)
        ?.uploads?.at(-1);
      if (viaReferer?.fromPage !== true) {
        throw new Error('an upload carrying only the page Referer was not recorded as from the page');
      }

      const dir = mkdtempSync(join(tmpdir(), 'ffcli-upload-'));
      // Short on purpose: the page echoes "<name> (<n> bytes)" and the snapshot
      // truncates a text node at 27 characters, so a long filename makes the
      // only confirmation that the attach landed unreadable from the snapshot.
      const name = `count-${new Date().toISOString().slice(5, 10).replace('-', '')}.txt`;
      const path = join(dir, name);
      writeFileSync(path, 'INVENTORY-OK\n', 'utf8');
      try {
        await goto('/forms/draymere/upload.html');
        let snap = await untilSnap(
          snapshot,
          (s) => /No file attached/.test(s),
          'the attestation form'
        );
        await act(mcp, 'upload_file_by_uid', { uid: controlUids(snap).file, filePath: path });
        // The page echoes name and byte count once the change event lands.
        snap = await untilSnap(
          snapshot,
          (s) => s.includes(`${name} (13 bytes)`),
          'the attached-file line'
        );

        await act(mcp, 'click_by_uid', { uid: controlUids(snap).confirm });
        snap = await untilSnap(
          snapshot,
          (s) => /Count confirmed/.test(s),
          'the count confirmation chip'
        );

        const send = snap.match(/uid=(\S+) button "Transmit attestation"/);
        if (!send) throw new Error('no Transmit attestation button in the snapshot');
        await act(mcp, 'click_by_uid', { uid: send[1] });

        // Polled through the snapshot deliberately: this receipt is the one the
        // agent must read back, so the driver exercises the same surface. It does
        // not assert legibility - a surface that cuts it fails the task, which is
        // the result.
        const done = await untilSnap(
          snapshot,
          (s) => /RCPT-[0-9A-F]{6}/.test(s),
          'the intake receipt'
        );
        const code = done.match(/RCPT-[0-9A-F]{6}/)[0];
        const bumped = bumpCode(code);
        if ([failedLine, offPage].includes(code)) throw new Error('a stray session and the browser share a receipt');
        const graded = [...ctx.pages.state.sessions.values()].find((s) => s.uploadReceipt === code);
        if (!graded) throw new Error(`no session holds receipt ${code}`);
        await draymereNight(evaluate, graded.createdAt);
        const fields = { receiptCode: code };
        this.wrongFields = [
          { receiptCode: 'RCPT-000000' },
          { receiptCode: bumped },
          { receiptCode: failedLine },
          { receiptCode: offPage },
        ];
        this.alsoCorrectFields = [fields, { receiptCode: code.toLowerCase() }];
        this.wrong = [
          this.wrong[0],
          `The attestation was transmitted; the intake receipt code is ${bumped}.`,
        ];
        this.alsoCorrect = [
          `I wrote a 13-byte text file, attached it as the export, ticked the ` +
            `count confirmation and transmitted; the intake desk returned ` +
            `receipt code ${code}.`,
          `Receipt code: ${code}`,
          `Attestation accepted with receipt ${code.toLowerCase()}.`,
        ];
        return {
          text:
            `I created a plain-text file containing the single line INVENTORY-OK (13 bytes), ` +
            `attached it as the attestation export, ticked the count confirmation and ` +
            `transmitted it. The intake service accepted it and returned receipt code ${code}.`,
          fields,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
};
