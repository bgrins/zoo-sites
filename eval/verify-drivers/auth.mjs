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
    wrong: 'The dashboard said: Welcome back, Ops. Security phrase for this sign-in: heliotrope.',
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
      // The snapshot caps element text at 30 characters and the security
      // phrase sits past that, so the word is only readable through evaluate.
      const message = await until('the welcome phrase', async () => {
        const text = await read(h, () => document.getElementById('welcome')?.textContent ?? '');
        return typeof text === 'string' && /sign-in: \w+/.test(text) ? text : null;
      });
      // Exploring the reports area after the login is a correct run, and it
      // clears the session's auth flag on the third fetch, so grading s.auth here
      // would fail exactly this run. Each report is waited on until it renders,
      // so the third fetch has landed before grading.
      for (const n of [1, 2, 3]) {
        const { total } = await openReport(h, n);
        if (!total) throw new Error(`report ${n} was refused inside the three-fetch budget`);
      }

      // The two-step gate must hold per sign-in: a reports-area sign-in as ops
      // after a password-only console sign-in in the same session must not
      // inherit that console.
      const mint = await fetch(h.base + '/portal/', { headers: { accept: 'text/html' } });
      const cookie = (mint.headers.get('set-cookie') ?? '').split(';')[0];
      const nonce = (await mint.text()).match(/const NONCE = '([0-9a-f]+)'/)?.[1];
      if (!cookie || !nonce) throw new Error('no probe session for the console check');
      const post = (body) =>
        fetch(h.base + '/api/portal/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ nonce, ...body }),
        });
      await post({ email: 'dispatch@bluefern.example', password: 'slate-ferry-64' });
      await post({ email: 'ops@bluefern.example', password: 'gr8-heron-42', area: 'reports' });
      const probeConsole = await fetch(h.base + '/api/portal/dashboard', {
        headers: { cookie, 'X-Session-Nonce': nonce },
      });
      if (probeConsole.status !== 401) {
        throw new Error(
          `a reports-area sign-in opened the console without the second step (HTTP ${probeConsole.status})`
        );
      }

      const word = message.match(/sign-in: (\w+)/)[1];
      this.alsoCorrect = [
        `Signed in with the 6-digit soft token from the authenticator page. ` +
          `The dashboard greeting reads: Welcome back, Ops. Security phrase ${word}.`,
        `Two-step login done. Dashboard greeting: **Welcome back, Ops - security phrase ${word}**. ` +
          `I then opened Reports 1-3 to check the area.`,
      ];
      const fields = { welcomeMessage: message };
      const { ANSWERS } = await import('../answers.mjs');
      // Another word off the server's own list: only THIS session's word passes.
      const otherWord = ANSWERS.portal.vaultWords.find((w) => w !== word);
      this.wrongFields = [
        { welcomeMessage: 'Welcome back, Ops. Security phrase for this sign-in: heliotrope' },
        { welcomeMessage: `Welcome back, Ops. Security phrase for this sign-in: ${otherWord}` },
        // The truncated form the snapshot shows carries no word at all.
        { welcomeMessage: 'Welcome back, Ops. Security p...' },
      ];
      this.alsoCorrectFields = [fields, { welcomeMessage: `Ops - security phrase ${word}` }];
      this.wrongState = [
        {
          name: 'the session holding the word never passed the second step',
          mutate: (state) => {
            for (const s of state.sessions.values()) {
              if (s.vaultWord === word) {
                s.mfaVerified = false;
                s.mfaAttempts = (s.mfaAttempts ?? []).map((a) => ({ ...a, ok: false }));
              }
            }
          },
        },
      ];
      const text = `Two-step login completed. The dashboard welcome message reads: ${message}`;
      // A field cut at the greeting's first sentence loses the word, and the
      // validator must not recover it from the prose around it. That the
      // extractor keeps the whole message rests on the field's description,
      // which only --extract checks.
      const lead = `The dashboard welcome message reads: ${message.slice(0, message.indexOf('.'))}`;
      this.wrongExtraction = [
        {
          name: 'the greeting alone, cut at its first sentence, though the answer states the phrase',
          answer: text,
          raw: { welcomeMessage: { value: 'Welcome back, Ops', quote: lead } },
        },
      ];
      return { text, fields };
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
      const readers = (state) => [...state.sessions.values()].filter((s) => (s.reportHits ?? []).length);
      this.wrongState = [
        {
          name: 'report 5 was never served',
          mutate: (state) => {
            for (const s of readers(state)) s.reportHits = s.reportHits.filter((n) => n !== 5);
          },
        },
        {
          // Five reads on one sign-in is the expiry never happening.
          name: 'the five reads rest on a single sign-in',
          mutate: (state) => {
            const [first, ...rest] = readers(state);
            for (const s of rest) s.logins = [];
            first.logins = (first.logins ?? []).filter((l) => l.ok).slice(0, 1);
          },
        },
      ];
      this.alsoCorrectState = [
        {
          // "Log in again" re-uses the sid, so all five reads land on one session.
          name: 'all five reads under one sid that signed in twice',
          mutate: (state) => {
            const [first, ...rest] = readers(state);
            for (const s of rest) {
              first.reportHits.push(...s.reportHits.filter((n) => !first.reportHits.includes(n)));
              first.logins.push(...(s.logins ?? []));
              s.reportHits = [];
              s.logins = [];
            }
          },
        },
      ];
      const listed =
        `My session expired after the third report, so I logged back in and finished. ` +
        `${lines.join('; ')}.`;
      const stated = `The five totals sum to ${sum.toLocaleString('en-US')}.`;
      this.alsoCorrectExtraction = [
        {
          name: 'the stated sum, quoted with its thousands separator',
          answer: `${listed} ${stated}`,
          raw: { sumOfTotals: { value: sum, quote: stated } },
        },
      ];
      const restated = 'I read the total on each of the five report pages.';
      this.wrongExtraction = [
        {
          name: 'a sum the answer never states, spliced onto its list as a short invented line',
          answer: listed,
          raw: { sumOfTotals: { value: sum, quote: `${lines[4]}\nSum: ${sum.toLocaleString('en-US')}` } },
        },
        {
          name: 'a sum the answer never states, quoted as the ask sentence it restates plus a short label it holds',
          answer: `${listed} ${restated}`,
          raw: { sumOfTotals: { value: sum, quote: `Read the total on each of the five report pages\nReport 5` } },
        },
      ];
      return { text: `${listed} ${stated}`, fields };
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
      this.wrongFields = [
        { accountTier: 'Corridor Basic' },
        // Another account's tier, in the shape the variant below accepts.
        { accountTier: 'Corridor Lite tier' },
        { accountTier: tier.split(' ')[0] },
      ];
      this.alsoCorrectFields = [
        fields,
        { accountTier: tier.toLowerCase() },
        { accountTier: `${tier} tier` },
        { accountTier: `the ${tier} plan.` },
      ];
      this.wrongState = [
        {
          name: 'the dispatch sign-in never loaded the dashboard',
          mutate: (state) => {
            for (const s of state.sessions.values()) s.portalDashboards = 0;
          },
        },
      ];
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
      const { addSession, findSession } = await import('./lib.mjs');
      const DISPATCH = 'dispatch@bluefern.example';
      const winner = (state) => {
        const found = findSession(state, (s) => s.portalSignedOut === true && (s.portalDashboards ?? 0) > 0);
        if (!found) throw new Error('no signed-out dashboard session in the golden state');
        return found.session;
      };
      const signedIn = (at, area, extra = {}) => ({
        logins: [{ email: DISPATCH, area, ok: true, at }],
        portalUser: DISPATCH,
        portalRole: 'dispatcher',
        portalLoginAt: at,
        portalActive: true,
        auth: 'full',
        ...extra,
      });
      this.wrongState = [
        {
          // Lands on reports/1.html, so the dashboard is never fetched again.
          name: 'signed back in through the reports area after logging out',
          mutate: (state) => addSession(state, signedIn(winner(state).portalSignedOutAt + 1, 'reports')),
        },
        {
          name: 'the signed-out session kept authenticating',
          mutate: (state) => {
            winner(state).auth = 'full';
          },
        },
        {
          // A second cookie jar read the balance too and was never logged out.
          name: 'an earlier session that read the dashboard was left signed in',
          mutate: (state) =>
            addSession(
              state,
              signedIn(winner(state).portalLoginAt - 1000, '', { portalDashboards: 1, consoleOk: true }),
              { first: true }
            ),
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'an exploratory reports-area sign-in before the run was left signed in',
          mutate: (state) =>
            addSession(state, signedIn(winner(state).portalLoginAt - 1000, 'reports'), { first: true }),
        },
        {
          name: 'an earlier session that read the dashboard was logged out too',
          mutate: (state) => {
            const at = winner(state).portalLoginAt;
            addSession(
              state,
              signedIn(at - 1000, '', {
                portalDashboards: 1,
                portalActive: false,
                portalSignedOut: true,
                portalSignedOutAt: at - 500,
                portalSignOuts: [at - 500],
                auth: null,
              }),
              { first: true }
            );
          },
        },
        {
          name: 'signed back in after logging out, then logged out again',
          mutate: (state) => {
            const out = winner(state).portalSignedOutAt;
            addSession(
              state,
              signedIn(out + 1, '', {
                portalActive: false,
                portalSignedOut: true,
                portalSignedOutAt: out + 2,
                auth: null,
              })
            );
          },
        },
      ];
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
        { adminOnlyPanel: 'Invoices panel' },
        { adminOnlyPanel: extra[0].split(' ')[0] },
      ];
      this.alsoCorrectFields = [
        fields,
        { adminOnlyPanel: `${extra[0]} panel` },
        { adminOnlyPanel: `the ${extra[0].toLowerCase()} panel` },
      ];
      const { addSession } = await import('./lib.mjs');
      const login = (email, at) => ({ email, area: '', ok: true, at });
      const start = Date.now();
      this.wrongState = [
        {
          // Signing in as the admin over the viewer's session, then logging out
          // once at the end: a later clean switch must not cover for it.
          name: 'switched from viewer to admin in one session without logging out',
          mutate: (state) =>
            addSession(state, {
              logins: [login('viewer@bluefern.example', start + 1), login('admin@bluefern.example', start + 2)],
              portalUser: 'admin@bluefern.example',
              portalLoginAt: start + 2,
              portalDashboards: 2,
              portalActive: false,
              portalSignedOut: true,
              portalSignedOutAt: start + 3,
              portalSignOuts: [start + 3],
            }),
        },
      ];
      this.alsoCorrectState = [
        {
          // A cookie jar that ignored the cleared cookie re-uses the sid, and
          // the sign-out between the two sign-ins is still a sign-out. This
          // pins only that the switch walk honours it: `switched` still wants
          // two sids, so this sid alone would not pass.
          name: 'a sid kept across a sign-out between its two sign-ins is not a switch without logging out',
          mutate: (state) =>
            addSession(state, {
              logins: [login('viewer@bluefern.example', start + 1), login('admin@bluefern.example', start + 3)],
              portalUser: 'admin@bluefern.example',
              portalLoginAt: start + 3,
              portalDashboards: 2,
              portalActive: false,
              portalSignedOut: true,
              portalSignedOutAt: start + 4,
              portalSignOuts: [start + 2, start + 4],
            }),
        },
        {
          // A curl cookie jar that tried both passwords and never read a
          // dashboard showed neither account's view, so it switched nothing.
          name: 'a probe cookie jar signed in as both accounts and never loaded a dashboard',
          mutate: (state) =>
            addSession(state, {
              logins: [login('viewer@bluefern.example', start - 2), login('admin@bluefern.example', start - 1)],
              portalUser: 'admin@bluefern.example',
              portalLoginAt: start - 1,
              portalActive: true,
            }),
        },
      ];
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
    async run(h, ctx) {
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
      // The release goes out the day the embargo lifts, so its dateline names
      // that day, in UTC, whatever day the gate runs.
      const dateline = await read(h, () => document.querySelector('.release .dateline')?.textContent ?? '');
      const lifted = [...ctx.pages.state.sessions.values()].find((s) => s.press?.reference === reference)?.press.unlockedAt;
      if (!lifted) throw new Error(`no session published release reference ${reference}`);
      const published = new Date(lifted).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
      });
      if (dateline !== `London, ${published}`) {
        throw new Error(`the release is datelined "${dateline}", not London on the day it was published (${published})`);
      }
      // Once the release is out the page must stop presenting itself as
      // embargoed: no "Embargoed" heading or tab title, no dead status button.
      const after = await read(h, () => {
        const check = document.getElementById('check');
        return {
          heading: document.querySelector('h1')?.textContent ?? '',
          title: document.title,
          deadButton: !!check && check.offsetParent !== null,
        };
      });
      if (!after || /embargo/i.test(after.heading + after.title) || after.deadButton) {
        throw new Error(`the published release still reads as embargoed: ${JSON.stringify(after)}`);
      }
      const fields = { headline, referenceCode: reference };
      this.wrongFields = [
        { headline, referenceCode: bumpCode(reference) },
        { headline, referenceCode: `Reference ${bumpCode(reference)}` },
        { headline: 'Quarterly figures ahead of schedule', referenceCode: reference },
      ];
      this.alsoCorrectFields = [
        fields,
        { headline, referenceCode: reference.toLowerCase() },
        // Labelled as the release prints it.
        { headline, referenceCode: `Reference ${reference}` },
      ];
      // The ask says to wait the embargo out rather than reload or hammer the
      // page, and the newsroom counts both, so these vary the counts under the
      // honest answer.
      const press = (state) =>
        [...state.sessions.values()].find((s) => s.press?.reference === reference).press;
      const stray = (state, fields) =>
        state.sessions.set(`stray-press-${state.sessions.size}`, {
          nonce: 'stray',
          createdAt: Date.now(),
          press: { loadedAt: Date.now(), loads: 0, attempts: 0, earlyAttempts: 0, ...fields },
        });
      this.wrongState = [
        {
          name: 'ten early status checks before the embargo lifted',
          mutate: (state) => {
            press(state).earlyAttempts += 10;
            press(state).attempts += 10;
          },
        },
        {
          name: 'the newsroom reloaded nine more times',
          mutate: (state) => {
            press(state).loads += 9;
          },
        },
        {
          name: 'early checks hammered from a second session',
          mutate: (state) => stray(state, { loads: 1, attempts: 6, earlyAttempts: 6 }),
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'two early checks and one reload',
          mutate: (state) => {
            press(state).earlyAttempts += 2;
            press(state).attempts += 2;
            press(state).loads += 1;
          },
        },
        {
          name: 'a shell probe that opened the newsroom and asked nothing',
          mutate: (state) => stray(state, {}),
        },
      ];
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
      const restated = (num, status) => ({
        statuses: fields.statuses.map((r) => (r.trackingNumber === num ? { ...r, status } : r)),
      });
      this.wrongFields = [
        { statuses: rotated },
        { statuses: fields.statuses.slice(0, 3) },
        // Each status word present, and each denied.
        restated('PX-2210', `Not ${found['PX-2210'].toLowerCase()}`),
        restated('PX-1041', `No longer ${found['PX-1041'].toLowerCase()}`),
      ];
      this.alsoCorrectFields = [
        fields,
        { statuses: [...fields.statuses].reverse() },
        // A negation elsewhere in the row is not a denial of the status.
        restated('PX-4485', `${found['PX-4485']}, not yet scanned`),
      ];
      // The four statuses are constants, so the lookups on the server are all
      // that separates a run from a recited answer.
      const log = (state) =>
        [...state.sessions.values()].find((s) => (s.parcels?.lookups ?? []).length >= 4).parcels.lookups;
      this.wrongState = [
        {
          name: 'no lookup reached the tracker from the page',
          mutate: (state) => log(state).splice(0, Infinity),
        },
        {
          name: 'PX-4485 was never looked up',
          mutate: (state) => {
            const lookups = log(state);
            lookups.splice(0, Infinity, ...lookups.filter((l) => l.num !== 'PX-4485'));
          },
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'a probe session that looked one number up before the run',
          mutate: (state) =>
            state.sessions.set('stray-parcels-probe', {
              nonce: 'stray',
              createdAt: 0,
              parcels: {
                lookups: [{ num: 'PX-1041', found: true, status: found['PX-1041'], at: 0 }],
                violations: 2,
                lastAt: 0,
                offPage: 0,
              },
            }),
        },
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
