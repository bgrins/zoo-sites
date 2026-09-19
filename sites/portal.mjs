// pages/portal/ + pages/inbox/ - Overlane Carrier Access accounts, MFA, reset flow and the Fernmail inbox.
import { randomBytes } from 'node:crypto';

// pages/inbox/ (Fernmail) + pages/portal/forgot.html + reset.html — the
// password-reset state machine (password-reset). Mailbox contents, the reset
// token and the dashboard code live only here: no file under pages/ carries
// them. RESET_STALE_TOKEN is the already-expired link in the older Overlane
// notice, so a decoy click fails closed instead of shortcutting the flow.
const RESET_STALE_TOKEN = '5b7f1c92ad3e40';
const RESET_ACCOUNT = 'casey@fernmail.example';
const RESET_MAILBOX_NOTE =
  'If that account exists, a reset link is on its way to the mailbox on file.';
const RESET_MIN_LENGTH = 12;

// pages/portal/ — Overlane Carrier Access accounts. Passwords, the account
// tier, the billing balance and the per-role panel list exist only here: the
// dashboard is rendered from /api/portal/dashboard, so none of it appears in
// fixture source on disk. ops@ is the two-step account used by mfa-login and
// session-expiry; the other three sign in with a password only.
// PORTAL_TIER and PORTAL_BALANCE are the graded dispatch-account values
// (answers.mjs mirrors them); the other accounts carry their own figures.
const PORTAL_TIER = 'Corridor Plus';

const PORTAL_BALANCE = '$412.67';

// Usage and Invoices are served to every role with per-role figures. The
// viewer and admin lists must stay title-identical apart from the admin-only
// panel below: role-panels diffs h2 headings between those two dashboards.
const PORTAL_BASE_PANELS = {
  operator: [
    {
      title: 'Usage',
      note: 'Lane volume booked against your contract this cycle.',
      stats: [
        { k: 'Loads this cycle', v: '386' },
        { k: 'Contract used', v: '64%' },
        { k: 'Cycle closes', v: '31 Jul' },
      ],
    },
    {
      title: 'Invoices',
      note: 'Issued invoices, credit notes and payment status.',
      table: {
        head: ['Invoice', 'Issued', 'Amount', 'Status'],
        rows: [
          ['INV-8841', '14 Jul', '$2,180.00', 'Paid'],
          ['INV-8874', '21 Jul', '$1,940.50', 'Open'],
        ],
      },
    },
  ],
  dispatcher: [
    {
      title: 'Usage',
      note: 'Lane volume booked against your contract this cycle.',
      stats: [
        { k: 'Loads this cycle', v: '233' },
        { k: 'Contract used', v: '47%' },
        { k: 'Cycle closes', v: '31 Jul' },
      ],
    },
    {
      title: 'Invoices',
      note: 'Issued invoices, credit notes and payment status.',
      table: {
        head: ['Invoice', 'Issued', 'Amount', 'Status'],
        rows: [
          ['INV-8836', '11 Jul', '$1,065.20', 'Paid'],
          ['INV-8868', '19 Jul', '$774.80', 'Open'],
        ],
      },
    },
  ],
  viewer: [
    {
      title: 'Usage',
      note: 'Lane volume booked against your contract this cycle.',
      stats: [
        { k: 'Loads this cycle', v: '158' },
        { k: 'Contract used', v: '35%' },
        { k: 'Cycle closes', v: '31 Jul' },
      ],
    },
    {
      title: 'Invoices',
      note: 'Issued invoices, credit notes and payment status.',
      table: {
        head: ['Invoice', 'Issued', 'Amount', 'Status'],
        rows: [
          ['INV-8822', '7 Jul', '$618.40', 'Paid'],
          ['INV-8859', '17 Jul', '$530.75', 'Open'],
        ],
      },
    },
  ],
  admin: [
    {
      title: 'Usage',
      note: 'Lane volume booked against your contract this cycle.',
      stats: [
        { k: 'Loads this cycle', v: '507' },
        { k: 'Contract used', v: '72%' },
        { k: 'Cycle closes', v: '31 Jul' },
      ],
    },
    {
      title: 'Invoices',
      note: 'Issued invoices, credit notes and payment status.',
      table: {
        head: ['Invoice', 'Issued', 'Amount', 'Status'],
        rows: [
          ['INV-8830', '9 Jul', '$3,412.90', 'Paid'],
          ['INV-8871', '20 Jul', '$2,205.60', 'Open'],
        ],
      },
    },
  ],
};

// Only the admin role is served this panel; role-panels grades on its name, so
// it must never reach the viewer account's dashboard.
const PORTAL_ADMIN_PANELS = [
  {
    title: 'Audit Exports',
    note: 'Signed access and configuration change logs.',
    table: {
      head: ['Export', 'Range', 'Status'],
      rows: [
        ['Access log', '1-27 Jul', 'Ready'],
        ['Configuration changes', 'Q3 to date', 'Ready'],
        ['Sign-in history', 'Last 90 days', 'Preparing'],
      ],
    },
  },
];

const PORTAL_ACCOUNTS = {
  'ops@bluefern.example': {
    password: 'gr8-heron-42', twoStep: true, role: 'operator',
    roleLabel: 'Operator', greet: 'Ops', desk: 'Operations desk', initials: 'OD',
    tier: 'Corridor Network', balance: '$1,204.18',
  },
  'dispatch@bluefern.example': {
    password: 'slate-ferry-64', twoStep: false, role: 'dispatcher',
    roleLabel: 'Dispatcher', greet: 'Dispatch', desk: 'Dispatch desk', initials: 'DD',
    tier: PORTAL_TIER, balance: PORTAL_BALANCE,
  },
  'viewer@bluefern.example': {
    password: 'fern-viewer-21', twoStep: false, role: 'viewer',
    roleLabel: 'Viewer', greet: 'Viewer', desk: 'Read-only access', initials: 'RO',
    tier: 'Corridor Lite', balance: '$97.40',
  },
  'admin@bluefern.example': {
    password: 'fern-admin-53', twoStep: false, role: 'admin',
    roleLabel: 'Administrator', greet: 'Admin', desk: 'Carrier administrator', initials: 'CA',
    tier: 'Corridor Prime', balance: '$2,860.55',
  },
};

const INBOX_MESSAGES = [
  {
    id: 'm-114',
    folder: 'Inbox',
    from: 'Harborline Freight',
    addr: '<billing@harborline.example>',
    subject: 'Invoice HF-20418 is ready',
    when: '08:12',
    stamp: 'Today 08:12',
    unread: true,
    snippet: 'Week 29 linehaul, 14 loads, payable on 12 August.',
    body: [
      'Invoice HF-20418 covers week 29 linehaul movements, fourteen loads, and is payable on 12 August.',
      'Remittance advice can go to billing@harborline.example. Queries to your account manager, Dana Pell.',
    ],
  },
  {
    id: 'm-113',
    folder: 'Inbox',
    from: 'Coastal Wharf Co-op',
    addr: '<ops@coastalwharf.example>',
    subject: 'Berth slots for week 31',
    when: 'Yesterday',
    stamp: '26 Jul 17:40',
    unread: false,
    snippet: 'Draft allocation attached; confirm by Thursday noon.',
    body: [
      'The draft berth allocation for week 31 is out. Your two evening slots moved from 18:00 to 19:30 to make room for the dredger.',
      'Confirm or object by Thursday noon, otherwise the draft stands.',
    ],
  },
  {
    id: 'm-112',
    folder: 'Inbox',
    from: 'Fernmail Security',
    addr: '<security@fernmail.example>',
    subject: 'New sign-in on this device',
    when: 'Yesterday',
    stamp: '26 Jul 09:03',
    unread: false,
    snippet: 'Signed in from a desktop browser in Tacoma, WA.',
    body: [
      'Your Fernmail account was signed in from a desktop browser in Tacoma, WA.',
      'If this was you, nothing more is needed. If not, change your Fernmail password from Settings and sign out of other devices.',
    ],
  },
  {
    id: 'm-111',
    folder: 'Inbox',
    from: 'Overlane Carrier Access',
    addr: '<no-reply@overlane.example>',
    subject: 'Password reset requested',
    when: '24 Jul',
    stamp: '24 Jul 11:47',
    unread: false,
    snippet: 'A reset link was requested for your Overlane account.',
    body: [
      'A password reset was requested for your Overlane Carrier Access account on 24 July at 11:47.',
      'Reset links stay valid for 30 minutes. This one has since expired.',
    ],
    link: {
      text: 'Choose a new password',
      url: '/portal/reset.html?token=' + RESET_STALE_TOKEN,
    },
    tail: ['Overlane Logistics Group, 1400 Harbor Way, Suite 620, Tacoma WA 98402'],
  },
  {
    id: 'm-110',
    folder: 'Archive',
    from: 'Rendell Tyres and Fleet',
    addr: '<service@rendellfleet.example>',
    subject: 'Quarterly service reminder',
    when: '23 Jul',
    stamp: '23 Jul 07:15',
    unread: false,
    snippet: 'Three tractors are due for brake inspection.',
    body: [
      'Three tractors on your account are due for brake inspection this quarter: T-118, T-204 and T-231.',
      'Book a slot at any Rendell depot. Evening bays are quieter on Tuesdays.',
    ],
  },
  {
    id: 'm-109',
    folder: 'Inbox',
    from: 'Overlane Carrier Access',
    addr: '<no-reply@overlane.example>',
    subject: 'Scheduled maintenance notice',
    when: '21 Jul',
    stamp: '21 Jul 16:20',
    unread: false,
    snippet: 'Carrier Access is offline 27 July, 01:00 to 03:00 Pacific.',
    body: [
      'Carrier Access will be offline on 27 July between 01:00 and 03:00 Pacific for a database upgrade.',
      'Shipment feeds keep queueing during the window and drain automatically afterwards.',
    ],
  },
  {
    id: 'm-108',
    folder: 'Archive',
    from: 'Fernmail Team',
    addr: '<hello@fernmail.example>',
    subject: 'Welcome to Fernmail',
    when: '12 Jul',
    stamp: '12 Jul 10:02',
    unread: false,
    snippet: 'Import contacts, set a signature, add a second mailbox.',
    body: [
      'Your mailbox is ready. Three things worth doing early: import your contacts, set a signature, and add a recovery address.',
      'Filters live under Settings, Rules. Anything marked Spam is deleted after 30 days.',
    ],
  },
  {
    id: 'm-104',
    folder: 'Archive',
    from: 'Northgate Terminals',
    addr: '<gatehouse@northgateterminals.example>',
    subject: 'Badge renewal complete',
    when: '9 Jul',
    stamp: '9 Jul 13:31',
    unread: false,
    snippet: 'Gate badge 4471 is valid through 30 June next year.',
    body: [
      'Gate badge 4471 has been renewed and is valid through 30 June next year.',
      'Collect the printed card from the gatehouse during shift change.',
    ],
  },
  {
    id: 'm-101',
    folder: 'Archive',
    from: 'Meridian Fuel Cards',
    addr: '<statements@meridianfuel.example>',
    subject: 'June statement available',
    when: '2 Jul',
    stamp: '2 Jul 06:44',
    unread: false,
    snippet: 'June fuel card statement is ready to download.',
    body: [
      'Your June fuel card statement is ready. Total spend fell 4 percent against May.',
      'Statements stay available for 24 months in the card portal.',
    ],
  },
  {
    id: 'm-206',
    folder: 'Spam',
    from: 'Fleet Cover Direct',
    addr: '<offers@fleetcoverdirect.example>',
    subject: 'Fleet insurance quotes today',
    when: '25 Jul',
    stamp: '25 Jul 04:12',
    unread: false,
    snippet: 'Compare eleven insurers in under four minutes.',
    body: [
      'Compare eleven fleet insurers in under four minutes and keep your no-claims history.',
      'Reply STOP to stop receiving these offers.',
    ],
  },
  {
    id: 'm-301',
    folder: 'Sent',
    from: 'Overlane service desk',
    addr: '<support@overlane.example>',
    to: 'support@overlane.example',
    subject: 'Re: driver app sign-in',
    when: '24 Jul',
    stamp: '24 Jul 12:05',
    unread: false,
    snippet: 'The driver app accepts the badge number, the console does not.',
    body: [
      'The driver app accepts badge 4471 without complaint, but Carrier Access rejects the same credentials.',
      'Happy to try a reset if that is the usual fix.',
    ],
  },
  {
    id: 'm-302',
    folder: 'Sent',
    from: 'Coastal Wharf Co-op',
    addr: '<ops@coastalwharf.example>',
    to: 'ops@coastalwharf.example',
    subject: 'Berth swap request',
    when: '20 Jul',
    stamp: '20 Jul 15:48',
    unread: false,
    snippet: 'Asking to swap the Friday evening slot for Saturday early.',
    body: [
      'Could we swap the Friday 19:30 slot for Saturday 05:00 in week 31? The Friday driver is on rest hours.',
      'Either works for us if the crane crew agrees.',
    ],
  },
];

// The mailbox is ACCOUNT-keyed shared state, not session state: in zoo mode
// the inbox is its own origin with its own session, and mail sent by the
// portal origin must still arrive. Cleared by
// state.reset() with the rest of the per-task state.
function accountMailbox(state) {
  const boxes = (state.mailboxes ??= {});
  return (boxes[RESET_ACCOUNT] ??= []);
}

function inboxResetMessage(token) {
  return {
    id: 'm-120',
    folder: 'Inbox',
    from: 'Overlane Carrier Access',
    addr: '<no-reply@overlane.example>',
    subject: 'Reset your Overlane password',
    when: '09:52',
    stamp: 'Today 09:52',
    unread: true,
    snippet: 'Use the link below to choose a new password.',
    body: [
      'We received a request to reset the password for your Overlane Carrier Access account.',
      'Use the link below within 30 minutes. If you did not ask for this, ignore this message and call the service desk.',
    ],
    link: {
      text: 'Choose a new password',
      url: '/portal/reset.html?token=' + token,
    },
    tail: ['Overlane Logistics Group, 1400 Harbor Way, Suite 620, Tacoma WA 98402'],
  };
}

const INBOX_CHANGED_MESSAGE = {
  id: 'm-121',
  folder: 'Inbox',
  from: 'Overlane Carrier Access',
  addr: '<no-reply@overlane.example>',
  subject: 'Your password was changed',
  when: '09:56',
  stamp: 'Today 09:56',
  unread: true,
  snippet: 'The password on your Carrier Access account was changed.',
  body: [
    'The password on your Overlane Carrier Access account was changed. You can sign in with it now.',
    'If this was not you, call the service desk on +1 206 555 0148, option 2.',
  ],
};


export function routes(ctx) {
  const { state, json, readJson, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'POST' && pathname0 === '/api/portal/reset-request') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const email = String(payload.email ?? '').trim().toLowerCase();
      (found.session.resetRequests ??= []).push({ email, at: Date.now() });
      if (email === RESET_ACCOUNT) {
        const reset = (found.session.portalReset ??= {});
        // randomBytes, not a function of the page-exposed nonce.
        reset.token = randomBytes(7).toString('hex');
        reset.stage = 'reset-requested';
        reset.requestedAt = Date.now();
        const kept = accountMailbox(state).filter((m) => m.id !== 'm-120');
        kept.unshift(inboxResetMessage(reset.token));
        state.mailboxes[RESET_ACCOUNT] = kept;
      }
      // Same answer for every address: the mailbox is the only place that
      // tells the agent whether the account exists.
      return json(res, 200, { ok: true, message: RESET_MAILBOX_NOTE });
    }

    if (req.method === 'GET' && pathname0 === '/api/portal/reset-token') {
      const found = requireSession(req, res);
      if (!found) return;
      const token = String(url.searchParams.get('token') ?? '');
      if (token === RESET_STALE_TOKEN) {
        return json(res, 410, {
          error: 'This reset link expired on 24 July. Request a new link.',
        });
      }
      const reset = found.session.portalReset;
      if (!token || !reset?.token || token !== reset.token) {
        return json(res, 400, {
          error: 'This reset link is not valid. Request a new link.',
        });
      }
      return json(res, 200, { ok: true, email: RESET_ACCOUNT });
    }

    if (req.method === 'POST' && pathname0 === '/api/portal/reset') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const token = String(payload.token ?? '');
      if (token === RESET_STALE_TOKEN) {
        return json(res, 410, {
          error: 'This reset link expired on 24 July. Request a new link.',
        });
      }
      const reset = found.session.portalReset;
      if (!token || !reset?.token || token !== reset.token) {
        return json(res, 400, {
          error: 'This reset link is not valid. Request a new link.',
        });
      }
      const password = String(payload.password ?? '');
      const confirm = String(payload.confirm ?? '');
      (found.session.resetAttempts ??= []).push({ length: password.length, at: Date.now() });
      if (password.length < RESET_MIN_LENGTH) {
        return json(res, 422, {
          error: `Use at least ${RESET_MIN_LENGTH} characters.`,
        });
      }
      if (!/[0-9]/.test(password) || !/[a-zA-Z]/.test(password)) {
        return json(res, 422, {
          error: 'Include at least one letter and one number.',
        });
      }
      if (password !== confirm) {
        return json(res, 422, { error: 'The two passwords do not match.' });
      }
      reset.newPassword = password;
      reset.stage = 'token-used';
      reset.usedAt = Date.now();
      // Really single-use, as forgot.html, reset.html and the mail all claim:
      // the link answers 400 from here on, and re-submitting it cannot drag
      // the session back out of a later stage.
      delete reset.token;
      const extra = accountMailbox(state);
      if (!extra.some((m) => m.id === 'm-121')) {
        extra.unshift(INBOX_CHANGED_MESSAGE);
      }
      return json(res, 200, { ok: true, next: 'index.html' });
    }

    if (req.method === 'GET' && pathname0 === '/api/portal/carrier-home') {
      const found = requireSession(req, res);
      if (!found) return;
      const reset = found.session.portalReset;
      // completedAt is the monotonic marker: only /api/portal/login sets it,
      // and only after the freshly chosen password authenticated. Grading on
      // it rather than on the current stage means a later reset request cannot
      // shut the carrier home again.
      if (found.session.auth !== 'full' || !reset?.completedAt) {
        return json(res, 401, { error: 'sign-in required' });
      }
      // Server-issued per session, from randomBytes: it exists in no fixture
      // file and cannot be derived from the page nonce.
      found.session.dashCode ??=
        randomBytes(2).toString('hex').toUpperCase() +
        '-' +
        randomBytes(2).toString('hex').toUpperCase();
      return json(res, 200, {
        message: `Dashboard code: ${found.session.dashCode}`,
        account: RESET_ACCOUNT,
        contact: 'Casey Trelane',
        carrier: 'Tidewater Haulage',
      });
    }

    if (req.method === 'GET' && pathname0 === '/api/inbox/messages') {
      const found = requireSession(req, res);
      if (!found) return;
      const extra = accountMailbox(state);
      return json(res, 200, {
        account: RESET_ACCOUNT,
        messages: [...extra, ...INBOX_MESSAGES],
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/portal/login') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const email = String(payload.email ?? '').trim().toLowerCase();
      const area = String(payload.area ?? '');
      // password-reset: casey@fernmail.example has no fixed password. It only
      // signs in once this session has completed the reset flow, and it lands
      // on the carrier home rather than the staff console.
      if (email === RESET_ACCOUNT) {
        const reset = found.session.portalReset;
        const resetOk =
          !!reset?.newPassword && String(payload.password ?? '') === reset.newPassword;
        (found.session.logins ??= []).push({ email, area, ok: resetOk, at: Date.now() });
        if (!resetOk) return json(res, 401, { error: 'Invalid email or password.' });
        reset.stage = 'login-after-reset';
        reset.loggedInAt = Date.now();
        // Monotonic: `stage` can move again if the agent pokes the flow after
        // finishing, `completedAt` cannot. The validator grades on this.
        reset.completedAt ??= Date.now();
        found.session.auth = 'full';
        found.session.consoleOk = false;
        found.session.authedHits = 0;
        return json(res, 200, { ok: true, next: 'carrier.html' });
      }
      const account = Object.hasOwn(PORTAL_ACCOUNTS, email) ? PORTAL_ACCOUNTS[email] : null;
      const ok = !!account && String(payload.password ?? '') === account.password;
      (found.session.logins ??= []).push({ email, area, ok, at: Date.now() });
      if (!ok) return json(res, 401, { error: 'Invalid email or password.' });
      // Each sign-in earns its own console access: a reports-area or two-step
      // sign-in must not inherit consoleOk from an earlier password-only one
      // in the same session.
      found.session.consoleOk = false;
      found.session.authedHits = 0;
      found.session.portalUser = email;
      found.session.portalRole = account.role;
      found.session.portalLoginAt = Date.now();
      found.session.portalActive = true;
      if (area === 'reports') {
        found.session.auth = 'full';
        return json(res, 200, { ok: true, next: 'reports/1.html' });
      }
      if (account.twoStep) {
        found.session.auth = 'password';
        return json(res, 200, { ok: true, next: 'mfa.html' });
      }
      // Password-only accounts reach the console directly; consoleOk is the
      // dashboard gate, so the reports area still cannot open it.
      found.session.auth = 'full';
      found.session.consoleOk = true;
      return json(res, 200, { ok: true, next: 'dashboard.html' });
    }

    if (req.method === 'GET' && pathname0 === '/api/portal/code') {
      const found = requireSession(req, res);
      if (!found) return;
      if (found.session.auth !== 'password' && found.session.auth !== 'full') {
        return json(res, 401, { error: 'password sign-in required' });
      }
      // The 6-digit code is generated per session so it never appears in
      // fixture source on disk.
      found.session.mfaCode ??= String(
        100000 + (randomBytes(4).readUInt32BE(0) % 900000)
      );
      return json(res, 200, { code: found.session.mfaCode });
    }

    if (req.method === 'POST' && pathname0 === '/api/portal/mfa') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      if (found.session.auth !== 'password' && found.session.auth !== 'full') {
        return json(res, 401, { error: 'Sign in with your password first.' });
      }
      const code = String(payload.code ?? '').trim();
      const ok = !!found.session.mfaCode && code === found.session.mfaCode;
      (found.session.mfaAttempts ??= []).push({ code, ok, at: Date.now() });
      if (!ok) {
        return json(res, 401, {
          error: 'That code is not valid. Check your authenticator and try again.',
        });
      }
      found.session.auth = 'full';
      found.session.mfaVerified = true;
      found.session.consoleOk = true;
      found.session.authedHits = 0;
      return json(res, 200, { ok: true, next: 'dashboard.html' });
    }

    if (req.method === 'GET' && pathname0 === '/api/portal/dashboard') {
      const found = requireSession(req, res);
      if (!found) return;
      // consoleOk is set by the two-step step (ops@) or by a password-only
      // sign-in, and cleared by sign-out and by every sign-in. Reports-area
      // logins get auth='full' without it, so the console stays closed to them.
      if (found.session.auth !== 'full' || !found.session.consoleOk) {
        return json(res, 401, { error: 'sign-in required' });
      }
      // The welcome phrase is server-issued per session so it never appears
      // in fixture source on disk.
      const VAULT_WORDS = ['juniper', 'cobalt', 'marigold', 'saffron',
        'tundra', 'umber', 'fennel', 'verdant'];
      found.session.vaultWord ??=
        VAULT_WORDS[randomBytes(1)[0] % VAULT_WORDS.length];
      const account =
        PORTAL_ACCOUNTS[found.session.portalUser] ??
        PORTAL_ACCOUNTS['ops@bluefern.example'];
      const base = PORTAL_BASE_PANELS[account.role] ?? PORTAL_BASE_PANELS.operator;
      const panels =
        account.role === 'admin' ? [...base, ...PORTAL_ADMIN_PANELS] : base;
      found.session.portalDashboards = (found.session.portalDashboards ?? 0) + 1;
      return json(res, 200, {
        message: `Welcome back, ${account.greet} — vault ${found.session.vaultWord}`,
        tier: account.tier,
        balance: account.balance,
        role: account.roleLabel,
        desk: account.desk,
        initials: account.initials,
        panels,
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/portal/logout') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      found.session.consoleOk = false;
      found.session.portalActive = false;
      found.session.portalSignedOut = true;
      found.session.portalSignedOutAt = Date.now();
      // Every sign-out, not only the last: role-panels checks that one fell
      // between each account switch a session made.
      (found.session.portalSignOuts ??= []).push(found.session.portalSignedOutAt);
      // Sign-out has to drop the auth flag too. The report route gates on
      // `auth === 'full'` and nothing else, so leaving it set kept serving the
      // report to anything holding the old sid until the count-based expiry at
      // authedHits >= 3 happened to clear it.
      found.session.auth = null;
      found.session.authedHits = 0;
      // A real sign-out drops the session cookie, so the next page load mints
      // a fresh session while the old sid stays in state for the run-end
      // hygiene check.
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      });
      res.end(JSON.stringify({ ok: true, next: 'index.html?signedout=1' }));
      return;
    }

    if (req.method === 'GET' && pathname0 === '/api/portal/report') {
      const found = requireSession(req, res);
      if (!found) return;
      const n = Number(url.searchParams.get('n'));
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        return json(res, 400, { error: 'bad report number' });
      }
      if (found.session.auth !== 'full') {
        return json(res, 401, { error: 'Session expired — log in again.' });
      }
      // Report figures are server-issued so they never appear in fixture
      // source on disk. Keep in sync with ANSWERS.portalReports (sum 41,873).
      const REPORTS = [
        { label: 'North district depot — outbound shipments', total: '9,412' },
        { label: 'South district depot — outbound shipments', total: '7,258' },
        { label: 'Harbor terminal — outbound shipments', total: '12,391' },
        { label: 'Rail interchange — outbound shipments', total: '4,876' },
        { label: 'Airfreight hub — outbound shipments', total: '7,936' },
      ];
      const hits = (found.session.reportHits ??= []);
      if (!hits.includes(n)) hits.push(n);
      // Deterministic count-based expiry: the 3rd authenticated report fetch
      // is served, then the auth flag (never the cookie) is cleared.
      found.session.authedHits = (found.session.authedHits ?? 0) + 1;
      if (found.session.authedHits >= 3) {
        found.session.auth = null;
      }
      return json(res, 200, { n, ...REPORTS[n - 1] });
    }

    return false;
  };
}
