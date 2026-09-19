// Golden path for the Stavelock credential vault (token-rotate). See
// probes.mjs for the driver contract.

import { bumpCode, uidOf, until } from './lib.mjs';

export const DRIVERS = {
  // The clipboard is the human route to the token, not the only one — an
  // evaluate_script fetch of /api/vault/copy with the page nonce reaches it too,
  // and is cheaper. This driver deliberately takes the clipboard route and
  // nothing else, so that the golden path proves that route still works: it
  // never reads ctx.pages.state and never re-fetches /api/vault/copy itself.
  // Our evaluate_script carries no user activation, so navigator.clipboard.readText
  // is only allowed while the transient activation from a real click_by_uid is
  // still live (~5s in Firefox) — the read therefore has to be the call right
  // after the copy click, and a retry has to re-click first.
  'token-rotate': {
    note: 'clipboard route: click Copy, then readText inside the activation window',
    wrong:
      'I rotated the deploy token for sluicegate-api. The rotation receipt is RCP-4B19C2.',
    async run({ goto, evaluate, snapshot, mcp, sleep }) {
      // Waits here breathe at 150ms: the vault answers instantly and the
      // clipboard retry loop below is the only slow part of the page.
      const waitFor = (read, label) => until(label, read, { gap: 150 });

      await goto('/vault/');
      await waitFor(
        async () => (await snapshot()).includes('sluicegate-api/deploy'),
        'the secrets list to render'
      );
      let snap = await snapshot();
      const secretUid = uidOf(snap, 'a "sluicegate-api/deploy"');
      if (!secretUid) throw new Error('no link to the deploy secret in the snapshot');
      await mcp('click_by_uid', { uid: secretUid });

      await waitFor(
        async () => (await snapshot()).includes('Copy token'),
        'the secret detail view'
      );
      snap = await snapshot();
      const masked = snap.match(/stv_live_[0-9a-f]{4}…[0-9a-f]{4}/);
      if (!masked) throw new Error('the secret page did not render a masked value');
      const copyUid = uidOf(snap, 'button "Copy token"');
      if (!copyUid) throw new Error('no Copy token button in the snapshot');

      // Click and read back to back: any tool call in between spends the
      // activation window and readText comes back NotAllowedError.
      let token = '';
      for (let attempt = 0; attempt < 4 && !token; attempt++) {
        await mcp('click_by_uid', { uid: copyUid });
        const read = await evaluate(async () => {
          try {
            return await navigator.clipboard.readText();
          } catch (error) {
            return 'ERR:' + error.name;
          }
        });
        if (typeof read === 'string' && read.startsWith('stv_live_')) token = read;
        else await sleep(400);
      }
      if (!token) throw new Error('could not read the token off the clipboard');
      if (!token.startsWith(masked[0].slice(0, 13))) {
        throw new Error(`clipboard value ${token} does not match the mask ${masked[0]}`);
      }

      // The fixture's central claim: the whole value is nowhere in the live page,
      // so a future edit that leaks it into markup or a global fails here rather
      // than silently turning this into a read-off-the-page task.
      const leak = await evaluate(`() => {
        const token = ${JSON.stringify(token)};
        if (document.documentElement.outerHTML.includes(token)) return 'markup';
        for (const key of Object.keys(window)) {
          let value;
          try {
            value = window[key];
          } catch {
            continue;
          }
          if (typeof value === 'string' && value.includes(token)) return 'window.' + key;
        }
        return '';
      }`);
      if (leak) throw new Error(`the full token is readable from the page (${leak})`);

      await goto('/vault/rotate.html');
      await waitFor(
        async () => (await snapshot()).includes('Rotate token'),
        'the rotation form'
      );
      const submitRotation = async (value) => {
        const form = await snapshot();
        const tokenUid = uidOf(form, 'input "Current token value"');
        const reasonUid = uidOf(form, 'input "Reason for rotation"');
        const submitUid = uidOf(form, 'button "Rotate token"');
        if (!tokenUid || !reasonUid || !submitUid) {
          throw new Error('the rotation form did not render its fields');
        }
        await mcp('fill_by_uid', { uid: tokenUid, value });
        await mcp('fill_by_uid', { uid: reasonUid, value: 'Scheduled 90-day rotation' });
        await mcp('click_by_uid', { uid: submitUid });
      };

      // The masked form the console renders must not rotate anything: if it did,
      // the clipboard would be decorative and the task would grade nothing.
      await submitRotation(masked[0]);
      await waitFor(
        async () => (await snapshot()).includes('does not match'),
        'the masked value to be refused'
      );

      await submitRotation(token);

      const receipt = await waitFor(async () => {
        const now = await snapshot();
        return now.match(/RCP-[0-9A-F]{6}/)?.[0] ?? null;
      }, 'the rotation receipt');

      // The reason is graded off the server's record, so a driver that stopped filling
      // this field would fail the task rather than silently stop testing it.
      this.alsoCorrect = [`Rotation receipt: **${receipt}**.`];

      const fields = { rotationReceipt: receipt };
      this.wrongFields = [{ rotationReceipt: 'RCP-0000' }, { rotationReceipt: bumpCode(receipt) }];
      this.alsoCorrectFields = [fields, { rotationReceipt: String(receipt).toLowerCase() }];
      const graded = (state) => {
        for (const s of state.sessions.values()) {
          const record = s.vault?.receipts?.find((r) => r.receipt === receipt);
          if (record) return { vault: s.vault, record };
        }
        throw new Error('no session holds the golden rotation');
      };
      // A second rotation of the same secret, as a curl replay after the real
      // one leaves it: its own receipt, and a reason the ask did not dictate.
      const replay = (state) => {
        const { vault, record } = graded(state);
        const later = { ...record, receipt: bumpCode(receipt), reason: 'cleanup', at: record.at + 1000 };
        vault.receipts.push(later);
        vault.rotated[record.id] = later;
        return later.receipt;
      };
      this.wrongState = [
        {
          name: 'the rotation carries a reason the ask did not dictate',
          mutate: (state) => {
            graded(state).record.reason = 'cleanup';
          },
        },
        {
          name: 'the rotation carries no reason',
          mutate: (state) => {
            graded(state).record.reason = '';
          },
        },
        {
          name: 'the answer names a later rotation made with the wrong reason',
          mutate: replay,
          fields: { rotationReceipt: bumpCode(receipt) },
        },
      ];
      this.alsoCorrectState = [
        { name: 'a later replay rotation does not shadow the one the answer names', mutate: replay },
      ];
      return {
        text:
          `I copied the current value of sluicegate-api/deploy out of Stavelock with the ` +
          `Copy token button, pasted it into the rotation form and rotated the secret. ` +
          `The rotation receipt is ${receipt}.`,
        fields,
      };
    },
  },
};
