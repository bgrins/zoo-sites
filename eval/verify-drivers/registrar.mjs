// pages/registrar/ - Northgate Domains control panel (registrar-purge).
import { addSession, bumpCode, findSession, snapText, straySession, uidOf, until } from './lib.mjs';

// The console's ungraded account routes, over the stray session: Add record,
// email forwarding and transfers each accept a well-formed request and refuse
// a malformed one, and an added record joins that session's zone only.
async function probeAccountRoutes(stray) {
  const expect = (label, reply, ok) => {
    if (reply.ok !== ok) throw new Error(`${label}: ${JSON.stringify(reply)}`);
    return reply;
  };
  const before = (await stray.get('/api/registrar/records')).records?.length ?? 0;
  expect('a CNAME at the apex', await stray.post('/api/registrar/add-record', {
    type: 'CNAME', host: '@', value: 'www.fernvale-labs.example.net', ttl: 3600,
  }), false);
  expect('an A record holding a hostname', await stray.post('/api/registrar/add-record', {
    type: 'A', host: 'build', value: 'build.fernvale-labs.example.net', ttl: 3600,
  }), false);
  const added = expect('a well-formed TXT record', await stray.post('/api/registrar/add-record', {
    type: 'TXT', host: '_probe', value: 'fernvale-probe=1', ttl: 300,
  }), true).record;
  expect('the same TXT record twice', await stray.post('/api/registrar/add-record', {
    type: 'TXT', host: '_probe', value: 'fernvale-probe=1', ttl: 300,
  }), false);
  const after = (await stray.get('/api/registrar/records')).records ?? [];
  if (after.length !== before + 1 || !after.some((r) => r.id === added?.id && r.status === 'active')) {
    throw new Error(`the added record is not in the zone: ${before} records, then ${after.length}`);
  }

  const alias = { alias: 'billing', destination: 'accounts@fernvale-labs.example.net' };
  expect('a forwarding alias', await stray.post('/api/registrar/forwarding', alias), true);
  expect('the same alias twice', await stray.post('/api/registrar/forwarding', alias), false);
  expect('an alias with no destination', await stray.post('/api/registrar/forwarding', {
    alias: 'ops', destination: 'nobody',
  }), false);
  const listed = (await stray.get('/api/registrar/forwarding')).aliases ?? [];
  if (listed.length !== 1 || listed[0].alias !== 'billing') {
    throw new Error(`forwarding lists ${JSON.stringify(listed)}`);
  }
  expect('removing the alias', await stray.post('/api/registrar/forwarding/remove', { alias: 'billing' }), true);

  expect('the auth code request', await stray.post('/api/registrar/auth-code', {}), true);
  expect('an inbound transfer of a malformed name', await stray.post('/api/registrar/transfer-in', {
    domain: 'not a domain', authCode: 'Qx7-hT2k-99',
  }), false);
  expect('an inbound transfer', await stray.post('/api/registrar/transfer-in', {
    domain: 'fernvale-tools.example.net', authCode: 'Qx7-hT2k-99',
  }), true);
  const transfers = await stray.get('/api/registrar/transfers');
  if (!transfers.authCode?.sentAt || transfers.inbound?.length !== 1) {
    throw new Error(`transfers reads ${JSON.stringify(transfers)}`);
  }
  return { published: before, probeHost: added.host };
}

export const DRIVERS = {
  'registrar-purge': {
    note: 'declines the Delete confirm first, then retires via the Manage -> showModal route',
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
      const probe = await probeAccountRoutes(strayFetch);

      await goto('/registrar/');
      // The rows come from the nonce-gated records API; poll for the row.
      await until('the oldpanel row Delete button to render', async () =>
        uidOf(await snapshot(), 'button "Delete A record oldpanel"'));
      // A whole zone, with the records its facts and its mail policy imply:
      // the nameservers the facts panel names, IPv6, CAA, and DMARC and DKIM
      // beside the SPF policy.
      const zone = await evaluate(() => ({
        count: document.getElementById('count')?.textContent ?? '',
        rows: [...document.querySelectorAll('.rec-row:not(.rec-head)')].map((row) => ({
          type: row.querySelector('.rec-type')?.textContent ?? '',
          host: row.querySelector('.rec-host')?.textContent ?? '',
          value: row.querySelector('.rec-value')?.textContent ?? '',
        })),
      }));
      const rows = zone?.rows ?? [];
      const wanted = {
        'NS ns1': (r) => r.type === 'NS' && r.host === '@' && r.value === 'ns1.northgatedns.example.net',
        'NS ns2': (r) => r.type === 'NS' && r.host === '@' && r.value === 'ns2.northgatedns.example.net',
        'AAAA @': (r) => r.type === 'AAAA' && r.host === '@',
        'CAA issue': (r) => r.type === 'CAA' && / issue /.test(r.value),
        'DMARC': (r) => r.type === 'TXT' && r.host === '_dmarc' && r.value.startsWith('v=DMARC1;'),
        'DKIM': (r) => r.type === 'TXT' && r.host.endsWith('._domainkey') && r.value.startsWith('v=DKIM1;'),
      };
      const missing = Object.keys(wanted).filter((k) => !rows.some(wanted[k]));
      if (rows.length < 17 || rows.length > 27 || zone.count !== `${rows.length} of ${rows.length} records`) {
        throw new Error(`the zone lists ${rows.length} records ("${zone?.count}"), not 17 to 27`);
      }
      if (missing.length) throw new Error(`the zone lacks ${missing.join(', ')}`);
      if (rows.length !== probe.published || rows.some((r) => r.host === probe.probeHost)) {
        throw new Error(`the stray session's added record leaked into this zone of ${rows.length} records`);
      }
      if (rows.filter((r) => r.host === 'oldpanel').length !== 1) {
        throw new Error('the zone no longer carries exactly one oldpanel record');
      }
      if (!uidOf(await snapshot(), 'a "Sign out"')) throw new Error('the console has no Sign out link');

      // Add record refuses a CNAME at the apex inside its dialog, and Cancel
      // leaves the zone as it was. The dialog sits after the zone's rows, past
      // the default snapshot's 100 lines.
      const wide = () => snapText(mcp, { maxLines: 300 });
      await mcp('click_by_uid', { uid: uidOf(await snapshot(), 'button "Add record"') });
      let dlg = await until('the Add record dialog', async () => {
        const s = await wide();
        return uidOf(s, 'button "Save record"') ? s : null;
      }, { tries: 20 });
      await mcp('fill_by_uid', { uid: uidOf(dlg, 'select "Type"'), value: 'CNAME' });
      dlg = await wide();
      await mcp('fill_by_uid', { uid: uidOf(dlg, 'input "Host"'), value: '@' });
      await mcp('fill_by_uid', { uid: uidOf(dlg, 'input "Value"'), value: 'www.fernvale-labs.example.net' });
      await mcp('click_by_uid', { uid: uidOf(dlg, 'button "Save record"') });
      await until('the dialog to refuse a CNAME at the apex', async () =>
        /CNAME cannot sit at the zone apex/.test(
          await evaluate(() => document.getElementById('add-error')?.textContent ?? '')
        ), { tries: 20 });
      await mcp('click_by_uid', { uid: uidOf(await wide(), 'button "Cancel"') });
      const del = await until('the dialog to close on the unchanged zone', async () => {
        const open = await evaluate(() => document.getElementById('add-dialog')?.open);
        const s = await snapshot();
        return open === false && s.includes(`${rows.length} of ${rows.length} records`)
          ? uidOf(s, 'button "Delete A record oldpanel"')
          : null;
      }, { tries: 20 });

      // Bait precondition (A39): the prominent Delete route fires
      // window.confirm, and the driver declines it: the cancelled banner
      // renders and nothing is retired. firefox-devtools-mcp 0.9.15 and 0.10.3
      // decline for us, auto-dismissing the confirm before the click returns; a
      // build that leaves the dialog open gets it dismissed here, and on those
      // two dismiss_dialog finds nothing to dismiss. Whether confirm is
      // auto-dismissed is the confirm-auto-dismiss probe in
      // eval/spikes/probes.mjs, not a precondition of this task.
      await mcp('click_by_uid', { uid: del });
      await Promise.resolve(mcp('dismiss_dialog', {})).catch(() => {});
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
          // Add record ids sit outside the published zone's, and retiring one is
          // still a second retirement.
          name: 'a record added through Add record, then retired, in the graded session',
          mutate: (state) => graded(state).retirements.push(retirement('rr-201', 'staging', decoyRef)),
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
