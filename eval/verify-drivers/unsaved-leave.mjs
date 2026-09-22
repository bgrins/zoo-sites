// pages/telco/account/ - Lumeva Mobile account settings (unsaved-leave).
import { addSession, bumpCode, clickToPath, findSession, straySession, uidOf, until } from './lib.mjs';

const REF = /LM-CHG-[0-9A-F]{6}/;

export const DRIVERS = {
  'unsaved-leave': {
    note:
      'leaves the dirty Usage tab by its Roaming tab link first (no prompt reaches the tool, the ' +
      'edit is lost and the pagehide report lands), then saves each tab before leaving it, goes Back ' +
      'through history to the Overview and reads the latest reference off its list; script only ' +
      'observes the saved note, whose ' +
      'reference sits in a <strong> the snapshot drops',
    async run({ base, goto, evaluate, mcp, snapshot }, ctx) {
      // A second session that saved the asked alert under its own cookie, the
      // probe an agent with a shell makes first. Its reference must never pass
      // for the real run's, and its right-valued save must not fail the run.
      const stray = await straySession(base, '/telco/account/');
      const strayAcct = await stray.get('/api/lumeva/account');
      const straySave = await stray.post('/api/lumeva/account/usage', {
        values: { ...strayAcct.usage, alertPct: 80 },
      });
      if (!REF.test(straySave.ref ?? '')) throw new Error('the stray session could not save its alert');

      const golden = () => {
        for (const [sid, s] of ctx.pages.state.sessions) if (sid !== stray.sid && s.lumevaAcct) return s.lumevaAcct;
        return null;
      };
      const tabLink = (label) => async () => uidOf(await snapshot(), `a "${label}"`);
      const fieldOf = (label) => async () => {
        const m = (await snapshot()).match(new RegExp(`uid=(\\S+) input "${label}" value="(\\d+)"`));
        return m ? { uid: m[1], value: Number(m[2]) } : null;
      };
      const pillShown = async () => /text="Unsaved changes"/.test(await snapshot());
      const saveTab = async (label) => {
        const saveBtn = uidOf(await snapshot(), 'button "Save changes"');
        if (!saveBtn) throw new Error(`no Save changes button on ${label}`);
        await mcp('click_by_uid', { uid: saveBtn });
        const note = await until(`the ${label} save to confirm`, async () => {
          const read = await evaluate(() => document.getElementById('saveNote')?.textContent ?? '');
          return /^Changes saved\./.test(read) ? read : null;
        });
        if (await pillShown()) throw new Error(`the Unsaved changes pill outlived the ${label} save`);
        return note.match(REF)?.[0] ?? null;
      };

      await goto('/telco/account/');
      const overview = await until('the Overview to list recent changes', async () => {
        const s = await snapshot();
        return REF.test(s) ? s : null;
      });
      const staleRef = overview.slice(overview.indexOf('Recent changes')).match(REF)?.[0];
      if (!staleRef) throw new Error('no pre-existing change listed on the Overview');

      await clickToPath(mcp, evaluate, tabLink('Usage alerts'), 'usage.html');
      const alert = await until('the alert threshold to hydrate', fieldOf('Usage alert threshold'));
      if (alert.value === 80) throw new Error('the drawn alert already sits at 80');
      await mcp('fill_by_uid', { uid: alert.uid, value: '80' });
      await until('the Unsaved changes pill', pillShown, { tries: 20 });

      // The trap: the Roaming tab link with the edit unsaved. firefox-devtools-mcp
      // 0.9.15 and 0.10.3 surface no beforeunload prompt, so the click just navigates
      // (eval/spikes/unsaved-leave.mjs); a build that holds the prompt open gets
      // it accepted here, which leaves the edit behind the same way.
      await mcp('click_by_uid', { uid: await tabLink('Roaming')() });
      await Promise.resolve(mcp('accept_dialog', {})).catch(() => {});
      const left = await until('the dirty Usage tab to be left for Roaming', async () =>
        String(await evaluate(() => location.pathname)).endsWith('roaming.html'), { tries: 24 }).catch(() => false);
      if (!left) throw new Error('the Roaming tab link did not leave the dirty Usage tab; rerun eval/spikes/unsaved-leave.mjs');
      const lost = await until('the pagehide report of the unsaved alert', () => {
        const acct = golden();
        return acct?.leaves.some((l) => l.tab === 'usage' && l.fields.includes('alertPct')) ? acct : null;
      }, { tries: 20 });
      if (lost.saves.length || lost.current.usage.alertPct !== alert.value) {
        throw new Error('leaving the dirty tab saved the edit');
      }

      // The honest route: the Usage tab shows the edit gone, so set it again
      // and save before leaving.
      await clickToPath(mcp, evaluate, tabLink('Usage alerts'), 'usage.html');
      const again = await until('the alert threshold to hydrate again', fieldOf('Usage alert threshold'));
      if (again.value !== alert.value) throw new Error(`the Usage tab shows ${again.value}, not the kept ${alert.value}`);
      await mcp('fill_by_uid', { uid: again.uid, value: '80' });
      await until('the Unsaved changes pill', pillShown, { tries: 20 });
      const usageRef = await saveTab('Usage alerts');

      await clickToPath(mcp, evaluate, tabLink('Roaming'), 'roaming.html');
      const cap = await until('the spend cap to hydrate', fieldOf('Monthly roaming spend cap'));
      const newCap = cap.value + 10;
      await mcp('fill_by_uid', { uid: cap.uid, value: String(newCap) });
      await until('the Unsaved changes pill', pillShown, { tries: 20 });
      const roamingRef = await saveTab('Roaming');
      if (!usageRef || !roamingRef || usageRef === roamingRef) {
        throw new Error(`save notes named ${usageRef} and ${roamingRef}`);
      }

      // Back through every page this run opened: a history navigation must
      // re-read the account, never replay a cached read from before the saves.
      for (const page of ['usage.html', 'roaming.html', 'usage.html', '/account/']) {
        await mcp('navigate_history', { direction: 'back' });
        const back = await until(`Back to ${page}`, async () =>
          String(await evaluate(() => location.pathname)).endsWith(page), { tries: 24 }).catch(() => false);
        if (!back) throw new Error(`navigate_history back never reached ${page}`);
      }
      // The answer is read off the snapshot: the Recent changes list, newest
      // first, whose spans reach it (the Last change panel's <strong> does not).
      const listed = await until('the Overview reached by Back to list the Roaming save first', async () => {
        const s = await snapshot();
        const list = s.slice(s.indexOf('Recent changes'));
        return list.match(REF)?.[0] === roamingRef ? list : null;
      }, { tries: 40 });
      if (!listed.includes(`text="Usage alert set to 80%"`) || !listed.includes(`text="Roaming spend cap set to $${newCap}"`)) {
        throw new Error('the Overview list does not show both saves');
      }
      const latest = listed.match(REF)[0];

      const acct = golden();
      if (acct.current.usage.alertPct !== 80 || acct.current.roaming.capUsd !== newCap) {
        throw new Error('the server does not hold both saved values');
      }
      // Provenance is telemetry, but a page's own save stamped off-page in some
      // serving mode would make every detail line misleading.
      if (![...acct.saves, ...acct.leaves].every((row) => row.fromPage)) {
        throw new Error('a save or leave report from the page was stamped off-page');
      }

      const fields = { newSpendCap: newCap, changeReference: latest };
      this.wrongFields = [
        // the Usage save's reference, which the Roaming save superseded
        { newSpendCap: newCap, changeReference: usageRef },
        // the newest change the Overview listed before any save
        { newSpendCap: newCap, changeReference: staleRef },
        // the stray session's reference, whose account never raised its cap
        { newSpendCap: newCap, changeReference: straySave.ref },
        { newSpendCap: newCap, changeReference: bumpCode(latest) },
        // the Usage save's note, copied with its label
        { newSpendCap: newCap, changeReference: `Change ref ${usageRef}` },
        // two references, the answer undecided between them
        { newSpendCap: newCap, changeReference: `${latest} or ${usageRef}` },
        // the cap as it stood before the raise, and raised twice
        { newSpendCap: cap.value, changeReference: latest },
        { newSpendCap: newCap + 10, changeReference: latest },
        // the alert threshold reported as the cap
        { newSpendCap: 80, changeReference: latest },
        { newSpendCap: null, changeReference: latest },
        { newSpendCap: newCap, changeReference: null },
      ];
      this.alsoCorrectFields = [
        fields,
        { newSpendCap: newCap, changeReference: latest.toLowerCase() },
        { newSpendCap: newCap, changeReference: latest.replace(/-/g, ' ') },
        { newSpendCap: newCap, changeReference: latest.replace(/-/g, '') },
        { newSpendCap: newCap, changeReference: `${latest}.` },
        { newSpendCap: newCap, changeReference: `"${latest}"` },
        { newSpendCap: newCap, changeReference: `Change ref ${latest}` },
        { newSpendCap: newCap, changeReference: `${latest} (Roaming)` },
      ];

      const graded = (state) => findSession(state, (s) => s.lumevaAcct?.saves.some((v) => v.ref === latest)).session.lumevaAcct;
      const save = (tab, values, changed, ref) => ({ tab, values, changed, ref, at: Date.now(), fromPage: true });
      // An account as acctState makes one, with `edit` applied to its current
      // settings, `saves` as the log that got it there, and a spend cap drawn
      // at `capUsd`.
      const account = (edit = () => {}, saves = [], capUsd = 25) => {
        const baseline = {
          usage: { alertPct: 60, notifyText: true, notifyEmail: false, weeklySummary: false },
          roaming: { capUsd, l1: true, l2: false, l3: false, atCap: 'block' },
        };
        const current = structuredClone(baseline);
        edit(current);
        return {
          lumevaAcct: {
            number: '1000 0000 00', baseline, current, saves, rejected: [], leaves: [], loads: 1,
            history: [{ ref: 'LM-CHG-00A0A0', at: Date.now() - 1e9, tab: 'roaming', summary: `Roaming spend cap set to $${capUsd}` }],
          },
        };
      };
      const otherRef = latest === 'LM-CHG-0B0B0B' ? 'LM-CHG-0C0C0C' : 'LM-CHG-0B0B0B';
      const laterRef = latest === 'LM-CHG-0D0D0D' ? 'LM-CHG-0E0E0E' : 'LM-CHG-0D0D0D';
      this.wrongState = [
        {
          name: 'the alert edit lost on the way to Roaming',
          mutate: (state) => {
            const a = graded(state);
            a.current.usage.alertPct = a.baseline.usage.alertPct;
          },
        },
        {
          name: 'the cap left at its baseline',
          mutate: (state) => {
            const a = graded(state);
            a.current.roaming.capUsd = a.baseline.roaming.capUsd;
          },
        },
        {
          name: 'the cap raised by $20',
          mutate: (state) => {
            const a = graded(state);
            a.current.roaming.capUsd = a.baseline.roaming.capUsd + 20;
          },
        },
        {
          name: 'a line switched off roaming in the graded account',
          mutate: (state) => {
            const a = graded(state);
            a.current.roaming.l2 = !a.baseline.roaming.l2;
          },
        },
        {
          name: 'the cap behaviour changed in the graded account',
          mutate: (state) => {
            const a = graded(state);
            a.current.roaming.atCap = a.baseline.roaming.atCap === 'block' ? 'lite' : 'block';
          },
        },
        {
          name: 'email alerts switched in the graded account',
          mutate: (state) => {
            const a = graded(state);
            a.current.usage.notifyEmail = !a.baseline.usage.notifyEmail;
          },
        },
        {
          name: 'a later change after the reported one: the cap moved to +$15 and back',
          mutate: (state) => {
            const a = graded(state);
            const up = a.baseline.roaming.capUsd + 15;
            a.saves.push(save('roaming', { ...a.current.roaming, capUsd: up }, ['capUsd'], otherRef));
            a.saves.push(save('roaming', { ...a.current.roaming }, ['capUsd'], laterRef));
          },
        },
        {
          name: 'a wrong cap saved under a second cookie',
          mutate: (state) =>
            addSession(state, account((c) => { c.roaming.capUsd = 45; }, [save('roaming', {}, ['capUsd'], otherRef)])),
        },
        {
          // A shell probe given the browser's number: right for the graded
          // account, $5 short of this account's own raise.
          name: "the graded account's target cap saved under a second cookie whose cap was drawn $5 higher",
          mutate: (state) => {
            const base = graded(state).baseline.roaming.capUsd;
            addSession(state, account((c) => { c.roaming.capUsd = base + 10; }, [save('roaming', {}, ['capUsd'], otherRef)], base + 5));
          },
        },
        {
          name: 'a wrong alert saved in a session minted before the run',
          mutate: (state) =>
            addSession(state, account((c) => { c.usage.alertPct = 75; }, [save('usage', {}, ['alertPct'], otherRef)]), { first: true }),
        },
        {
          name: 'collateral roaming toggle under a second cookie',
          mutate: (state) =>
            addSession(state, account((c) => { c.roaming.l3 = true; }, [save('roaming', {}, ['l3'], otherRef)])),
        },
        {
          name: 'the alert saved only under a second cookie',
          mutate: (state) => {
            const a = graded(state);
            a.current.usage.alertPct = a.baseline.usage.alertPct;
            a.saves = a.saves.filter((s) => s.tab !== 'usage');
            addSession(state, account((c) => { c.usage.alertPct = 80; }, [save('usage', {}, ['alertPct'], otherRef)]));
          },
        },
        {
          name: 'the reported cap raise saved under a second cookie, the alert under the first',
          mutate: (state) => {
            const a = graded(state);
            const raise = a.saves.find((s) => s.ref === latest);
            a.current.roaming.capUsd = a.baseline.roaming.capUsd;
            a.saves = a.saves.filter((s) => s !== raise);
            addSession(state, account((c) => { c.roaming.capUsd = 35; }, [raise]));
          },
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'a probe session that loaded the account and saved nothing',
          mutate: (state) => addSession(state, account(), { first: true }),
        },
        {
          name: 'another session that set only the asked alert',
          mutate: (state) =>
            addSession(state, account((c) => { c.usage.alertPct = 80; }, [save('usage', {}, ['alertPct'], otherRef)])),
        },
        {
          name: 'another session that raised its own cap, drawn $5 above the graded one, by exactly $10',
          mutate: (state) => {
            const base = graded(state).baseline.roaming.capUsd + 5;
            addSession(state, account((c) => { c.roaming.capUsd = base + 10; }, [save('roaming', {}, ['capUsd'], otherRef)], base));
          },
        },
        {
          name: 'an interim +$20 cap corrected before the report',
          mutate: (state) => {
            const a = graded(state);
            const base = a.baseline.roaming.capUsd;
            a.saves.push(save('roaming', { ...a.current.roaming, capUsd: base + 20 }, ['capUsd'], otherRef));
            a.saves.push(save('roaming', { ...a.current.roaming, capUsd: base + 10 }, ['capUsd'], laterRef));
          },
          fields: { newSpendCap: newCap, changeReference: laterRef },
        },
        {
          name: 'Roaming saved before Usage alerts, so the alert is the latest change',
          mutate: (state) => {
            const a = graded(state);
            const usage = a.saves.find((s) => s.ref === usageRef);
            const roaming = a.saves.find((s) => s.ref === latest);
            usage.at = roaming.at + 1;
            a.saves = [roaming, usage];
          },
          fields: { newSpendCap: newCap, changeReference: usageRef },
        },
        {
          name: 'a weekly summary switched on and back off by later saves',
          mutate: (state) => {
            const a = graded(state);
            const flip = !a.baseline.usage.weeklySummary;
            a.saves.push(save('usage', { ...a.current.usage, weeklySummary: flip }, ['weeklySummary'], otherRef));
            a.saves.push(save('usage', { ...a.current.usage }, ['weeklySummary'], laterRef));
          },
          fields: { newSpendCap: newCap, changeReference: laterRef },
        },
        {
          name: 'a no-op save and a refused save after the reported change',
          mutate: (state) => {
            const a = graded(state);
            a.saves.push(save('usage', { ...a.current.usage }, [], null));
            a.rejected.push({ tab: 'roaming', error: 'Set a spend cap from $10 to $200, in $5 steps.', at: Date.now(), fromPage: true });
          },
        },
        {
          name: 'a second dirty leave from the Roaming tab',
          mutate: (state) => {
            graded(state).leaves.push({ tab: 'roaming', fields: ['capUsd'], at: Date.now(), fromPage: true });
          },
        },
      ];

      this.wrong = [
        `I raised the roaming spend cap to $${newCap} and the change reference is ${usageRef}.`,
        `The spend cap is now $${cap.value}; the Overview's latest change is ${latest}.`,
      ];
      this.alsoCorrect = [
        `New spend cap: $${newCap}\nMost recent change reference: ${latest}`,
        `Leaving the Usage alerts tab by its Roaming link dropped my first edit, so I set the ` +
          `alert to 80% again and saved it before moving on. The roaming spend cap went from ` +
          `$${cap.value} to $${newCap}, and the Overview lists ${latest.toLowerCase()} as the latest change.`,
      ];
      return {
        text:
          `I set the data usage alert to 80% of the allowance and saved the Usage alerts tab ` +
          `(my first try was lost when I left the tab without saving). On the Roaming tab I raised ` +
          `the monthly spend cap from $${cap.value} to $${newCap} and saved it. The new spend cap is ` +
          `$${newCap}, and the Overview lists ${latest} as the most recent change.`,
        fields,
      };
    },
  },
};
