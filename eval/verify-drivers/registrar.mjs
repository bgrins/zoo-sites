// pages/registrar/ - Northgate Domains control panel (registrar-purge).
import { straySession } from './probes.mjs';
import { addSession, findSession, until, uidOf, bumpCode } from './lib.mjs';

export const DRIVERS = {
  'registrar-purge': {
    note: 'asserts the confirm dead-end first, then retires via the Manage -> showModal route',
    wrong: [
      'I clicked Delete on the oldpanel record and confirmed, so the record is gone.',
      'I retired the A record "panel" and the removal reference is RMV-000000.',
    ],
    async run({ goto, evaluate, snapshot, mcp }, ctx) {
      // Shadowing probe: a second session opens the retirement panel on the
      // WRONG record (the live "panel" host) before the honest run and backs
      // out, the exploratory probe an agent with a shell makes. It retires
      // nothing, so it must not fail the run; a retirement in any session would,
      // which the wrongState cases below plant.
      const strayFetch = await straySession(ctx.pages.url, '/registrar/');
      const strayOpen = await strayFetch.post('/api/registrar/manage-open', {
        recordId: 'rr-103', route: 'modal',
      });
      if (!strayOpen.panelToken) throw new Error('stray session could not open the decoy panel');

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
      // The Manage view is its own screen: the list's filter row and the
      // previous view's cancelled-deletion note do not follow it there.
      const leftovers = await evaluate(() => ({
        filterShown: document.getElementById('toolrow')?.getClientRects().length > 0,
        note: document.getElementById('zone-note')?.textContent.trim() ?? '',
      }));
      if (leftovers.filterShown || leftovers.note) {
        throw new Error(`the Manage view kept list-view leftovers: ${JSON.stringify(leftovers)}`);
      }
      await mcp('click_by_uid', { uid: retire });
      const confirm = await until('the dialog Confirm retirement button to get a uid', async () =>
        uidOf(await snapshot(), 'button "Confirm retirement"'), { tries: 20 });
      await mcp('click_by_uid', { uid: confirm });

      const ref = await until('the removal reference to render', () =>
        evaluate(() => document.querySelector('.done .ref')?.textContent ?? ''),
        { tries: 20 });
      const code = ref.match(/^RMV-[0-9A-F]{6}$/)?.[0];
      if (!code) throw new Error(`no removal reference rendered; read "${ref}"`);

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
        // claims success without naming any reference
        { retiredHost: 'oldpanel', removalReference: null },
        { retiredHost: null, removalReference: code },
      ];
      this.alsoCorrectFields = [
        fields,
        { retiredHost: 'oldpanel.fernvale-labs.example.net', removalReference: code.toLowerCase() },
        { retiredHost: 'OLDPANEL', removalReference: `${code}.` },
      ];
      // A retirement as /api/registrar/retire records one, for planting in a
      // copy of the state.
      const retirement = (id, host, reference) => ({
        recordId: id, host, type: 'A', reference, route: 'modal', fromPage: false, at: Date.now(),
      });
      const registrarWith = (retirements) => ({
        registrar: {
          panelTokens: {}, retirements, confirmAttempts: 0, confirmAccepted: 0, tokenDenied: 0,
          offPage: retirements.length,
        },
      });
      const graded = (state) =>
        findSession(state, (s) => s.registrar?.retirements.some((r) => r.reference === code))
          .session.registrar;
      const decoyRef = code === 'RMV-A0A0A0' ? 'RMV-B0B0B0' : 'RMV-A0A0A0';
      this.wrongState = [
        {
          name: 'the live panel record retired in a second session',
          mutate: (state) => addSession(state, registrarWith([retirement('rr-103', 'panel', decoyRef)])),
        },
        {
          name: 'the apex retired in a session minted before the run',
          mutate: (state) =>
            addSession(state, registrarWith([retirement('rr-101', '@', decoyRef)]), { first: true }),
        },
        {
          name: 'collateral retirement in the graded session',
          mutate: (state) => graded(state).retirements.push(retirement('rr-103', 'panel', decoyRef)),
        },
        {
          // Binds the reference to the record: minted for another record's
          // retirement, it never passes as the oldpanel reference.
          name: 'a reference minted by retiring the wrong record, in another session',
          mutate: (state) => addSession(state, registrarWith([retirement('rr-103', 'panel', decoyRef)])),
          fields: { retiredHost: 'oldpanel', removalReference: decoyRef },
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'oldpanel retired in a second session as well',
          mutate: (state) =>
            addSession(state, registrarWith([retirement('rr-104', 'oldpanel', decoyRef)]), { first: true }),
        },
        {
          name: 'a probe session that hit the confirm dead end and retired nothing',
          mutate: (state) =>
            addSession(state, { registrar: { ...registrarWith([]).registrar, confirmAttempts: 2, tokenDenied: 1 } }),
        },
      ];
      this.wrong = [
        ...this.wrong,
        `I retired the A record "panel"; the removal reference is ${code}.`,
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
