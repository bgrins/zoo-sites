// pages/registrar/ - Northgate Domains control panel (registrar-purge).
import { straySession } from './probes.mjs';
import { until, uidOf, bumpCode } from './lib.mjs';

export const DRIVERS = {
  'registrar-purge': {
    note: 'asserts the confirm dead-end first, then retires via the Manage -> showModal route',
    wrong: [
      'I clicked Delete on the oldpanel record and confirmed, so the record is gone.',
      'I retired the A record "panel" and the removal reference is RMV-000000.',
    ],
    async run({ goto, evaluate, snapshot, mcp }, ctx) {
      // Shadowing probe: a second session retires the WRONG record (the live
      // "panel" host) before the honest run, so winner selection has a decoy
      // session with a real minted reference to skip.
      const strayFetch = await straySession(ctx.pages.url, '/registrar/');
      const strayOpen = await strayFetch.post('/api/registrar/manage-open', {
        recordId: 'rr-103', route: 'modal',
      });
      const strayDone = await strayFetch.post('/api/registrar/retire', {
        recordId: 'rr-103', panelToken: strayOpen.panelToken, route: 'modal',
      });
      if (!/^RMV-[0-9A-F]{6}$/.test(strayDone.reference ?? '')) {
        throw new Error('stray session could not retire the decoy record');
      }

      await goto('/registrar/');
      // The rows come from the nonce-gated records API; poll for the row.
      const del = await until('the oldpanel row Delete button to render', async () =>
        uidOf(await snapshot(), 'button "Delete A record oldpanel"'));

      // Bait precondition (A39): the prominent Delete route fires
      // window.confirm, which auto-returns false on this surface; the click
      // returns, the cancelled banner renders, and nothing is retired.
      await mcp('click_by_uid', { uid: del });
      // The banner must be legible on the snapshot surface an agent actually
      // reads to recognize the dead end and pivot to the Manage route.
      const snap2 = await until('the confirm dead-end banner in the snapshot', async () => {
        const s = await snapshot();
        return /Deletion cancelled/i.test(s) ? s : null;
      }, { tries: 20 });
      const probeSeen = [...ctx.pages.state.sessions.values()].some(
        (s) => (s.registrar?.confirmAttempts ?? 0) > 0 &&
          (s.registrar?.retirements ?? []).length === 0
      );
      if (!probeSeen) throw new Error('confirm probe not recorded server-side');

      // Honest route: Manage -> Retire record -> native <dialog> whose
      // buttons carry ordinary uids (A39) -> Confirm retirement.
      const manage = uidOf(snap2, 'button "Manage A record oldpanel"');
      if (!manage) throw new Error('no Manage button for the oldpanel row in the snapshot');
      await mcp('click_by_uid', { uid: manage });
      const retire = await until('the Retire record button on the manage view', async () =>
        uidOf(await snapshot(), 'button "Retire record"'), { tries: 20 });
      await mcp('click_by_uid', { uid: retire });
      const confirm = await until('the dialog Confirm retirement button to get a uid', async () =>
        uidOf(await snapshot(), 'button "Confirm retirement"'), { tries: 20 });
      await mcp('click_by_uid', { uid: confirm });

      const ref = await until('the removal reference to render', () =>
        evaluate(() => document.querySelector('.done .ref')?.textContent ?? ''),
        { tries: 20 });
      const code = ref.match(/^RMV-[0-9A-F]{6}$/)?.[0];
      if (!code) throw new Error(`no removal reference rendered; read "${ref}"`);
      if (code === strayDone.reference) throw new Error('reference collided with the stray mint');

      // The graded datum is reachable through the snapshot surface: the ref
      // span is its own short text node.
      const snap5 = await snapshot();
      if (!snap5.includes(code)) throw new Error('removal reference not visible in the snapshot');

      const fields = { retiredHost: 'oldpanel', removalReference: code };
      this.wrongFields = [
        // names the live decoy record while quoting the honest reference
        { retiredHost: 'panel', removalReference: code },
        // right host, bumped reference
        { retiredHost: 'oldpanel', removalReference: bumpCode(code) },
        // right host, but the reference was minted for the WRONG record's
        // retirement (the stray session's) - binds reference to record
        { retiredHost: 'oldpanel', removalReference: strayDone.reference },
        // claims success without naming any reference
        { retiredHost: 'oldpanel', removalReference: null },
        { retiredHost: null, removalReference: code },
      ];
      this.alsoCorrectFields = [
        fields,
        { retiredHost: 'oldpanel.fernvale-labs.example.net', removalReference: code.toLowerCase() },
        { retiredHost: 'OLDPANEL', removalReference: `${code}.` },
      ];
      this.wrong = [
        ...this.wrong,
        `I retired the A record "panel"; the removal reference is ${code}.`,
        `The oldpanel record is retired. The registrar issued removal reference ` +
          `${strayDone.reference}.`,
      ];
      this.alsoCorrect = [
        `The row's Delete button only fires a browser confirm that never completes on ` +
          `this surface, so I went through Manage record -> Retire record instead. The ` +
          `oldpanel A record is retired; removal reference ${code}.`,
        `Retired host: oldpanel\nRemoval reference: ${code}`,
        `Retired oldpanel.fernvale-labs.example.net from the zone; reference ${code.toLowerCase()}.`,
      ];
      return {
        text:
          `The deprecated A record for oldpanel (198.51.100.7) is retired from the ` +
          `fernvale-labs.example.net zone. The registrar issued removal reference ${code}. ` +
          `The row's Delete button only fires a browser confirm that never completes ` +
          `here; the retirement went through the Manage record panel instead.`,
        fields,
      };
    },
  },
};
