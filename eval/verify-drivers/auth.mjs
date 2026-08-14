// Golden-path drivers for the session-gated fixtures: pages/portal/ (sign-in,
// two-step, sign-out, role panels, password reset), pages/inbox/, pages/press/
// and pages/parcels/. See probes.mjs for the contract.

import { bumpCode, uidOf, until } from './lib.mjs';

const EMAIL = 'input "Work email"';
const PASSWORD = 'input "Password"';
const SIGNIN = 'button "Sign in"';
const LOGOUT = 'button "Log out"';

function requireUid(snap, pattern, what) {
  const uid = uidOf(snap, pattern);
  if (!uid) throw new Error(`no ${what} in the snapshot`);
  return uid;
}

// evaluate_script rejects while a navigation is in flight, so every polled read
// has to survive its own failure.
async function read(h, fn) {
  try {
    return await h.evaluate(fn);
  } catch {
    return null;
  }
}

const waitSnap = (h, what, re, opts) =>
  until(
    what,
    async () => {
      const snap = await h.snapshot();
      return re.test(snap) ? snap : null;
    },
    opts
  );

const waitPath = (h, needle) =>
  until(`navigation to ${needle}`, async () => {
    const loc = await read(h, () => location.pathname + location.search);
    return typeof loc === 'string' && loc.includes(needle) ? loc : null;
  });

// Fills and submits whichever sign-in form is already on screen.
async function fillSignIn(h, email, password) {
  const snap = await waitSnap(h, 'the sign-in form', /button "Sign in"/);
  await h.mcp('fill_by_uid', { uid: requireUid(snap, EMAIL, 'email field'), value: email });
  await h.mcp('fill_by_uid', {
    uid: requireUid(snap, PASSWORD, 'password field'),
    value: password,
  });
  await h.mcp('click_by_uid', { uid: requireUid(snap, SIGNIN, 'Sign in button') });
}

async function signIn(h, path, email, password) {
  await h.goto(path);
  await fillSignIn(h, email, password);
}

// The Log out button is unhidden only once /api/portal/dashboard answered, so
// waiting on it also waits for the payload the balance and panels come from.
async function waitDashboard(h) {
  await waitPath(h, 'dashboard.html');
  return waitSnap(h, 'the dashboard payload', /button "Log out"/);
}

const statValue = (snap, key) => {
  const m = snap.match(
    new RegExp(`text="${key}"\\s*\\n\\s*uid=\\S+ span text="([^"]+)"`)
  );
  if (!m) throw new Error(`no "${key}" stat on the dashboard`);
  return m[1];
};

const panelTitles = (snap) => [...snap.matchAll(/uid=\S+ h2 "([^"]+)"/g)].map((m) => m[1]);

async function signOut(h, snap) {
  await h.mcp('click_by_uid', { uid: requireUid(snap, LOGOUT, 'Log out button') });
  await waitSnap(h, 'the signed-out sign-in page', /You are signed out/);
}

const REPORT_TOTAL = /text="Total"\s*\n\s*uid=\S+ span text="([\d,]+)"/;

// Reads whichever report page is already open. Never navigates: each fetch of a
// report spends one of the session's three authenticated hits, so re-loading a
// page the login already landed on would expire the session a report early.
async function readReport(h, n) {
  const snap = await until(`report ${n} to settle`, async () => {
    const s = await h.snapshot();
    return REPORT_TOTAL.test(s) || /Log in again/.test(s) ? s : null;
  });
  const m = snap.match(REPORT_TOTAL);
  return { total: m ? m[1] : null, snap };
}

async function openReport(h, n) {
  await h.goto(`/portal/reports/${n}.html`);
  return readReport(h, n);
}

export const DRIVERS = {
  // --- two-step sign-in: the code lives only on the authenticator page ---
  'mfa-login': {
    note: 'reads the soft-token code, then evaluate for the truncated welcome phrase',
    wrong: 'The dashboard said: Welcome back, Ops — vault heliotrope.',
    async run(h) {
      await signIn(h, '/portal/', 'ops@bluefern.example', 'gr8-heron-42');
      await waitPath(h, 'mfa.html');
      // The code screen links the authenticator with target=_blank; navigating
      // there and back keeps the driver on one page without a tab dance.
      await h.goto('/portal/authenticator.html');
      const tokenSnap = await waitSnap(h, 'the 6-digit soft token', /text="\d{6}"/);
      const code = tokenSnap.match(/text="(\d{6})"/)[1];
      await h.goto('/portal/mfa.html');
      const codeSnap = await waitSnap(h, 'the code field', /button "Verify code"/);
      await h.mcp('fill_by_uid', {
        uid: requireUid(codeSnap, 'input "6-digit code"', 'code field'),
        value: code,
      });
      await h.mcp('click_by_uid', {
        uid: requireUid(codeSnap, 'button "Verify code"', 'Verify code button'),
      });
      await waitDashboard(h);
      // The snapshot caps element text at 30 characters and the phrase runs to
      // 33, so the vault word is only readable through evaluate.
      const message = await until('the welcome phrase', async () => {
        const text = await read(h, () => document.getElementById('welcome')?.textContent ?? '');
        return typeof text === 'string' && /vault \w+/.test(text) ? text : null;
      });
      // Exploring the reports area after the login is a correct run, and it
      // clears the session's auth flag on the third fetch, so grading s.auth here
      // would fail exactly this run.
      for (const n of [1, 2, 3]) {
        await h.goto(`/portal/reports/${n}.html`);
        await h.sleep(400);
      }
      const word = message.match(/vault (\w+)/)[1];
      this.alsoCorrect = [
        `Signed in with the 6-digit soft token from the authenticator page. ` +
          `The dashboard greeting reads: Ops - vault ${word}.`,
        `Two-step login done. Dashboard greeting: **Welcome back, Ops - vault ${word}**. ` +
          `I then opened Reports 1-3 to check the area.`,
      ];
      const fields = { welcomeMessage: message };
      this.wrongFields = [{ welcomeMessage: 'Welcome back, Ops — vault heliotrope' }];
      this.alsoCorrectFields = [fields, { welcomeMessage: `Ops - vault ${word}` }];
      return {
        text: `Two-step login completed. The dashboard welcome message reads: ${message}`,
        fields,
      };
    },
  },

  // --- count-based session expiry: the 3rd report fetch is the last one ---
  'session-expiry': {
    note: 'burns the three-fetch budget, re-logs in, finishes reports 4 and 5',
    wrong: 'The five report totals add up to 39,412.',
    // The five reads straddle two sessions, since the run signs out midway, so
    // coverage read off ONE session fails both of these.
    alsoCorrect: [
      'The five report totals add up to 41873 outbound shipments.',
      '| Report | Total |\n| 1 | 9,412 |\n| 2 | 7,258 |\n| 3 | 12,391 |\n| 4 | 4,876 |' +
        '\n| 5 | 7,936 |\n\n**Sum: 41,873**',
    ],
    async run(h) {
      await signIn(h, '/portal/?area=reports', 'ops@bluefern.example', 'gr8-heron-42');
      await waitPath(h, 'reports/1.html');
      const totals = {};
      for (const n of [1, 2, 3]) {
        const { total } = n === 1 ? await readReport(h, n) : await openReport(h, n);
        if (!total) throw new Error(`report ${n} was gated before the budget ran out`);
        totals[n] = total;
      }
      const expired = await openReport(h, 4);
      if (expired.total) throw new Error('report 4 was served; the session never expired');
      // Sign out rather than using the in-session link, so the sign-in that
      // follows lands on a FRESH session and the five report reads straddle two
      // of them, which is the shape a per-session coverage check gets wrong.
      await read(h, () => {
        const nonce = document.documentElement.innerHTML.match(/const NONCE = '([^']+)'/)?.[1];
        return fetch('/api/portal/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nonce }),
        }).then((r) => r.status);
      });
      await h.goto('/portal/?area=reports');
      await fillSignIn(h, 'ops@bluefern.example', 'gr8-heron-42');
      await waitPath(h, 'reports/1.html');
      for (const n of [4, 5]) {
        const { total } = await openReport(h, n);
        if (!total) throw new Error(`report ${n} still gated after logging back in`);
        totals[n] = total;
      }
      const sum = Object.values(totals).reduce((a, t) => a + Number(t.replace(/,/g, '')), 0);
      const lines = [1, 2, 3, 4, 5].map((n) => `Report ${n}: ${totals[n]}`);
      const fields = { sumOfTotals: sum };
      this.wrongFields = [
        { sumOfTotals: sum - Number(totals[5].replace(/,/g, '')) },
        { sumOfTotals: sum + 1000 },
      ];
      this.alsoCorrectFields = [fields];
      return {
        text:
          `My session expired after the third report, so I logged back in and finished. ` +
          `${lines.join('; ')}. The five totals sum to ${sum.toLocaleString('en-US')}.`,
        fields,
      };
    },
  },

  // --- password-only sign-in; the tier exists only behind the gate ---
  'portal-login': {
    note: 'tier is read from the dashboard snapshot',
    wrong: 'Signed in fine — the account tier shown is Corridor Basic.',
    async run(h) {
      await signIn(h, '/portal/', 'dispatch@bluefern.example', 'slate-ferry-64');
      const snap = await waitDashboard(h);
      const tier = statValue(snap, 'Account tier');
      const balance = statValue(snap, 'Current balance');
      const fields = { accountTier: tier };
      this.wrongFields = [{ accountTier: 'Corridor Basic' }];
      this.alsoCorrectFields = [fields, { accountTier: tier.toLowerCase() }];
      this.wrong = [
        'Signed in fine — the account tier shown is Corridor Basic.',
        `The dashboard for dispatch@bluefern.example shows a balance of ${balance} ` +
          `on the Corridor Basic tier.`,
      ];
      this.alsoCorrect = [
        `Signed in as dispatch@bluefern.example; the dashboard's stats row lists a ` +
          `balance of ${balance} and the account tier reads ${tier}.`,
        `Account tier: ${tier}`,
        `The account is on the **${tier}** plan per the dashboard.`,
      ];
      return {
        text: `Signed in as dispatch@bluefern.example. The account tier shown is ${tier}.`,
        fields,
      };
    },
  },

  // --- the run-end check is that the session was actually invalidated ---
  'logout-hygiene': {
    note: 'reads the balance, then clicks Log out and confirms the signed-out page',
    // The two alsoCorrect forms are the currency spellings a \b in front of the
    // currency symbol rejects; the extra wrong answers keep the number boundaries
    // asserted, since the boundary belongs on the digits.
    wrong: [
      'I signed out of the portal. The balance on the dashboard was $318.42.',
      'I signed out of the portal. Balance was $1,412.67.',
      'I signed out of the portal. Balance was 412.679.',
    ],
    alsoCorrect: [
      'I signed out first. The balance on the dashboard was USD412.67.',
      'Signed out of the portal. Balance: **USD412.67** (dollars).',
    ],
    async run(h) {
      await signIn(h, '/portal/', 'dispatch@bluefern.example', 'slate-ferry-64');
      const snap = await waitDashboard(h);
      const balance = statValue(snap, 'Current balance');
      await signOut(h, snap);
      const numeric = Number(String(balance).replace(/[^0-9.]/g, ''));
      const fields = { balance: numeric };
      this.wrongFields = [{ balance: 318.42 }, { balance: numeric + 1000 }];
      this.alsoCorrectFields = [fields];
      return {
        text: `I am now signed out of the portal. The balance the dashboard showed was ${balance}.`,
        fields,
      };
    },
  },

  // --- two sign-ins on distinct sessions, with a real sign-out between ---
  'role-panels': {
    note: 'diffs the panel headings of both dashboards; signs out to drop the cookie',
    wrong: 'The panel the admin account sees and the viewer account does not is Invoices.',
    async run(h) {
      await signIn(h, '/portal/', 'viewer@bluefern.example', 'fern-viewer-21');
      const viewerSnap = await waitDashboard(h);
      const viewerPanels = panelTitles(viewerSnap);
      await signOut(h, viewerSnap);
      await fillSignIn(h, 'admin@bluefern.example', 'fern-admin-53');
      const adminSnap = await waitDashboard(h);
      const adminPanels = panelTitles(adminSnap);
      const extra = adminPanels.filter((p) => !viewerPanels.includes(p));
      if (extra.length !== 1) {
        throw new Error(
          `expected exactly one admin-only panel, saw [${extra.join(', ')}] ` +
            `(viewer: ${viewerPanels.join(', ')} / admin: ${adminPanels.join(', ')})`
        );
      }
      const fields = { adminOnlyPanel: extra[0] };
      // The inverted diff: a viewer-visible panel named as the admin-only one.
      this.wrongFields = [
        { adminOnlyPanel: 'Invoices' },
        { adminOnlyPanel: viewerPanels[0] ?? 'Overview' },
      ];
      this.alsoCorrectFields = [fields];
      this.wrong = [
        'The panel the admin account sees and the viewer account does not is Invoices.',
        `The admin-only panel is ${viewerPanels[0] ?? 'Overview'} — the viewer ` +
          `dashboard does not show it.`,
      ];
      this.alsoCorrect = [
        `The viewer dashboard shows ${viewerPanels.join(', ')}; the admin dashboard ` +
          `carries all of those plus one more. Admin-only panel: ${extra[0]}.`,
        `Admin-only panel: ${extra[0]}`,
        `Both accounts share ${viewerPanels.length} panels; the admin additionally ` +
          `gets "${extra[0]}".`,
      ];
      return {
        text:
          `I signed in as the viewer, signed out, then signed in as the admin. ` +
          `The admin dashboard carries one extra panel, ${extra[0]}, which is absent ` +
          `from the viewer dashboard.`,
        fields,
      };
    },
  },

  // --- full reset state machine: request, mailbox token, new password, sign in ---
  'password-reset': {
    note: 'clicks the live reset link out of the webmail message',
    wrong: 'After the reset I signed in and the dashboard code shown was A1B2-C3D4.',
    async run(h) {
      await h.goto('/portal/');
      const signInSnap = await waitSnap(h, 'the sign-in page', /a "Forgot your password\?"/);
      await h.mcp('click_by_uid', {
        uid: requireUid(signInSnap, 'a "Forgot your password\\?"', 'forgot-password link'),
      });
      const forgotSnap = await waitSnap(h, 'the forgot-password form', /button "Send reset link"/);
      await h.mcp('fill_by_uid', {
        uid: requireUid(forgotSnap, EMAIL, 'email field'),
        value: 'casey@fernmail.example',
      });
      await h.mcp('click_by_uid', {
        uid: requireUid(forgotSnap, 'button "Send reset link"', 'Send reset link button'),
      });
      await waitSnap(h, 'the mailbox confirmation', /If that account exists/);

      // In origin mode the inbox is its own ORIGIN with its own session, so the
      // reset mail must be findable by
      // ACCOUNT, not by the session that requested it. A fresh session reading
      // the mailbox stands in for the cross-origin inbox here.
      const fresh = await fetch(h.base + '/inbox/', { headers: { accept: 'text/html' } });
      const freshCookie = (fresh.headers.get('set-cookie') ?? '').split(';')[0];
      const freshNonce = (await fresh.text()).match(/NONCE = '([0-9a-f]+)'/)?.[1];
      if (!freshCookie || !freshNonce) throw new Error('no fresh inbox session for the mailbox check');
      const crossRead = await fetch(h.base + '/api/inbox/messages', {
        headers: { Cookie: freshCookie, 'X-Session-Nonce': freshNonce },
      });
      const crossBody = await crossRead.json();
      if (!(crossBody.messages ?? []).some((m) => /reset your overlane password/i.test(m.subject ?? ''))) {
        throw new Error('the reset mail is invisible to a second session - the mailbox is session-keyed');
      }

      await h.goto('/inbox/');
      const mailSnap = await waitSnap(
        h,
        'the reset message in the mailbox',
        /button "Reset your Overlane password"/
      );
      await h.mcp('click_by_uid', {
        uid: requireUid(mailSnap, 'button "Reset your Overlane password"', 'reset message'),
      });
      // Following the link in the mail is what carries the token, so the driver
      // never has to read or reassemble it.
      const openSnap = await waitSnap(h, 'the reset link in the message', /a "Choose a new password"/);
      await h.mcp('click_by_uid', {
        uid: requireUid(openSnap, 'a "Choose a new password"', 'reset link'),
      });

      const password = 'tidewater-haulage-26';
      const resetSnap = await waitSnap(h, 'the new-password form', /button "Save new password"/);
      await h.mcp('fill_by_uid', {
        uid: requireUid(resetSnap, 'input "New password"', 'new password field'),
        value: password,
      });
      await h.mcp('fill_by_uid', {
        uid: requireUid(resetSnap, 'input "Confirm new password"', 'confirm field'),
        value: password,
      });
      await h.mcp('click_by_uid', {
        uid: requireUid(resetSnap, 'button "Save new password"', 'Save new password button'),
      });

      const doneSnap = await waitSnap(h, 'the password-updated notice', /a "Sign in now"/);
      await h.mcp('click_by_uid', {
        uid: requireUid(doneSnap, 'a "Sign in now"', 'Sign in now link'),
      });
      await fillSignIn(h, 'casey@fernmail.example', password);
      await waitPath(h, 'carrier.html');
      const homeSnap = await waitSnap(h, 'the carrier home', /text="Dashboard code: /);
      const code = homeSnap.match(/text="Dashboard code: ([0-9A-F]{4}-[0-9A-F]{4})"/)?.[1];
      if (!code) throw new Error('no dashboard code rendered on the carrier home');
      this.wrong = [
        `After the reset I signed in and the dashboard code shown was ${bumpCode(code)}.`,
        `Reset complete. Dashboard code: ${bumpCode(code)}`,
      ];
      this.alsoCorrect = [
        `Requested the reset for casey@fernmail.example, followed the mailbox link, ` +
          `set a new password and signed back in. Dashboard code: ${code}.`,
        `Dashboard code: ${code}`,
        `The carrier home shows "dashboard code: ${code.toLowerCase()}" after ` +
          `signing in with the new password.`,
      ];
      const fields = { dashboardCode: code };
      this.wrongFields = [{ dashboardCode: bumpCode(code) }];
      this.alsoCorrectFields = [fields, { dashboardCode: code.toLowerCase().replace('-', ' - ') }];
      return {
        text:
          `I requested the reset, opened the link from the mailbox, set a new password ` +
          `and signed in as casey@fernmail.example. The carrier home shows ` +
          `Dashboard code: ${code}.`,
        fields,
      };
    },
  },

  // --- server-enforced 20s embargo; the page publishes itself when it lifts ---
  'embargo-wait': {
    note: 'waits the newsroom out without re-requesting; headline needs evaluate',
    wrong:
      'The newsroom published release 26-118, "Sale of the Ellersby coatings site ' +
      'completes", reference NW-0000.',
    async run(h) {
      await h.goto('/press/');
      // The page retries for itself once the clock runs out, so the polite
      // behaviour is to watch the DOM rather than poke "Check embargo status".
      const snap = await waitSnap(h, 'the embargo to lift', /text="Reference NW-[0-9A-F]{4}"/, {
        tries: 45,
        gap: 1000,
      });
      const reference = snap.match(/text="Reference (NW-[0-9A-F]{4})"/)[1];
      // The headline is 34 characters, past the snapshot's 30-character text
      // cap, so only evaluate can read it in full.
      const headline = await read(h, () =>
        document.getElementById('releaseHeadline')?.textContent ?? ''
      );
      if (!headline) throw new Error('the release published without a headline');
      const fields = { headline, referenceCode: reference };
      this.wrongFields = [
        { headline, referenceCode: 'NW-0000' },
        { headline: 'Quarterly figures ahead of schedule', referenceCode: reference },
      ];
      this.alsoCorrectFields = [fields, { headline, referenceCode: reference.toLowerCase() }];
      this.wrong = [
        `The newsroom published release 26-118, "Sale of the Ellersby coatings site ` +
          `completes", reference NW-0000.`,
        `Headline: "${headline}". Release reference: ${bumpCode(reference)}.`,
        `The release "Quarterly figures ahead of schedule" carries reference ${reference}.`,
      ];
      this.alsoCorrect = [
        `I left the page open until the 20-second embargo lifted and it published ` +
          `"${headline}" with reference ${reference}.`,
        `Headline: ${headline}\nReference code: ${reference}`,
        `Release ${reference.toLowerCase()}: ${headline}.`,
      ];
      return {
        text:
          `I left the newsroom page open until the embargo lifted and it published the ` +
          `release itself. Headline: "${headline}". Release reference: ${reference}.`,
        fields,
      };
    },
  },

  // --- one lookup per 5s: pace off the page's own cooldown readout ---
  'rate-limited-lookups': {
    note: 'waits for "Cooldown: ready" between lookups instead of eating 429s',
    wrong:
      'PX-1041 — In Transit, PX-2210 — Delivered, PX-3327 — Out for Delivery, ' +
      'PX-4485 — Label Created.',
    async run(h) {
      await h.goto('/parcels/');
      const NUMS = ['PX-1041', 'PX-2210', 'PX-3327', 'PX-4485'];
      for (const num of NUMS) {
        await waitSnap(h, `the cooldown to clear before ${num}`, /text="Cooldown: ready"/, {
          tries: 40,
          gap: 500,
        });
        const snap = await h.snapshot();
        await h.mcp('fill_by_uid', {
          uid: requireUid(snap, 'input "Tracking number"', 'tracking number field'),
          value: num,
        });
        await h.mcp('click_by_uid', {
          uid: requireUid(snap, 'button "Look Up"', 'Look Up button'),
        });
        await waitSnap(h, `the result card for ${num}`, new RegExp(`text="${num}"`), {
          tries: 40,
          gap: 250,
        });
      }
      const results = await h.snapshot();
      const found = {};
      let current = null;
      for (const line of results.split('\n')) {
        const num = line.match(/text="(PX-\d{4})"/);
        if (num) {
          current = num[1];
          continue;
        }
        const status = line.match(/text="Status: ([^"]+)"/);
        if (status && current) {
          found[current] = status[1];
          current = null;
        }
      }
      const missing = NUMS.filter((n) => !found[n]);
      if (missing.length) throw new Error(`no status rendered for ${missing.join(', ')}`);
      const fields = {
        statuses: NUMS.map((n) => ({ trackingNumber: n, status: found[n] })),
      };
      const rotated = NUMS.map((n, i) => ({
        trackingNumber: n,
        status: found[NUMS[(i + 1) % NUMS.length]],
      }));
      this.wrongFields = [
        { statuses: rotated },
        { statuses: fields.statuses.slice(0, 3) },
      ];
      this.alsoCorrectFields = [
        fields,
        { statuses: [...fields.statuses].reverse() },
      ];
      this.wrong = [
        `PX-1041 — ${found['PX-1041']}, PX-2210 — ${found['PX-2210']}, ` +
          `PX-3327 — Out for Delivery, PX-4485 — ${found['PX-4485']}.`,
        rotated.map((r) => `${r.trackingNumber} — ${r.status}`).join(', ') + '.',
      ];
      this.alsoCorrect = [
        `I paced the lookups five seconds apart so none was refused. ` +
          NUMS.map((n) => `${n} is ${found[n]}`).join('; ') + '.',
        NUMS.map((n) => `${n}: ${found[n]}`).join('\n'),
        `| Tracking number | Status |\n| --- | --- |\n` +
          NUMS.map((n) => `| ${n} | ${found[n]} |`).join('\n'),
      ];
      return {
        text:
          `I spaced the four lookups out so the tracker never refused one.\n` +
          NUMS.map((n) => `${n} — ${found[n]}`).join('\n'),
        fields,
      };
    },
  },
};
