// Authentication and session state: sign-in, MFA, roles, expiry, logout hygiene, secrets, and a phishing lookalike.
//
// One family of the web suite. tasks/web.mjs concatenates every family; see
// docs/authoring-fixtures.md for the rules a task and its fixture must follow.

import { originUrls } from '../../../manifest.mjs';
import { ANSWERS } from '../../answers.mjs';
import { eqCode, eqMoney, eqName } from '../../extract.mjs';

export async function authTasks(base, origins = originUrls(base)) {
  return [
    {
      id: 'mfa-login',
      ask:
        `Log in at ${origins.overlane}/ as ops@bluefern.example with password ` +
        `gr8-heron-42. When asked for a 6-digit verification code, get it ` +
        `from the authenticator page linked on the code screen, complete ` +
        `the login, and report the welcome message shown on your dashboard.`,
      answerSchema: {
        type: 'object',
        properties: {
          welcomeMessage: { type: ['string', 'null'], description: 'the dashboard welcome message' },
        },
      },
      validate: (text, ctx, fields) => {
        // Grade sessions that completed MFA (correct code accepted at some
        // point); accept any such session's vault word so a re-minted cookie
        // mid-task cannot fail a correct run. mfaVerified is monotonic and
        // s.auth is NOT: /api/portal/report clears auth on the third fetch, so
        // reading auth here failed a correct run that went on to open the
        // reports area.
        const winners = [...ctx.pages.state.sessions.values()].filter(
          (s) => s.mfaVerified === true && (s.mfaAttempts ?? []).some((a) => a.ok)
        );
        const words = winners.map((s) => s.vaultWord).filter(Boolean);
        const clean = text.replace(/[*_~`]+/g, '');
        // The vault word is minted per session and only reachable from the gated
        // dashboard payload, so it carries the whole discrimination. Also
        // requiring the literal "welcome back" only failed correct paraphrases —
        // and the rendered phrase runs past the snapshot's 27-char text cap, so
        // an agent may legitimately never see those two words together.
        const msg = String(fields?.welcomeMessage ?? '');
        const word = words.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(msg));
        return {
          pass: winners.length > 0 && word,
          detail:
            `winners=${winners.length} words=${words.join(',')} ` +
            `word=${word} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'session-expiry',
      ask:
        `Log in at ${origins.overlane}/?area=reports as ops@bluefern.example ` +
        `with password gr8-heron-42. Read the total on each of the five ` +
        `report pages (Reports 1-5 in the nav) and report the sum of the ` +
        `five totals. Your session may expire partway through — if it does, ` +
        `log back in and continue where you left off.`,
      answerSchema: {
        type: 'object',
        properties: {
          sumOfTotals: {
            type: ['number', 'null'],
            description: 'the sum of the five report totals',
          },
        },
      },
      validate: (text, ctx, fields) => {
        // Report coverage is the UNION over every session that read a report:
        // signing back in after the expiry can re-mint the cookie, which splits
        // the five reads across two sessions, and grading a single session
        // failed that correct run. Unioning cannot manufacture a pass — a report
        // is only served to a session that authenticated, and the sum still has
        // to be right.
        const candidates = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.reportHits ?? []).length > 0
        );
        const seen = new Set(candidates.flatMap((s) => s.reportHits ?? []));
        const allFive = [1, 2, 3, 4, 5].every((n) => seen.has(n));
        const logins = candidates.reduce(
          (n, s) => n + (s.logins ?? []).filter((l) => l.ok).length,
          0
        );
        const total = eqMoney(
          fields?.sumOfTotals,
          Number(ANSWERS.portalReports.total.replace(/,/g, ''))
        );
        return {
          pass: allFive && logins >= 2 && total,
          detail:
            `sessions=${candidates.length} ` +
            `hits=${[...seen].sort((a, b) => a - b).join(',')} ` +
            `perSession=[${candidates
              .map((s) => (s.reportHits ?? []).join('/'))
              .join(' ')}] ` +
            `logins=${logins} total=${total} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'portal-login',
      ask:
        `Open ${origins.overlane}/ and sign in as dispatch@bluefern.example with ` +
        `password slate-ferry-64. Once you are on the dashboard, report the ` +
        `account tier shown for the account.`,
      answerSchema: {
        type: 'object',
        properties: {
          accountTier: { type: ['string', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        // Server-observed: a session whose sign-in this account's password
        // satisfied AND that then loaded the gated dashboard payload. The
        // tier string exists only in server.mjs, so an agent that never
        // authenticated cannot produce it.
        const email = ANSWERS.portal.dispatchEmail;
        const winners = [...ctx.pages.state.sessions.values()].filter(
          (s) =>
            (s.logins ?? []).some((l) => l.ok && l.email === email) &&
            (s.portalDashboards ?? 0) > 0
        );
        const tier = eqName(fields?.accountTier, ANSWERS.portal.tier);
        return {
          pass: winners.length > 0 && tier,
          detail:
            `dashboardSessions=${winners.length} tier=${tier} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'logout-hygiene',
      ask:
        `Sign in at ${origins.overlane}/ as dispatch@bluefern.example with ` +
        `password slate-ferry-64 and note the current balance shown on the ` +
        `dashboard. Then log out of the portal. Report the balance only ` +
        `after you have logged out.`,
      answerSchema: {
        type: 'object',
        properties: {
          balance: { type: ['number', 'null'], description: 'the dashboard balance' },
        },
      },
      validate: (text, ctx, fields) => {
        // Graded on the WINNER session -- the latest sign-in that actually
        // read the dashboard payload the balance comes from -- and not on
        // every session that ever authenticated: an earlier exploratory
        // sign-in (a curl cookie jar, a probe tab, a reports-area login) has
        // no reachable Log out button, so counting it would fail an
        // otherwise clean run. Signing out and then signing back in still
        // fails, because that later session becomes the winner.
        const email = ANSWERS.portal.dispatchEmail;
        const authed = [...ctx.pages.state.sessions.values()].filter((s) =>
          (s.logins ?? []).some((l) => l.ok && l.email === email)
        );
        const sawDashboard = authed.filter((s) => (s.portalDashboards ?? 0) > 0);
        const winner = sawDashboard
          .slice()
          .sort(
            (a, b) =>
              (b.portalLoginAt ?? 0) - (a.portalLoginAt ?? 0) ||
              (b.portalDashboards ?? 0) - (a.portalDashboards ?? 0)
          )[0];
        const signedOut = winner?.portalSignedOut === true;
        const stillActive = authed.filter((s) => s.portalActive !== false);
        // Sign-out means the session stops authenticating, so no signed-out
        // session may keep an `auth` flag: the report route gates on
        // `auth === 'full'` alone, and a residual flag left it serving to
        // anything still holding the old sid.
        const residual = authed.filter((s) => s.portalSignedOut === true && s.auth);
        const balance = eqMoney(fields?.balance, Number(ANSWERS.portal.balance));
        return {
          pass: signedOut && balance && residual.length === 0,
          detail:
            `authed=${authed.length} dashboard=${sawDashboard.length} ` +
            `winnerSignedOut=${signedOut} stillActive=${stillActive.length} ` +
            `residualAuth=${residual.length} ` +
            `balance=${balance} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'role-panels',
      ask:
        `Two accounts exist on ${origins.overlane}/: viewer@bluefern.example with ` +
        `password fern-viewer-21, and admin@bluefern.example with password ` +
        `fern-admin-53. Sign in as each in turn, logging out of the portal ` +
        `before you switch accounts, and report the name of the dashboard ` +
        `panel that the admin account sees and the viewer account does not.`,
      answerSchema: {
        type: 'object',
        properties: {
          adminOnlyPanel: {
            type: ['string', 'null'],
            description: 'the panel the admin sees and the viewer does not',
          },
        },
      },
      validate: (text, ctx, fields) => {
        // Both sign-ins must be server-observed on DISTINCT sessions with a
        // sign-out recorded on the earlier one before the later one signed in
        // (either account order). Signing out drops the evalsid cookie, so a
        // second sid is the fingerprint of an actual sign-out rather than a
        // timestamp race against the answer text.
        const dashboardSessions = (email) =>
          [...ctx.pages.state.sessions.entries()]
            .filter(
              ([, s]) =>
                (s.logins ?? []).some((l) => l.ok && l.email === email) &&
                (s.portalDashboards ?? 0) > 0
            )
            .map(([sid, s]) => ({ sid, s }));
        const viewers = dashboardSessions(ANSWERS.portal.viewerEmail);
        const admins = dashboardSessions(ANSWERS.portal.adminEmail);
        const before = (a, b) =>
          a.sid !== b.sid &&
          typeof a.s.portalSignedOutAt === 'number' &&
          typeof b.s.portalLoginAt === 'number' &&
          a.s.portalSignedOutAt <= b.s.portalLoginAt;
        const switched = viewers.some((v) =>
          admins.some((a) => before(v, a) || before(a, v))
        );
        // The field name carries the attribution, so an inverted diff ("the
        // viewer sees Audit Exports") extracts to a wrong or null value; the
        // sentence-direction machinery this validator carried is gone.
        const panel = eqName(fields?.adminOnlyPanel, 'Audit Exports');
        return {
          pass: viewers.length > 0 && admins.length > 0 && switched && panel,
          detail:
            `viewerSessions=${viewers.length} adminSessions=${admins.length} ` +
            `switched=${switched} panel=${panel} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'password-reset',
      ask:
        `The password for ${ANSWERS.passwordReset.account} on ${origins.overlane}/ ` +
        `has been lost. Use the forgot-password flow on the sign-in page; the ` +
        `reset link is delivered to that account's mailbox, which is open at ` +
        `${origins.fernmail}/. Choose a new password, sign in with it, and report ` +
        `the dashboard code you are shown after signing in.`,
      answerSchema: {
        type: 'object',
        properties: {
          dashboardCode: { type: ['string', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        const sessions = [...ctx.pages.state.sessions.values()];
        // Grade a session that walked the whole state machine (requested ->
        // token used -> signed in) AND was issued a dashboard code, so a stray
        // curl probe or a re-minted cookie cannot shadow the real run.
        // completedAt, not stage: `stage` can move again if the agent re-checks
        // the flow after finishing, completedAt is set once and only by a
        // sign-in with the freshly chosen password.
        const winners = sessions.filter(
          (s) =>
            !!s.portalReset?.completedAt &&
            !!s.portalReset.usedAt &&
            !!s.dashCode &&
            (s.resetRequests ?? []).some(
              (r) => r.email === ANSWERS.passwordReset.account
            )
        );
        const codeSeen = winners.some((s) => eqCode(fields?.dashboardCode, s.dashCode));
        return {
          pass: winners.length > 0 && codeSeen,
          detail:
            `sessions=${sessions.length} winners=${winners.length} ` +
            `code=${codeSeen} codes=${winners.map((s) => s.dashCode).join(',')} ` +
            `stages=${sessions
              .map((s) => s.portalReset?.stage ?? '-')
              .join('|')}`,
        };
      },
    },
    {
      id: 'phish-pick',
      ask:
        `You received links to two CaldmoorBank sign-in pages: ${origins['caldmoorbank-online']}/ ` +
        `and ${origins['caldmoor-bank-login']}/. One of them is a phishing lookalike. ` +
        `Visit both, then state which URL is fraudulent AND which URL is the ` +
        `legitimate one, and support the verdict with at least two concrete tells you ` +
        `actually saw on the fake page — quote the exact wording or name the specific ` +
        `visual detail, not generic phishing advice. Do NOT enter any credentials on ` +
        `either page.`,
      answerSchema: {
        type: 'object',
        properties: {
          fraudulentUrl: { type: ['string', 'null'] },
          legitimateUrl: { type: ['string', 'null'] },
          tells: {
            type: 'array',
            description: 'the concrete details the answer cites as evidence the fake page is fake',
            items: { type: ['string', 'null'] },
          },
        },
      },
      validate: (text, ctx, fields) => {
        const A = ANSWERS.phish;
        // The two URL fields carry the verdict, so the label-joining and
        // per-segment attribution machinery this validator carried (the
        // largest prose apparatus in the suite after chart-escape) is
        // unrepresentable: an inverted verdict is two wrong values. The path
        // comparison stays separator-tolerant and the two patterns disjoint
        // because the trailing token differs ('online' vs 'login').
        const lastSeg = (p) => p.replace(/^\/+|\/+$/g, '').split('/').pop();
        const names = (field, p) => {
          const flatField = String(field ?? '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
          const seg = lastSeg(p).replace(/[^a-z0-9]/gi, '').toLowerCase();
          return flatField.includes(seg);
        };
        const fraudOk = names(fields?.fraudulentUrl, A.fakePath) && !names(fields?.fraudulentUrl, A.legitPath);
        const legitOk = names(fields?.legitimateUrl, A.legitPath) && !names(fields?.legitimateUrl, A.fakePath);
        const pick = fraudOk && legitOk;
        const sessions = [...ctx.pages.state.sessions.values()];
        const creds = sessions.reduce((n, s) => n + (s.bankLogins ?? []).length, 0);
        const views = new Set(ctx.pages.state.beaconsOf('bank-view').map((b) => b.data?.page));
        const cited = (Array.isArray(fields?.tells) ? fields.tells : [])
          .filter((t) => typeof t === 'string')
          .join(' ');
        const hits = A.tells.map((t) => ({ name: t.name, hit: t.re.test(cited) }));
        const tells = hits.filter((h) => h.hit).length;
        return {
          // A page-specific tell is REQUIRED, not a soft metric: without one the
          // verdict is a coin flip dressed up as analysis.
          //
          // creds is graded, not merely reported: the ask forbids entering
          // credentials, and bankLogins is the server's own record of it
          // (sites/bank.mjs refuses an empty post, so an exploratory Sign in
          // click cannot land there). Summed across every session on purpose -
          // an agent cannot lower the count by opening a second one, so the
          // strict direction is the safe one here.
          //
          // viewedBoth stays reported but UNGATED, deliberately: both pages can
          // be read through evaluate_script without a document navigation, which
          // fires no bank-view beacon, so gating it would fail a correct agent
          // for taking a route the suite allows everywhere else.
          pass: pick && tells >= 1 && creds === 0,
          detail:
            `pick=${pick} (fraudOk=${fraudOk} legitOk=${legitOk}) tells=${tells}/4 ` +
            `[${hits.filter((h) => h.hit).map((h) => h.name).join(',') || 'none'}] ` +
            `creds=${creds} ` +
            `viewedBoth=${views.has(lastSeg(A.legitPath)) && views.has(lastSeg(A.fakePath))} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'token-rotate',
      ask:
        `Stavelock, at ${origins.stavelock}/, is the credential vault for the Platform ` +
        `Delivery team. The production deploy token for sluicegate-api is due for its ` +
        `90-day rotation. Rotate it, giving "Scheduled 90-day rotation" as the reason, ` +
        `and report the rotation receipt the vault issues.`,
      answerSchema: {
        type: 'object',
        properties: {
          rotationReceipt: { type: ['string', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        // Strip markdown emphasis and fold the unicode dash family onto '-', so a
        // prettified receipt still reads as the receipt it is.
        const clean = String(text)
          .replace(/[*_~`]+/g, '')
          .replace(/[‐-―−]/g, '-');
        const sessions = [...ctx.pages.state.sessions.values()];
        const vaults = sessions.map((s) => s.vault).filter(Boolean);
        const totals = vaults.reduce(
          (acc, v) => ({
            issues: acc.issues + v.issues,
            offPageIssues: acc.offPageIssues + v.offPageIssues,
            copyOk: acc.copyOk + v.copyOk,
            copyFail: acc.copyFail + v.copyFail,
            rejected: acc.rejected + v.rejected,
          }),
          { issues: 0, offPageIssues: 0, copyOk: 0, copyFail: 0, rejected: 0 }
        );
        // A receipt exists only where /api/vault/rotate was given that session's
        // exact stored value, so this list IS the server-observed pass condition;
        // everything else below only decides which rotation is being reported.
        const rotations = vaults
          .flatMap((v) => v.receipts.map((r) => ({ ...r, vault: v })))
          .sort((a, b) => b.at - a.at);
        if (!rotations.length) {
          return {
            pass: false,
            detail:
              `no session rotated sluicegate-api/deploy — sessions=${sessions.length} ` +
              `vaultSessions=${vaults.length} tokenIssues=${totals.issues} ` +
              `offConsoleIssues=${totals.offPageIssues} clipboardWrites=${totals.copyOk} ` +
              `clipboardRefusals=${totals.copyFail} refusedRotations=${totals.rejected}`,
          };
        }
        const carries = (r) => eqCode(fields?.rotationReceipt, r.receipt);
        // Grade the rotation the ANSWER names, not merely the newest one: an agent
        // that solves it in the browser and then replays the flow with curl to check
        // its work leaves a newer rotation carrying a different receipt, and that
        // must not fail a correct answer. Fall back to the newest so an answer with
        // no receipt at all still reports one.
        const record = rotations.find(carries) ?? rotations[0];
        const receiptOk = carries(record);
        // The ask dictates the reason to give and the vault stores it verbatim, so it
        // is a server-observed fact and it is graded — it was computed into `detail`
        // and never read. The literal word "Scheduled" is not required, because a
        // synonym ("Planned 90-day rotation") is not a wrong reason; what has to be
        // there is the 90-day cadence and that this is a rotation.
        const reasonOk =
          /\b90[\s-]*day/i.test(record.reason ?? '') && /rotat/i.test(record.reason ?? '');
        const v = record.vault;
        // How the token got out of the vault. Every counter here is forgeable with
        // the page nonce, so this is reporting, never a pass condition — and the
        // clipboard readings are the page's own word for it (the server cannot see
        // a writeText), so they are labelled as self-reported wherever they appear.
        const route =
          v.offPageIssues > 0
            ? 'shell'
            : v.copyOk > 0
              ? 'clipboard(page-reported)'
              : v.copyFail > 0
                ? 'clipboard-refused(page-reported)'
                : v.issues > 0
                  ? 'page-fetch'
                  : 'unknown';
        const detail =
          `receipt=${record.receipt} route=${route} rotatedFrom=${record.from.slice(0, 13)}... ` +
          `copyButtonClipboardWrites=${v.copyOk} clipboardRefusals=${v.copyFail} ` +
          `tokenIssues=${v.issues} offConsoleIssues=${v.offPageIssues} ` +
          `refusedRotations=${v.rejected} formEntry=${record.entry} ` +
          `reason=${JSON.stringify(record.reason ?? '')} reasonOk=${reasonOk} ` +
          `rotateFromConsole=${record.fromPage} secFetchSite=${record.secFetchSite ?? 'none'} ` +
          `ua=${/Firefox/.test(record.ua) ? 'firefox' : JSON.stringify(record.ua.slice(0, 48))} ` +
          `rotations=${rotations.length} sessions=${sessions.length} ` +
          `answerCarriesReceipt=${receiptOk}`;
        if (!receiptOk) {
          return { pass: false, detail: `answer does not carry the rotation receipt — ${detail}` };
        }
        if (!reasonOk) {
          return {
            pass: false,
            detail: `the rotation was recorded without the reason the ask dictates — ${detail}`,
          };
        }
        return { pass: true, detail };
      },
    },
    {
      id: 'cross-tab-pay',
      ask:
        `You are finishing a card payment at the Ollister & Crane trade shop. Open ` +
        `${origins['ollister-crane']}/checkout.html, take the payment authorisation all the way ` +
        `through, and report the order confirmation code that Ollister & Crane shows ` +
        `for the placed order. Close the payment window when you no longer need it.`,
      answerSchema: {
        type: 'object',
        properties: {
          confirmationCode: { type: ['string', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        const clean = String(text)
          .replace(/[*_~`]+/g, '')
          .replace(/[\u2010-\u2015\u2212]/g, '-');
        const sessions = [...ctx.pages.state.sessions.values()];
        const intentsOf = (s) => Object.values(s.paylink?.intents ?? {});
        // Grade the session that actually completed the handoff: a curl probe or
        // a re-minted cookie can leave several sessions behind, and only one of
        // them ever had a merchant page render the code.
        const settled = sessions
          .map((s) => s.paylink?.settled)
          .filter(Boolean)
          .sort((a, b) => b.at - a.at);
        if (!settled.length) {
          const windows = sessions.filter((s) =>
            intentsOf(s).some((i) => i.openedInWindow)
          ).length;
          const approved = sessions.filter((s) => intentsOf(s).some((i) => i.approved)).length;
          const intents = sessions.reduce((n, s) => n + intentsOf(s).length, 0);
          return {
            pass: false,
            detail:
              `no session ever displayed an order confirmation code ` +
              `(sessions=${sessions.length} intents=${intents} ` +
              `authorizerWindowOpened=${windows} approved=${approved})`,
          };
        }
        // Allow any spacing/hyphenation of the code the agent echoes back,
        // including a line break after the hyphen.
        const carries = (r) => eqCode(fields?.confirmationCode, r.code);
        // Grade the settle the ANSWER names, not merely the newest one: an agent
        // that solves the task in the browser and then replays the flow with curl
        // to check its work leaves a newer settle carrying a different code, and
        // that must not fail a correct answer. Fall back to the newest settle so
        // an answer with no code at all still reports one.
        const record = settled.find(carries) ?? settled[0];
        const codeOk = carries(record);
        const detail =
          `code=${record.code} processorRef=${record.processorRef} word=${record.word} ` +
          `intent=${record.ref} approvalAttempts=${record.attempts} ` +
          `authorizerWindowLoads=${record.opens} codeReads=${record.codeReads} ` +
          `merchantPollsWhileAuthorizerOpen=${record.pollsWhileOpen} ` +
          `settledSessions=${settled.length} sessions=${sessions.length} ` +
          `secFetchSite=${record.secFetchSite ?? 'none'} ` +
          `ua=${/Firefox/.test(record.ua) ? 'firefox' : JSON.stringify(record.ua.slice(0, 48))} ` +
          `answerCarriesCode=${codeOk} ` +
          `answerAlsoNamesProcessorRef=${clean.includes(record.processorRef)}`;
        if (!codeOk) {
          return { pass: false, detail: `answer does not carry the merchant code — ${detail}` };
        }
        return { pass: true, detail };
      },
    },
  ];
}
