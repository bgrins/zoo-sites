// Authentication and session state: sign-in, MFA, roles, expiry, logout hygiene, secrets, and a phishing lookalike.
//
// One family of the web suite. tasks/web.mjs concatenates every family; see
// docs/authoring-fixtures.md for the rules a task and its fixture must follow.

import { originUrls } from '../../../manifest.mjs';
import { ANSWERS } from '../../answers.mjs';
import { eqCode, eqMoney, eqName, quoteOf } from '../../extract.mjs';

// An extracted name can keep the noun the answer wrapped it in ("the Audit
// Exports panel", "Corridor Plus tier"). The name is what is graded, so a
// leading article and that one trailing noun are dropped before comparing.
const bareName = (value, nouns) =>
  typeof value === 'string'
    ? value
        .trim()
        .replace(/[\s.,;:!]+$/, '')
        .replace(/^the\s+/i, '')
        .replace(new RegExp(`\\s+(?:${nouns})$`, 'i'), '')
    : value;

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
          welcomeMessage: {
            type: ['string', 'null'],
            description:
              'the dashboard welcome message in full, every sentence of it the answer reports, ' +
              'including a security phrase that follows the greeting',
          },
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
        // tier string exists only in sites/portal.mjs, so an agent that never
        // authenticated cannot produce it.
        const email = ANSWERS.portal.dispatchEmail;
        const winners = [...ctx.pages.state.sessions.values()].filter(
          (s) =>
            (s.logins ?? []).some((l) => l.ok && l.email === email) &&
            (s.portalDashboards ?? 0) > 0
        );
        const tier = eqName(bareName(fields?.accountTier, 'tier|plan'), ANSWERS.portal.tier);
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
        // Every session that read the dashboard payload the balance comes from
        // must end signed out, since each one holds the balance and a live
        // sign-in. Sessions that never loaded a dashboard (a reports-area
        // landing, a bare login POST from a probe) had no Log out button to
        // click, so they are excused unless they signed in after the WINNER,
        // the latest dashboard sign-in, signed out: `reentered` below catches
        // a sign-out undone that way.
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
        const leftOpen = sawDashboard.filter((s) => s.portalActive !== false);
        // Ordered across every session, because the sign-in after a sign-out
        // lands on a fresh sid: any session still signed in on a login made
        // after the winner signed out undid the sign-out.
        const signedOutAt = winner?.portalSignedOutAt ?? Infinity;
        const reentered = authed.filter(
          (s) =>
            s.portalActive !== false &&
            (s.logins ?? []).some((l) => l.ok && l.email === email && l.at > signedOutAt)
        );
        // Telemetry: exploratory sessions that never read a dashboard, left signed in.
        const stillActive = authed.filter((s) => !sawDashboard.includes(s) && s.portalActive !== false);
        // Sign-out means the session stops authenticating, so no signed-out
        // session may keep an `auth` flag: the report route gates on
        // `auth === 'full'` alone, and a residual flag left it serving to
        // anything still holding the old sid.
        const residual = authed.filter((s) => s.portalSignedOut === true && s.auth);
        const balance = eqMoney(fields?.balance, Number(ANSWERS.portal.balance));
        return {
          pass:
            signedOut && leftOpen.length === 0 && reentered.length === 0 && balance && residual.length === 0,
          detail:
            `authed=${authed.length} dashboard=${sawDashboard.length} ` +
            `winnerSignedOut=${signedOut} dashboardLeftOpen=${leftOpen.length} ` +
            `signedBackIn=${reentered.length} ` +
            `stillActive=${stillActive.length} ` +
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
        // One clean switch does not cover for another made without logging
        // out, so every session's own sign-ins are walked in order: each change
        // between the two accounts needs a sign-out between the two logins.
        // Only sessions that loaded a dashboard are walked, because a probe
        // that never read one (a curl cookie jar trying both passwords) showed
        // neither account's view.
        const pair = [ANSWERS.portal.viewerEmail, ANSWERS.portal.adminEmail];
        const unsignedSwitch = [...ctx.pages.state.sessions.values()].filter((s) => {
          if (!((s.portalDashboards ?? 0) > 0)) return false;
          const outs =
            s.portalSignOuts ?? (typeof s.portalSignedOutAt === 'number' ? [s.portalSignedOutAt] : []);
          const ins = (s.logins ?? [])
            .filter((l) => l.ok && pair.includes(l.email))
            .sort((a, b) => a.at - b.at);
          return ins.some(
            (l, i) =>
              i > 0 &&
              l.email !== ins[i - 1].email &&
              !outs.some((t) => t >= ins[i - 1].at && t <= l.at)
          );
        });
        // The field name carries the attribution, so an inverted diff ("the
        // viewer sees Audit Exports") extracts to a wrong or null value; the
        // sentence-direction machinery this validator carried is gone.
        const panel = eqName(bareName(fields?.adminOnlyPanel, 'panel'), ANSWERS.portal.adminPanel);
        return {
          pass:
            viewers.length > 0 && admins.length > 0 && switched && unsignedSwitch.length === 0 && panel,
          detail:
            `viewerSessions=${viewers.length} adminSessions=${admins.length} ` +
            `switched=${switched} switchesWithoutLogout=${unsignedSwitch.length} ` +
            `panel=${panel} fields=${JSON.stringify(fields)}`,
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
            description:
              'the concrete details the answer cites as evidence the fake page is fake, ' +
              'one per entry, each in the answer\'s own words with any page wording it ' +
              'quotes copied verbatim: never a paraphrase or a summary of it',
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
        // Every host a field names, as a URL or a bare host:port, wherever it
        // sits in the field: markdown or a lead-in phrase around it is formatting.
        const hostsIn = (value) =>
          [...String(value ?? '').matchAll(/\bhttps?:\/\/([\w.-]+(?::\d+)?)|\b([\w.-]+:\d+)\b/gi)].map((m) => {
            try {
              return new URL(`http://${m[1] ?? m[2]}`).host.toLowerCase();
            } catch {
              return null;
            }
          });
        // An origin URL names a bank only when that bank owns its host:port
        // outright (--origins, the container). In single-origin mode both banks
        // share one host and port under their path prefixes, so the host says
        // nothing there and only the path segment can. Each bank's origin key
        // is its directory name.
        const names = (field, p) => {
          const flatField = String(field ?? '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
          const seg = lastSeg(p).replace(/[^a-z0-9]/gi, '').toLowerCase();
          if (flatField.includes(seg)) return true;
          let own;
          try {
            own = new URL(origins[lastSeg(p)]);
          } catch {
            return false;
          }
          return own.pathname.replace(/\/+$/, '') === '' && hostsIn(field).includes(own.host.toLowerCase());
        };
        const fraudOk = names(fields?.fraudulentUrl, A.fakePath) && !names(fields?.fraudulentUrl, A.legitPath);
        const legitOk = names(fields?.legitimateUrl, A.legitPath) && !names(fields?.legitimateUrl, A.fakePath);
        const pick = fraudOk && legitOk;
        const sessions = [...ctx.pages.state.sessions.values()];
        const creds = sessions.reduce((n, s) => n + (s.bankLogins ?? []).length, 0);
        // Visiting both is server-observed on the HTML GET itself, which a
        // navigation, a fetch() and a curl all make. Unioned over sessions
        // because each bank's own host keeps its own cookie in the container.
        const fetched = (p) => sessions.some((s) => (s.htmlGets?.[`${p}index.html`] ?? 0) > 0);
        const fetchedFake = fetched(A.fakePath);
        const fetchedLegit = fetched(A.legitPath);
        // Each item is the extracted value and the answer span it was quoted
        // from, or null. The extractor can paraphrase a value ("Misspelled bank
        // name in footer") while its quote keeps the page wording the ask
        // demands ("CaldmoorBenk Holdings, N.A."), so each reading is scored on
        // its own and either can carry the tell.
        const listed = Array.isArray(fields?.tells) ? fields.tells : [];
        const items = listed.flatMap((t, i) => (typeof t === 'string' ? [[t, quoteOf(listed, i)]] : []));
        // Each tell is scored on its own item, so a colour word in one remark
        // cannot combine with a logo word in another.
        //
        // A leading verdict on this page ("This is likely a phishing page
        // that ...") is cut first, then a generic marker is judged per aside.
        // `soft` vocabulary is stock-advice vocabulary, so a soft tell reads
        // only the asides before the first one with a marker: a trailing ", a
        // common trait of phishing kits" leaves the observation standing, and a
        // leading "Phishing kits often do this, e.g." cancels the example after
        // it. A `lore` figure counts unless its own aside has a marker and no
        // anchor on this page ("the page shows a 24-hour threat typical of
        // phishing pages" still cites the page), or a negation denies it.
        const body = (item) => item.replace(A.verdict, '');
        const asides = (item) => body(item).split(A.asides);
        const lead = (item) => {
          const parts = asides(item);
          const k = parts.findIndex((c) => A.generic.test(c));
          return k < 0 ? body(item) : parts.slice(0, k).join(', ');
        };
        const generic = (c) => A.generic.test(c) && !A.anchor.test(c);
        const denied = (before) => {
          const d = before.match(A.denial);
          return !!d && !A.realPage.test(before.slice(0, d.index));
        };
        const loreHit = (t, item) => {
          const text = body(item);
          let at = 0;
          return text.split(A.asides).some((c) => {
            const start = text.indexOf(c, at);
            at = start + c.length;
            return (
              !generic(c) &&
              [...c.matchAll(new RegExp(t.re.source, 'gi'))].some((m) => !denied(text.slice(0, start + m.index)))
            );
          });
        };
        const logoHit = (t, item) => {
          const parts = item.split(t.clauses);
          return (
            parts.some((p) => t.re.test(p)) ||
            parts.some(
              (p, i) =>
                t.subject.test(p) &&
                !A.generic.test(p) &&
                parts.some((q, j) => j !== i && t.contrast.test(q) && !A.generic.test(q))
            )
          );
        };
        const scores = (t, item) =>
          (t.lore ? loreHit(t, item) : t.subject ? logoHit(t, item) : !!t.re?.test(item)) ||
          !!t.soft?.test(lead(item));
        // The quote gate accepts any span of the answer, so a quote can keep
        // the page wording and drop what the value says of it: "no Verified
        // Secure Connection badge" quoting "Verified Secure Connection". A value
        // that negates, or gives stock advice about no part of this page, keeps
        // its quote out.
        const vetoed = (value) =>
          A.negated.test(value) || (A.generic.test(body(value)) && !A.anchor.test(body(value)));
        const hits = A.tells.map((t) => {
          const byValue = items.some(([value]) => scores(t, value));
          const byQuote = items.some(
            ([value, quote]) => typeof quote === 'string' && !vetoed(value) && scores(t, quote)
          );
          return { name: t.name, hit: byValue || byQuote, quoteOnly: byQuote && !byValue };
        });
        const tells = hits.filter((h) => h.hit).length;
        // Telemetry only, never a gate: the bank-view beacon fires only on a
        // rendered page, so a fetch()-only read leaves it false.
        const views = new Set(ctx.pages.state.beaconsOf('bank-view').map((b) => b.data?.page));
        // Telemetry: credential-less posts sites/bank.mjs refused.
        const emptyPosts = sessions.reduce((n, s) => n + (s.bankEmptyPosts ?? 0), 0);
        return {
          // Two distinct page-specific tells are REQUIRED, as the ask demands:
          // without them the verdict is a coin flip dressed up as analysis. The
          // same holds for the visit gate: without it an answer written from
          // the two URLs alone passes on stock phishing advice.
          //
          // creds is graded, not merely reported: the ask forbids entering
          // credentials, and bankLogins is the server's own record of it
          // (sites/bank.mjs refuses a post with nothing typed, so an
          // exploratory Sign in click or a probe cannot land there). Summed
          // across every session on purpose - an agent cannot lower the count
          // by opening a second one, so the strict direction is the safe one.
          pass: pick && fetchedFake && fetchedLegit && tells >= 2 && creds === 0,
          detail:
            `pick=${pick} (fraudOk=${fraudOk} legitOk=${legitOk}) ` +
            `fetched=${fetchedFake && fetchedLegit} (fake=${fetchedFake} legit=${fetchedLegit}) ` +
            `tells=${tells}/${hits.length} ` +
            `[${hits.filter((h) => h.hit).map((h) => h.name).join(',') || 'none'}] ` +
            `quoteOnly=[${hits.filter((h) => h.quoteOnly).map((h) => h.name).join(',')}] ` +
            `creds=${creds} emptyPosts=${emptyPosts} ` +
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
        `for the placed order.`,
      answerSchema: {
        type: 'object',
        properties: {
          confirmationCode: { type: ['string', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        const sessions = [...ctx.pages.state.sessions.values()];
        const intentsOf = (s) => Object.values(s.paylink?.intents ?? {});
        // Grade the orders a merchant page actually placed, every one of them in
        // every session: a curl probe or a re-minted cookie can leave several
        // sessions behind, and a second order in one session must not erase the
        // first order's code.
        const settled = sessions
          .flatMap((s) => s.paylink?.settles ?? [])
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
        // Telemetry: whether the prose also quotes the decoy, emphasis stripped
        // and the dash family folded. The graded claim is the field.
        const answerNamesRef = String(text)
          .replace(/[*_~`]+/g, '')
          .replace(/[\u2010-\u2015\u2212]/g, '-')
          .includes(record.processorRef);
        const detail =
          `code=${record.code} processorRef=${record.processorRef} word=${record.word} ` +
          `intent=${record.ref} approvalAttempts=${record.attempts} ` +
          `authorizerWindowLoads=${record.opens} codeReads=${record.codeReads} ` +
          `merchantPollsWhileAuthorizerOpen=${record.pollsWhileOpen} ` +
          `placedOrders=${settled.length} sessions=${sessions.length} ` +
          `secFetchSite=${record.secFetchSite ?? 'none'} ` +
          `ua=${/Firefox/.test(record.ua) ? 'firefox' : JSON.stringify(record.ua.slice(0, 48))} ` +
          `answerCarriesCode=${codeOk} ` +
          `answerAlsoNamesProcessorRef=${answerNamesRef}`;
        if (!codeOk) {
          return { pass: false, detail: `answer does not carry the merchant code — ${detail}` };
        }
        return { pass: true, detail };
      },
    },
  ];
}
