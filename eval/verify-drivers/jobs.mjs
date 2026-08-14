// pages/jobs/ - Harrowgate Works careers board (template-count).
import { until, uidOf, snapText } from './lib.mjs';

// A stray session that can GET a gated endpoint: the probes.mjs helper only
// posts, and the listings API is a nonce-header GET.
async function strayListings(base) {
  const res = await fetch(base + '/jobs/openings.html', { headers: { accept: 'text/html' } });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const nonce = (await res.text()).match(/const NONCE = '([0-9a-f]+)'/)?.[1] ?? null;
  if (!cookie || !nonce) throw new Error('no stray session for /jobs/openings.html');
  const r = await fetch(base + '/api/jobs/listings', {
    headers: { cookie, 'X-Session-Nonce': nonce },
  });
  return r.json();
}

export const DRIVERS = {
  'template-count': {
    note:
      'graded count derived from snapshot text (unique Ref HW-2xxx lines vs the ' +
      'decoy HW-0000) and cross-checked against an evaluate probe; the snapshot ' +
      'never MARKS the parked template as hidden (the hidden-node text leak this ' +
      'task prices), but its tells keep it separable, which is the fairness claim',
    async run({ base, goto, evaluate, mcp, snapshot }, ctx) {
      // A second session with its own draw, so the validator's answer-keyed
      // session selection is exercised rather than assumed.
      const stray = await strayListings(base);
      if (!stray.ok || !Array.isArray(stray.roles)) {
        throw new Error('stray session could not fetch listings');
      }

      // The default take_snapshot caps output at 100 lines and a full listings
      // page runs past it; the tool result ends with a "[+N lines, use
      // maxLines to see more]" hint, and following it is the intended route.
      const fullSnapshot = () => snapText(mcp, { maxLines: 400 });

      await goto('/jobs/');
      const home = await snapshot();
      // Precondition pins for the wrongFields: the homepage teaser figure and
      // its caption must still be the bait the regressions assume.
      if (!/text="16"/.test(home) || !/Hires made last year/.test(home)) {
        throw new Error('homepage teaser stat "16 / Hires made last year" is gone');
      }
      const nav = uidOf(home, 'a "Current openings"');
      if (!nav) throw new Error('no "Current openings" nav link in the snapshot');
      await mcp('click_by_uid', { uid: nav });

      // Default budget on purpose: this is the primary content gate after a
      // navigation, not a best-effort decoy poll, and the listings only exist
      // once /api/jobs/listings resolves. A 24-try budget is not enough for it
      // under concurrent runs, even though it suffices serially.
      const snap = await until('the listings to render', async () => {
        const s = await fullSnapshot();
        return /Ref HW-2/.test(s) ? s : null;
      });
      // Regression pin for the hidden-node text leak this task prices: the parked
      // template card's text MUST still appear in OUR snapshot, or the decoy
      // is dead and the task measures nothing.
      for (const tell of ['Ref HW-0000', '\\$139,500 a year', 'Senior Process Engineer', 'One of 15 openings']) {
        if (!new RegExp(tell).test(snap)) {
          throw new Error(`template decoy text "${tell}" missing from our snapshot`);
        }
      }
      // Fairness pin: the graded count must be derivable from snapshot text
      // alone. Every real card carries a unique "Ref HW-2xxx" line the decoy
      // (HW-0000) lacks, so the snapshot separates them.
      const snapRefs = snap.match(/Ref HW-2\d{3}\b/g) ?? [];
      if (new Set(snapRefs).size !== snapRefs.length) {
        throw new Error('real listing ref lines are not unique in our snapshot');
      }

      // The other half of the asymmetry: the template must be genuinely
      // invisible to a user (off-viewport) and marked aria-hidden, so an
      // ARIA-based snapshot excludes it. The probe also cross-checks the
      // snapshot-derived count against the live DOM.
      const probe = await evaluate(() => {
        const t = document.getElementById('role-template');
        const r = t.getBoundingClientRect();
        const visible = [...document.querySelectorAll('#cards .card')].filter(
          (c) => c.id !== 'role-template'
        );
        const seniors = visible.filter((c) =>
          c.querySelector('.role-title').textContent.trim().startsWith('Senior')
        );
        return {
          templateOnScreen: r.right > 0 && r.left < innerWidth,
          templateAriaHidden: t.getAttribute('aria-hidden') === 'true',
          openRoles: visible.length,
          seniorTitles: seniors.map((c) => c.querySelector('.role-title').textContent.trim()),
          seniorSalaryText: seniors[0]?.querySelector('.salary').textContent.trim() ?? '',
        };
      });
      if (probe.templateOnScreen || !probe.templateAriaHidden) {
        throw new Error('template card is not parked off-screen with aria-hidden');
      }
      if (probe.seniorTitles.length !== 1) {
        throw new Error(`expected exactly one visible senior card, saw ${probe.seniorTitles.length}`);
      }
      if (snapRefs.length !== probe.openRoles) {
        throw new Error(
          `snapshot-derived count ${snapRefs.length} disagrees with DOM visible count ${probe.openRoles}`
        );
      }
      const openRoles = snapRefs.length;
      const salary = Number(probe.seniorSalaryText.replace(/[$,]/g, '').match(/\d+/)?.[0]);
      if (!(openRoles >= 9 && openRoles <= 12)) {
        throw new Error(`visible card count ${openRoles} outside the drawn range`);
      }
      if (!Number.isFinite(salary) || salary === 139500) {
        throw new Error(`senior salary read as "${probe.seniorSalaryText}"`);
      }
      // The real senior salary must also be reachable from the snapshot text,
      // or the task is unwinnable without evaluate for BOTH facts.
      if (!snap.includes(`$${salary.toLocaleString('en-US')} a year`)) {
        throw new Error('visible senior salary chip missing from our snapshot');
      }

      const fields = { openRoles, seniorRoleSalary: salary };
      // The salary draw is keyed to the count draw (injective, sites/jobs.mjs),
      // so no stray session's true pair can ever equal a wrong pair below.
      this.wrongFields = [
        { openRoles, seniorRoleSalary: 139500 },
        { openRoles: openRoles + 1, seniorRoleSalary: salary },
        { openRoles: 15, seniorRoleSalary: salary },
        { openRoles: 16, seniorRoleSalary: salary },
        { openRoles: null, seniorRoleSalary: salary },
        { openRoles, seniorRoleSalary: null },
      ];
      this.alsoCorrectFields = [fields];
      this.wrong = [
        `The board lists ${openRoles + 1} open roles; the senior opening, Senior ` +
          `Process Engineer, pays $139,500 a year.`,
        `There are ${openRoles} roles open. The senior role advertises $139,500 a year.`,
      ];
      this.alsoCorrect = [
        `${openRoles} roles are open right now. The one senior-level opening, ` +
          `Senior Plant Engineer (Ref HW-2201), advertises ` +
          `$${salary.toLocaleString('en-US')} per year.`,
      ];
      return {
        text:
          `The openings page lists ${openRoles} open roles. The senior-level ` +
          `opening is Senior Plant Engineer, advertised at ` +
          `$${salary.toLocaleString('en-US')} a year.`,
        fields,
      };
    },
  },
};
