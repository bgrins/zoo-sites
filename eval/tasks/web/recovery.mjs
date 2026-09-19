// Error recovery and time: retries, genuinely slow endpoints, embargoes, rate limits, live state, and bookings.
//
// One family of the web suite. tasks/web.mjs concatenates every family; see
// docs/authoring-fixtures.md for the rules a task and its fixture must follow.

import { originUrls } from '../../../manifest.mjs';
import { ANSWERS } from '../../answers.mjs';
import { eqCode, eqEnum, eqMoney, eqName, soleCode } from '../../extract.mjs';

export async function recoveryTasks(base, origins = originUrls(base)) {
  return [
    {
      id: 'flaky-retry',
      ask:
        `Open ${origins.zellick}/ and load the quarterly report. The reporting backend is ` +
        `unreliable — retry if it fails. Report the Q3 total revenue figure.`,
      answerSchema: {
        type: 'object',
        properties: {
          q3Revenue: { type: ['number', 'null'], description: 'the Q3 total revenue figure' },
        },
      },
      validate: (text, ctx, fields) => {
        const sessions = [...ctx.pages.state.sessions.values()];
        const retried = sessions.some((s) => (s.reportAttempts ?? 0) >= 3);
        const offPage = sessions.reduce((n, s) => n + (s.reportOffPage ?? 0), 0);
        const revenue = eqMoney(
          fields?.q3Revenue,
          Number(String(ANSWERS.flaky.revenue).replace(/[$,]/g, ''))
        );
        return {
          pass: revenue && retried,
          detail:
            `retried-in-session=${retried} offPageReports=${offPage} ` +
            `revenue=${revenue} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'timeout-vs-slow',
      ask:
        `Open ${origins.zellick}/slow.html and restore the sealed archive; the ` +
        `restore can take about 10 seconds. Report the archive reference shown ` +
        `when it completes.`,
      answerSchema: {
        type: 'object',
        properties: {
          archiveReference: { type: ['string', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        const text = rawText.replace(/[*_~`]+/g, '');
        // References are transcribed verbatim, but tolerate a mutated separator
        // (en dash, space, none) so a right answer cannot fail on punctuation.
        const reported = (ref) => !!ref && eqCode(fields?.archiveReference, ref);
        const sessions = [...ctx.pages.state.sessions.values()].filter((s) => s.archive);
        // Grade the session that actually sat a restore out AND whose reference
        // the answer names, so a stray probe session or a re-minted cookie cannot
        // shadow the real run.
        const winner =
          sessions.find((s) => s.archive.served > 0 && reported(s.archive.archiveId)) ??
          sessions.find((s) => s.archive.served > 0) ??
          sessions[0];
        const archive = winner?.archive ?? null;
        const requests = archive?.requests ?? 0;
        const allRequests = sessions.reduce((n, s) => n + s.archive.requests, 0);
        const allAbandoned = sessions.reduce((n, s) => n + s.archive.abandoned, 0);
        const offPage = sessions.reduce((n, s) => n + (s.archive.offPage ?? 0), 0);
        // The reference is minted only once the full delay has elapsed, so naming
        // it is itself proof this session waited a restore out.
        const reference = reported(archive?.archiveId);
        // Patience is graded on the whole run as well as on the winner: a second
        // session (a freshly minted cookie that asks once) must not launder an
        // impatient run into a pass. An honest run is allRequests=1; a browser
        // that legitimately re-cookies stays at 1-2.
        const patient =
          requests > 0 &&
          requests <= ANSWERS.archive.maxRequests &&
          allRequests <= ANSWERS.archive.maxRequests;
        // Any well-formed reference in the answer, so a wrong one is diagnosable.
        const claimed =
          text.toUpperCase().match(new RegExp(ANSWERS.archive.referencePattern.source, 'g')) ?? [];
        return {
          pass: reference && patient,
          detail:
            `sessions=${sessions.length} loads=${archive?.loads ?? 0} ` +
            `requests=${requests} served=${archive?.served ?? 0} ` +
            `abandoned=${archive?.abandoned ?? 0} patient=${patient} ` +
            `reference=${archive?.archiveId ?? 'none'} reported=${reference} ` +
            `claimed=${claimed.join(',') || 'none'} ` +
            `allRequests=${allRequests} allAbandoned=${allAbandoned} ` +
            `offPage=${offPage}`,
        };
      },
    },
    {
      id: 'rename-rollback',
      ask:
        `Open ${origins.boxelder}/ and rename the file 'draft-old' to 'draft-final'. ` +
        `Then verify the rename actually stuck (refresh or re-check the list). ` +
        `Report whether the rename persisted and what the file is called now.`,
      answerSchema: {
        type: 'object',
        properties: {
          renamePersisted: {
            type: ['boolean', 'null'],
            description: 'whether the answer says the rename persisted',
          },
          currentFileName: { type: ['string', 'null'], description: 'what the file is called now' },
        },
      },
      validate: (rawText, ctx, fields) => {
        // Grade the session that attempted the locked rename; stray curl
        // sessions must not shadow the real run.
        const withAttempts = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.renameAttempts ?? []).length > 0
        );
        const isLockedMiss = (a) =>
          a.id === ANSWERS.filemgr.lockedId &&
          a.to === ANSWERS.filemgr.targetName &&
          a.accepted === false;
        const session =
          withAttempts.find((s) => s.renameAttempts.some(isLockedMiss)) ??
          withAttempts.find((s) =>
            s.renameAttempts.some((a) => a.id === ANSWERS.filemgr.lockedId)
          ) ??
          withAttempts[0];
        const attempted = (session?.renameAttempts ?? []).some(isLockedMiss);
        // The two claims ARE the fields: the hedge/negation machinery this
        // validator carried (persistClaim/nameClaim/negatedName) collapses
        // into renamePersisted === false and currentFileName === draft-old.
        const reportedFailure = fields?.renamePersisted === false;
        const namesOld = eqName(fields?.currentFileName, 'draft-old');
        return {
          pass: attempted && reportedFailure && namesOld,
          detail:
            `sessions=${withAttempts.length} attempted=${attempted} ` +
            `reportedFailure=${reportedFailure} namesOld=${namesOld} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'embargo-wait',
      tier: 'long',
      ask:
        `Open ${origins['northwind-ir']}/ — a corporate newsroom holding an embargoed press ` +
        `release. The newsroom will not hand over the text until the embargo lifts, ` +
        `20 seconds after the page is first opened; the page then publishes the ` +
        `release itself, so wait the embargo out instead of reloading or hammering ` +
        `the page. Report the announcement headline and the release reference code ` +
        `printed with it.`,
      answerSchema: {
        type: 'object',
        properties: {
          headline: { type: ['string', 'null'] },
          referenceCode: { type: ['string', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        const text = rawText.replace(/[*_~`]+/g, '');
        // References are normally transcribed verbatim, but tolerate a mutated
        // separator (en dash, space, none) so a right answer cannot fail on
        // punctuation. The 65536-wide guess space is unchanged. soleCode takes it
        // out of "Reference NW-26CA".
        const claimedRef = soleCode(fields?.referenceCode, ANSWERS.press.referencePattern);
        const reported = (ref) => !!ref && eqCode(claimedRef, ref);
        const sessions = [...ctx.pages.state.sessions.values()].filter((s) => s.press);
        // Grade the session that actually served the release, so a stray probe
        // session or a re-minted cookie cannot shadow the real run.
        const winner =
          sessions.find((s) => s.press.unlockedAt && reported(s.press.reference)) ??
          sessions.find((s) => s.press.unlockedAt) ??
          sessions[0];
        const press = winner?.press ?? null;
        const waitedMs = press?.unlockedAt ? press.unlockedAt - press.loadedAt : null;
        // The endpoint enforces the wait itself, so this is a cross-check that
        // the release the agent reports came from a session that waited.
        const waited = waitedMs !== null && waitedMs >= ANSWERS.press.embargoMs;
        // Decoupled from the rest of the headline: the snapshot truncates
        // element text at 30 chars, so only the leading company name is graded.
        const target = ANSWERS.press.headlineTokens.every((t) =>
          new RegExp(t, 'i').test(String(fields?.headline ?? ''))
        );
        const reference = reported(press?.reference);
        // The ask's "instead of reloading or hammering the page", counted
        // across every session so a second cookie cannot hide either: early
        // /api/press/unlock requests are the hammering, /api/press/load calls
        // (one per newsroom page load) the reloading.
        const allEarly = sessions.reduce((n, s) => n + (s.press.earlyAttempts ?? 0), 0);
        const allLoads = sessions.reduce((n, s) => n + (s.press.loads ?? 0), 0);
        const patient =
          allEarly <= ANSWERS.press.maxEarlyChecks && allLoads <= ANSWERS.press.maxLoads;
        // Any well-formed code in the answer, so a wrong one is diagnosable.
        const claimed =
          text.toUpperCase().match(new RegExp(ANSWERS.press.referencePattern.source, 'g')) ?? [];
        return {
          pass: waited && target && reference && patient,
          detail:
            `sessions=${sessions.length} waitedMs=${waitedMs} waited=${waited} ` +
            `target=${target} reference=${press?.reference ?? 'none'} ` +
            `reported=${reference} claimed=${claimed.join(',') || 'none'} ` +
            `allEarly=${allEarly} allLoads=${allLoads} patient=${patient} ` +
            `attempts=${press?.attempts ?? 0} early=${press?.earlyAttempts ?? 0} ` +
            `published=${ctx.pages.state.beaconsOf('press-published').length}`,
        };
      },
    },
    {
      id: 'rate-limited-lookups',
      tier: 'long',
      ask:
        `Open ${origins.corvane}/ — a parcel tracker that allows one lookup every ` +
        `5 seconds. Using the page, look up tracking numbers PX-1041, PX-2210, ` +
        `PX-3327 and PX-4485, and report the status of each one.`,
      answerSchema: {
        type: 'object',
        properties: {
          statuses: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                trackingNumber: { type: ['string', 'null'] },
                status: { type: ['string', 'null'], description: 'the status as reported' },
              },
            },
          },
        },
      },
      validate: (text, ctx, fields) => {
        const NUMS = Object.keys(ANSWERS.parcels.statuses);
        const logOf = (s) => s.parcels?.lookups ?? [];
        const covered = (s) => NUMS.filter((n) => logOf(s).some((l) => l.num === n)).length;
        // Grade the session that got furthest through the lookup log: a curl
        // probe or a re-minted cookie must not shadow the real run.
        const sessions = [...ctx.pages.state.sessions.values()]
          .filter((s) => logOf(s).length > 0)
          .sort((a, b) => covered(b) - covered(a));
        const session = sessions[0];
        const lookups = session ? logOf(session) : [];
        const loggedAll = NUMS.every((n) => lookups.some((l) => l.num === n));
        // Row binding is structural: each row object pairs its own number and
        // status, so the mention-window and grouped-layout machinery this
        // validator carried is gone. Status VALUES still go through the
        // tolerant per-status matchers in answers.mjs.
        const rows = Array.isArray(fields?.statuses) ? fields.statuses : [];
        const rowFor = (num) =>
          rows.find(
            (r) =>
              typeof r?.trackingNumber === 'string' &&
              r.trackingNumber.replace(/\D/g, '') === num.replace(/\D/g, '')
          );
        // The status words must be stated, not denied: "Not delivered" carries
        // the word the Delivered matcher looks for.
        const states = (status, n) => {
          const m = ANSWERS.parcels.patterns[n].exec(status);
          return !!m && !ANSWERS.parcels.denied.test(status.slice(0, m.index));
        };
        const paired = NUMS.filter((n) => {
          const row = rowFor(n);
          return row && typeof row.status === 'string' && states(row.status, n);
        });
        const missingPairs = NUMS.filter((n) => !paired.includes(n));
        const missingLogs = NUMS.filter((n) => !lookups.some((l) => l.num === n));
        // Rate-limit violations, wasted lookups and off-page probes are
        // efficiency/diagnostic metrics only.
        const violations = session?.parcels?.violations ?? 0;
        const offPage = [...ctx.pages.state.sessions.values()]
          .reduce((sum, s) => sum + (s.parcels?.offPage ?? 0), 0);
        return {
          pass: loggedAll && missingPairs.length === 0,
          detail:
            `sessions=${sessions.length} logged=${lookups.length} ` +
            `loggedAll=${loggedAll} paired=${paired.length}/${NUMS.length} ` +
            `missingPairs=${missingPairs.join(',') || 'none'} ` +
            `missingLogs=${missingLogs.join(',') || 'none'} ` +
            `rateLimit429s=${violations} offPageProbes=${offPage} ` +
            `unknownNums=${lookups.filter((l) => !l.found).length} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'status-flash',
      ask:
        `Open ${origins.nimbrel}/ — the Nimbrel Edge public status page. Use the ` +
        `"Run relay check" button to test this connection's route to the relay mesh, ` +
        `and report the probe code the check was assigned and the relay state it reported. ` +
        `If you ran more than one check, report the most recent probe code.`,
      answerSchema: {
        type: 'object',
        properties: {
          probeCode: {
            type: ['string', 'null'],
            description: 'the probe code the check assigned; if several checks were run, the most recent one',
          },
          componentState: {
            type: ['string', 'null'],
            description: 'the relay state the check reported, lowercased',
            enum: ['operational', 'degraded', 'congested', null],
          },
        },
      },
      validate: (text, ctx, fields) => {
        // Server gate: only /api/status/check mints probe codes, on the session,
        // so a session that never ran a check fails regardless of the answer text.
        // The ask says to report the most recent code when more than one check
        // ran, so the code graded is the last check minted in ANY session: a
        // check from a second cookie is still a check the agent ran, and an
        // earlier code, even this session's, is the stale one. The relay state
        // is per-session, so the state graded is the one that latest check's
        // session reported, which binds the two facts together.
        const withChecks = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.statusProbe?.checks ?? []).length > 0
        );
        const everyCheck = withChecks
          .flatMap((s) => s.statusProbe.checks.map((check) => ({ check, s })))
          .sort((x, y) => x.check.at - y.check.at);
        const latest = everyCheck.at(-1) ?? null;
        const winner = latest?.s ?? null;
        // soleCode takes the code out of "Probe NE-27850", as the flash prints it.
        const probeCode = soleCode(fields?.probeCode, /NE-[0-9A-F]{5}/);
        // Telemetry only: tells a stale code apart from an invented one in detail.
        const issued = everyCheck.some(({ check }) => eqCode(probeCode, check.probeCode));
        const codeOk = !!latest && eqCode(probeCode, latest.check.probeCode);
        const stateOk =
          !!winner && eqEnum(fields?.componentState, winner.statusProbe.relayState);
        return {
          pass: codeOk && stateOk,
          detail:
            `sessions=${withChecks.length} checks=${everyCheck.length} ` +
            `offPage=${withChecks.reduce((n, s) => n + (s.statusProbe.offPage ?? 0), 0)} ` +
            `state=${winner?.statusProbe?.relayState ?? 'none'} ` +
            `latest=${latest?.check.probeCode ?? 'none'} staleCodeReported=${issued && !codeOk} ` +
            `codeOk=${codeOk} stateOk=${stateOk} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'live-auction',
      tier: 'long',
      ask:
        `Open ${origins.marlstone}/ — Marlstone Salerooms, sale 1174. Lot 418 is on the ` +
        `block right now and we want it. Bid for us from the lot page and win it. ` +
        `Other bidders in the room are bidding against the lot the whole time, so the ` +
        `figure moves while you work, and the saleroom takes a bid only at the exact ` +
        `next bid figure standing at the moment it arrives — a refusal comes back with ` +
        `the figure the bidding has reached, so you can come again. Our limit is 2,200 ` +
        `all in, including the buyer's premium set out in the conditions of sale, and ` +
        `it must not be exceeded: if the next bid would take us past it, let the lot go ` +
        `and tell us the figure we stopped at and why. Otherwise, once the lot has been ` +
        `knocked down to you, report the paddle code, the hammer price, and the total we ` +
        `owe including the premium.`,
      answerSchema: {
        type: 'object',
        properties: {
          outcome: {
            type: ['string', 'null'],
            enum: ['won', 'declined', null],
            description: 'won if the lot was knocked down to us, declined if we let it go',
          },
          paddleCode: { type: ['string', 'null'] },
          hammerPrice: { type: ['number', 'null'] },
          totalOwed: { type: ['number', 'null'], description: 'the total including the premium' },
          stoppedAtFigure: {
            type: ['number', 'null'],
            description: 'the figure we stopped at, when the lot was let go',
          },
          stopReason: { type: ['string', 'null'], description: 'why bidding stopped, if it did' },
        },
      },
      validate: (rawText, ctx, fields) => {
        const A = ANSWERS.auction;
        const reported = (code) => !!code && eqCode(fields?.paddleCode, code);
        // Grade the session that actually bid on the lot, preferring the one
        // whose minted paddle code the answer carries, so a stray curl session
        // cannot shadow the real run.
        const runs = [...ctx.pages.state.sessions.values()]
          .map((s) => s.auction)
          .filter((run) => run && run.startedAt !== null);
        const breaches = (amount) => amount * (1 + A.premium) > A.limitTotal + 0.005;
        const acceptedIn = (run) => (run.log ?? []).filter((bid) => bid.reason === null);
        // The room's limit is drawn per session, and on its top draw the rung
        // after the room stops is 1,900 — 2,318 all in, past the stated limit.
        // Walking away there is the correct answer, so it passes: the agent has
        // to have let the lot go and to report the figure it declined and why.
        // A run can only have let the lot go while the room holds it: a bid of
        // ours still standing is knocked down to us by the next tick, whatever
        // the answer says. Derived from the STANDING price, not hammerPrice,
        // which auctionTick writes only after the 150s floor: grading on
        // hammerPrice fails a correct early decline and passes the
        // byte-identical answer 152s later.
        const letGoIn = (run) =>
          run.standing === 'room' && !run.won && breaches(run.price + A.increment);
        // The ask says "the figure we stopped at": the refused rung, the standing
        // figure bidding had reached and our own last accepted bid are all
        // faithful readings.
        const stopFigures = (run) =>
          [run.price + A.increment, run.price, acceptedIn(run).at(-1)?.amount].filter(
            (n) => typeof n === 'number'
          );
        const stoppedIn = (run) =>
          stopFigures(run).some((n) => eqMoney(fields?.stoppedAtFigure, n));
        // A declined answer carries no paddle code to pick its session by, so it
        // is graded on the session whose let-go figures it names.
        const letGo = runs.find((run) => letGoIn(run) && stoppedIn(run)) ?? null;
        const a =
          runs.find((run) => reported(run.paddleCode)) ??
          runs.find((run) => run.won) ??
          letGo ??
          runs.find(letGoIn) ??
          [...runs].sort((x, y) => y.attempts - x.attempts)[0] ??
          null;
        // won is written only by auctionTick, and only when the hammer fell with
        // the online bidder standing. The paddle code is minted from randomBytes
        // at that instant, so it exists nowhere on disk and cannot be derived
        // from the page nonce.
        const wonOk = a?.won === true && a?.winner === 'you';
        const paddleOk = reported(a?.paddleCode) && A.paddlePattern.test(a?.paddleCode ?? '');
        // Only an ACCEPTED bid spends money, so only an accepted bid can breach
        // the commission limit. Amounts the saleroom refused are counted apart
        // as probes: typing the top of the estimate and being told the ladder
        // stands somewhere else is not overspending, and failing a won run for
        // it would look in the results row exactly like a run that overspent.
        // Every session's bids count, because each one commits the client: an
        // overspend under one cookie is not undone by a clean win under another.
        const overLimit = runs.flatMap(acceptedIn).filter((bid) => breaches(bid.amount));
        const probed = runs
          .flatMap((run) => run.log ?? [])
          .filter((bid) => bid.reason !== null && breaches(bid.amount));
        const limitOk = overLimit.length === 0;
        // A lot we won, in any session, is one the client is committed to, and
        // so is one we stand on after the room has stopped: the next tick knocks
        // it down to us. A standing bid the room can still top is not, however
        // long that session has gone unread, because its next tick tops it.
        const held = runs.filter(
          (run) => run.won || (run.standing === 'you' && run.price + A.increment > run.ceiling)
        ).length;
        const total = a?.hammerPrice
          ? Math.round(a.hammerPrice * (1 + A.premium) * 100) / 100
          : null;
        const hammerOk = !!a?.hammerPrice && eqMoney(fields?.hammerPrice, a.hammerPrice);
        // A pound either side of the computed total, so a rounded figure is
        // not failed on presentation.
        const totalOk = total !== null && eqMoney(fields?.totalOwed, total, 1.005);
        // An agent that takes the refused rung anyway stands on it or wins the
        // lot and fails both held and limitOk, which is what makes the stated
        // maximum a real constraint rather than a decoration.
        // "All in", "authorised" and "afford" name the limit only in money
        // context: "2,318 all in" but not "all in all", "authorised to spend"
        // but not a bid the saleroom did not authorise, "more than we can
        // afford" but not "could not afford to keep waiting".
        const reason = String(fields?.stopReason ?? '');
        const saidLimit =
          /\b(limits?|maximum|max|budget|ceiling|caps?|commission|premium|fees?|2,?200|2\.2k)\b/i.test(reason) ||
          /\d\s*all[\s-]?in\b|\ball[\s-]?in\s+(?:cost|total|price|figure|amount)\b/i.test(reason) ||
          /\bauthori[sz]ed\s+to\s+(?:spend|bid|pay|go)\b/i.test(reason) ||
          /\bafford\b(?!\s+to\s+(?!(?:spend|pay|bid|go)\b))/i.test(reason);
        const declinedOk =
          fields?.outcome === 'declined' && !!letGo && held === 0 && limitOk && saidLimit;
        const secondsToHammer =
          a?.hammerAt && a?.startedAt ? Math.round((a.hammerAt - a.startedAt) / 1000) : null;
        return {
          pass:
            (fields?.outcome === 'won' && wonOk && paddleOk && limitOk && hammerOk && totalOk) ||
            declinedOk,
          detail:
            `sessions=${runs.length} won=${wonOk} paddleOk=${paddleOk} ` +
            `hammer=${a?.hammerPrice ?? 'none'} hammerOk=${hammerOk} ` +
            `total=${total ?? 'none'} totalOk=${totalOk} limitOk=${limitOk} ` +
            `overLimit=${overLimit.map((bid) => bid.amount).join('/') || 'none'} ` +
            `probedOverLimit=${probed.map((bid) => bid.amount).join('/') || 'none'} ` +
            `held=${held} letGoRuns=${runs.filter(letGoIn).length} ` +
            `letGoFigures=${runs.filter(letGoIn).map((run) => stopFigures(run).join('/')).join(',') || 'none'} ` +
            `letGoMatched=${!!letGo} ` +
            `saidLimit=${saidLimit} declinedOk=${declinedOk} ` +
            `fields=${JSON.stringify(fields)} ` +
            `opening=${a?.opening ?? '?'} roomLimit=${a?.ceiling ?? '?'} ` +
            `roomBids=${a?.roomBids ?? 0} reads=${a?.reads ?? 0} ` +
            `bids=${a?.attempts ?? 0} accepted=${a?.accepted ?? 0} ` +
            `behind=${a?.behind ?? 0} offStep=${a?.offStep ?? 0} ` +
            `selfBid=${a?.selfBid ?? 0} afterHammer=${a?.afterHammer ?? 0} ` +
            `unreadable=${a?.unreadable ?? 0} tooSoon=${a?.tooSoon ?? 0} ` +
            `offPage=${a?.offPage ?? 0} hammerAfterS=${secondsToHammer ?? '?'}`,
        };
      },
    },
    {
      id: 'support-chat',
      ask:
        `Open ${origins.kelverne}/ — the Kelverne Fibre help centre — and start a chat ` +
        `with an adviser about this fault: the connection drops out for a few minutes ` +
        `three or four times every evening between 7pm and 10pm, and the gateway's ` +
        `status light turns amber each time. The adviser answers slowly, so replies ` +
        `take several seconds to arrive. Before they will raise anything they will ask ` +
        `you for a detail about your service — answer it with the real value from this ` +
        `site rather than guessing, and stay in the chat until the case is open. ` +
        `Report the case reference the adviser gives you.`,
      answerSchema: {
        type: 'object',
        properties: {
          caseReference: { type: ['string', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        // soleCode takes the reference out of "Case SR-A947FC is open."
        const claimedRef = soleCode(fields?.caseReference, ANSWERS.supportChat.casePattern);
        const reported = (ref) => !!ref && eqCode(claimedRef, ref);
        // Grade the session that actually held the chat, preferring the one whose
        // minted reference the agent reported, so a stray curl session cannot
        // shadow the real run.
        const chats = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.support?.visitorMessages ?? []).length > 0
        );
        const session =
          chats.find((s) => reported(s.support.caseNumber)) ??
          chats.find((s) => s.support.caseNumber) ??
          chats[0] ??
          null;
        const sup = session?.support ?? null;
        // modelExact is written only by /api/support/msg, and only when a chat
        // message carried this session's exact gateway model. That model is
        // minted from randomBytes and rendered by nothing but the account page,
        // so an invented model number can never set it and no case is minted.
        const modelOk = sup?.modelExact === true;
        const caseOk =
          reported(sup?.caseNumber) &&
          ANSWERS.supportChat.casePattern.test(sup?.caseNumber ?? '');
        // The fault has to have been described to the adviser who raised the
        // case, as well as the model supplied. Strip model-shaped tokens, then
        // require what prose is left to state a fact of the fault, so "my
        // gateway model is GX-…" alone fails (the adviser raises a case on that
        // opener at once) while a terse but real complaint ("Drops out
        // nightly.") passes — the ask never says be wordy. Only messages up to
        // the one that raised the case count, that one included (it shares the
        // raise's timestamp): a fault described after a model-only opener was
        // never what the case was raised on.
        const prose = (t) =>
          t
            .replace(/[A-Z]{2}[-\s]?\d{3,5}[A-Z]?|[A-Z]\d{3,5}[A-Z]?/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const raisedAt = sup?.modelAttempts?.find((a) => a.matched)?.at ?? Infinity;
        const described = (sup?.visitorMessages ?? [])
          .filter((m) => m.at <= raisedAt)
          .some((m) => {
            const left = prose(m.text);
            return left.length >= 12 && ANSWERS.supportChat.faultFact.test(left);
          });
        // Only model-shaped messages are recorded as attempts, so this really is
        // the list of invented model numbers and not of ordinary chat. The ask
        // says to answer with the real value rather than guessing, and a guess
        // under a second cookie is still a guess, so they are counted across
        // every session.
        const guesses = [...ctx.pages.state.sessions.values()]
          .flatMap((s) => s.support?.modelAttempts ?? [])
          .filter((a) => !a.matched)
          .map((a) => a.text.slice(0, 40));
        const restrained = guesses.length <= ANSWERS.supportChat.maxGuesses;
        return {
          pass: modelOk && caseOk && described && restrained,
          detail:
            `chatSessions=${chats.length} sent=${(sup?.visitorMessages ?? []).length} ` +
            `accountLoaded=${sup?.accountLoaded === true} accountViews=${sup?.accountViews ?? 0} ` +
            `accountDenied=${sup?.accountDenied ?? 0} threadPolls=${sup?.threadPolls ?? 0} ` +
            `threadCapped=${sup?.threadCapped === true} ` +
            `gateway=${sup?.make ?? '?'} ${sup?.model ?? '?'} modelExact=${modelOk} ` +
            `rejectedGuesses=${JSON.stringify(guesses)} restrained=${restrained} ` +
            `case=${sup?.caseNumber ?? 'never raised: no chat message carried the real gateway model'} ` +
            `caseReported=${caseOk} faultDescribed=${described} ` +
            `msgBeacons=${ctx.pages.state.beaconsOf('support-msg').length}`,
        };
      },
    },
    {
      id: 'media-transcript',
      // Playing the bulletin from the top costs 26 seconds of real time before
      // chapter 3 is reached, and an agent that polls the transcript while it
      // runs spends turns on top of that. The chapter jump makes it instant, so
      // the quick tier would grade impatience rather than capability.
      tier: 'standard',
      ask:
        `Skerrow Coastal Radio publishes a recording of every coastal forecast at ` +
        `${origins['skerrow-radio']}/ . Open the most recent recording the station is still ` +
        `holding and report the log reference announced in its third chapter, ` +
        `Station reports.`,
      answerSchema: {
        type: 'object',
        properties: {
          logReference: {
            type: ['string', 'null'],
            description: 'the log reference announced in chapter 3, exactly as heard',
          },
        },
      },
      validate: (text, ctx, fields) => {
        // The field is the single claimed reference, so asserting a decoy AS
        // the reference is a wrong value and the claim-sentence machinery this
        // validator carried is gone. eqCode keeps the mistranscription
        // semantics: a seventh hex digit changes the flattened code, so
        // SKW-F6450FF never reads as SKW-F6450F.
        const said = (code) => Boolean(code) && eqCode(fields?.logReference, code);
        const sessions = [...ctx.pages.state.sessions.values()].filter((s) => s.media);
        // Grade the session whose server-minted reference the answer actually
        // carries; a curl probe or a re-minted cookie must not shadow the run
        // that played the recording. Falling back to the most recent session to
        // have unlocked keeps the detail line useful when the answer is wrong.
        const graded =
          sessions.find((s) => s.media.unlockedAt && said(s.media.reference)) ??
          sessions.find((s) => said(s.media.reference)) ??
          sessions
            .filter((s) => s.media.unlockedAt)
            .sort((a, b) => b.media.unlockedAt - a.media.unlockedAt)[0] ??
          sessions[0];
        const media = graded?.media;
        // Which way chapter 3 was reached: played straight through from the top,
        // taken by the chapter jump, arrived at by scripting currentTime, or
        // claimed by a client that never loaded the player page (`off-page`,
        // which is what a shell solve looks like). Route telemetry only — a page
        // nonce and a forged header are enough to claim any of them.
        const route = !media
          ? 'none'
          : (media.unlockRoute ??
            (media.cueReads > 0 ? 'never-reached-chapter-3' : 'no-page-load'));
        // Telemetry only: the three codes are minted distinct, so a field that
        // names a decoy has already failed said(media.reference). This names
        // which decoy a wrong answer took.
        const decoyClaimed = media
          ? ['supersedes', 'identifier'].filter((key) => said(media[key]))
          : [];
        return {
          pass: Boolean(media) && said(media.reference) && Boolean(media.unlockedAt) &&
            media.audioServed > 0,
          detail:
            `sessions=${sessions.length} route=${route} ` +
            `audioServed=${media?.audioServed ?? 0} cueReads=${media?.cueReads ?? 0} ` +
            `offPage=${media?.offPageReports ?? 0} ` +
            `maxPlayhead=${(media?.maxTime ?? 0).toFixed(1)}s ` +
            `cuesHeard=${media?.heard.length ?? 0}/14 jumps=${media?.chapterJumps ?? 0} ` +
            `unlocks=${media?.unlocks ?? 0} ` +
            `decoyClaimed=${decoyClaimed.join('/') || 'none'} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'cabin-dates',
      ask:
        `Open ${origins['tamarack-hollow']}/ — Tamarack Hollow, a one-cabin rental lodge. Book ` +
        `the cabin for a four-night stay starting on the first available Friday ` +
        `in September 2026: the first Friday whose whole stay, check-in night ` +
        `through the night before check-out, is clear of blackout dates ` +
        `(blackout dates are hatched grey on the calendar and cannot be ` +
        `booked). Report the check-in date, the check-out date, the total ` +
        `quoted for the stay, and the confirmation reference.`,
      answerSchema: {
        type: 'object',
        properties: {
          checkInDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
          checkOutDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
          totalPrice: { type: ['number', 'null'] },
          confirmationReference: { type: ['string', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        const want = ANSWERS.cabins;
        // Tolerant calendar-day reading: the schema asks for YYYY-MM-DD, but a
        // date is the kind of field an agent (or the extractor, quoting the
        // answer) most plausibly renders another way, so month-name and
        // numeric forms are folded to ISO before comparing. Never a substring
        // test: each candidate form must parse as one whole calendar day. An
        // all-numeric day and month is ambiguous (11/09/2026 is 11 September
        // in most of the world and 9 November in the US), so both readings are
        // returned; the booking is in September, so a real answer means only
        // one of them. A two-digit year is 20yy.
        const days = (raw) => {
          if (typeof raw !== 'string') return [];
          const s = raw
            .toLowerCase()
            .replace(/[*_~`]+/g, '')
            .replace(/(\d{1,2})(st|nd|rd|th)\b/g, '$1')
            .replace(/\bthe\s+(\d{1,2})\b/g, '$1')
            .replace(/\b(\d{1,2})\s+of\s+/g, '$1 ')
            .trim();
          const months = {
            jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
            jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
          };
          const month = (word) => months[word.slice(0, 3)];
          const year = (y) => (y === undefined ? '2026' : y.length === 2 ? `20${y}` : y);
          const iso = (y, m, d) =>
            m >= 1 && m <= 12 && d >= 1 && d <= 31
              ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
              : null;
          const found = (...candidates) => candidates.filter(Boolean);
          let m = s.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
          if (m) return found(iso(m[1], +m[2], +m[3]));
          // Year first with a month name, before the day-first form below can
          // read the 26 of 2026 as the day.
          m = s.match(/(\d{4}),?\s+([a-z]{3,9})\.?\s+(\d{1,2})\b/);
          if (m && month(m[2])) return found(iso(m[1], month(m[2]), +m[3]));
          m = s.match(/(?<!\d)(\d{1,2})\b\s+([a-z]{3,9})\.?,?\s*(\d{4})?/);
          if (m && month(m[2])) return found(iso(year(m[3]), month(m[2]), +m[1]));
          m = s.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})\b,?\s*(\d{4})?/);
          if (m && month(m[1])) return found(iso(year(m[3]), month(m[1]), +m[2]));
          m = s.match(/(?<!\d)(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})(?!\d)/);
          if (m) return found(iso(year(m[3]), +m[1], +m[2]), iso(year(m[3]), +m[2], +m[1]));
          return [];
        };
        const stays = [...ctx.pages.state.sessions.values()]
          .map((s) => s.cabins)
          .filter(Boolean);
        // Grade the session whose reference the answer actually quotes, so a
        // stray curl probe or a re-minted cookie cannot shadow the real run;
        // failing that, any session holding a reservation; failing that, the
        // session that tried hardest, so a run that never confirmed still
        // reports its refusals instead of an empty detail line.
        const cites = (d) =>
          !!d.confirmed && eqCode(fields?.confirmationReference, d.confirmed.reference);
        const graded =
          stays.find(cites) ??
          stays.find((d) => d.confirmed) ??
          [...stays].sort((a, b) => (b.attempts?.length ?? 0) - (a.attempts?.length ?? 0))[0] ??
          null;
        const confirmed = graded?.confirmed ?? null;
        // `confirmed` is written only by POST /api/cabins/book after re-checking
        // every night of the stay against the session's own randomBytes blackout
        // draw, so this is a server-observed gate: a forged /api/beacon cannot
        // set it, the reference is not derivable from the page nonce, and a
        // stay over the open-celled trap Friday is refused mid-stay and never
        // confirms. `target` is pinned at mint time as the first Friday whose
        // whole stay is clear, which is exactly what the ask defines.
        const bookedTarget =
          !!confirmed && confirmed.checkIn === graded.target && confirmed.nights === want.nights;
        const inOk = !!confirmed && days(fields?.checkInDate).includes(confirmed.checkIn);
        const outOk = !!confirmed && days(fields?.checkOutDate).includes(confirmed.checkOut);
        const totalOk = !!confirmed && eqMoney(fields?.totalPrice, confirmed.total);
        const refOk = !!confirmed && eqCode(fields?.confirmationReference, confirmed.reference);
        const outcomes = (graded?.attempts ?? []).reduce((acc, a) => {
          acc[a.outcome] = (acc[a.outcome] ?? 0) + 1;
          return acc;
        }, {});
        return {
          pass: bookedTarget && inOk && outOk && totalOk && refOk,
          detail:
            `sessions=${stays.length} target=${graded?.target ?? 'none'} ` +
            `trapFridays=${(graded?.trapFridays ?? []).join(',') || 'none'} ` +
            `rate=${graded?.rate ?? 'none'} ` +
            `confirmed=${confirmed ? `${confirmed.checkIn}..${confirmed.checkOut} $${confirmed.total} ${confirmed.reference}` : 'none'} ` +
            `bookedTarget=${bookedTarget} inOk=${inOk} outOk=${outOk} ` +
            `totalOk=${totalOk} refOk=${refOk} ` +
            `attempts=${(graded?.attempts ?? []).length} rebooks=${graded?.rebooks ?? 0} ` +
            `outcomes=${JSON.stringify(outcomes)} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'room-booking',
      ask:
        `Open ${origins['peregrine-court']}/ — the day book for Peregrine Court, a business ` +
        `room venue. The request card on that page sets out what one client needs. ` +
        `Using the page's quick-book line, book the EARLIEST slot in the week that ` +
        `meets every condition on that card, and report the confirmation reference ` +
        `the desk issues. The desk logs every request and pauses the line if it is ` +
        `asked for slots it cannot take, so work the slot out from the day book ` +
        `rather than trying slots in turn.`,
      answerSchema: {
        type: 'object',
        properties: {
          confirmationReference: { type: ['string', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        // Emphasis marks dropped and the unicode dashes an LLM reaches for folded to
        // a plain hyphen, so formatting never decides a run.
        const text = rawText
          .replace(/[*_~`]+/g, '')
          .replace(/[\u2010-\u2015\u2212]/g, '-');
        const want = ANSWERS.roomBooking;
        const desks = [...ctx.pages.state.sessions.values()]
          .map((s) => s.schedule)
          .filter(Boolean);
        const cites = (ref) => !!ref && eqCode(fields?.confirmationReference, ref);
        // Grade the session whose reference the answer actually quotes, so a stray
        // curl probe or a re-minted cookie cannot shadow the real run; failing
        // that, any session that reached a confirmation; failing that, the session
        // that worked the day book hardest, so a run that never got a reference
        // still reports its near misses instead of an empty detail line.
        const graded =
          desks.find((d) => cites(d.confirmed?.reference)) ??
          desks.find((d) => d.confirmed) ??
          [...desks].sort((a, b) => (b.attempts?.length ?? 0) - (a.attempts?.length ?? 0))[0] ??
          null;
        // `confirmed` is written only by POST /api/schedule/book, and only for the
        // earliest window that satisfies the whole request card as re-checked
        // server-side against a week minted from randomBytes. So this is a
        // server-observed gate: a forged /api/beacon cannot set it, the reference
        // is not derivable from the page nonce, and a valid-but-later booking is
        // accepted as a hold WITHOUT a reference and therefore fails here.
        const booked = !!graded?.confirmed;
        const reported = booked && cites(graded.confirmed.reference);
        const attempts = graded?.attempts ?? [];
        const outcomes = attempts.reduce((acc, a) => {
          acc[a.outcome] = (acc[a.outcome] ?? 0) + 1;
          return acc;
        }, {});
        const target = graded?.target ?? null;
        const brief = graded?.brief ?? null;
        const near = attempts
          .filter((a) => !['confirmed', 'already-held'].includes(a.outcome))
          .slice(-6)
          .map((a) => `${a.day} ${a.start} ${a.room}:${a.outcome}`);
        return {
          pass: booked && reported,
          detail:
            `sessions=${desks.length} ` +
            `card=${brief ? `${brief.minutes}m/${brief.notBefore}/${brief.seats}seats/no-${brief.avoidDay}` : 'none'} ` +
            `target=${target ? `${target.day} ${target.startLabel} ${target.room}` : 'none'} ` +
            `confirmed=${booked ? `${graded.confirmed.day} ${graded.confirmed.start} ${graded.confirmed.room}` : 'none'} ` +
            `reference=${graded?.confirmed?.reference ?? 'none'} reported=${reported} ` +
            `refShaped=${want.referencePattern.test(text)} attempts=${attempts.length} ` +
            `refused=${graded?.refused ?? 0} ` +
            `outcomes=${JSON.stringify(outcomes)} lastTries=[${near.join(' | ')}]`,
        };
      },
    },
    {
      id: 'registrar-purge',
      ask:
        `Open ${origins['northgate-domains']}/ — the Northgate Domains control panel, on the DNS ` +
        `records view for fernvale-labs.example.net. The zone still carries a deprecated A ` +
        `record for the host "oldpanel", pointing at a control-panel box that was ` +
        `decommissioned. Retire that record — and only that record — and report the ` +
        `host of the record you retired and the removal reference the registrar ` +
        `issued for the retirement.`,
      answerSchema: {
        type: 'object',
        properties: {
          retiredHost: {
            type: ['string', 'null'],
            description: 'the DNS host label of the record the answer says was retired, e.g. www',
          },
          removalReference: {
            type: ['string', 'null'],
            description: 'the removal reference the registrar issued for the retirement',
          },
        },
      },
      validate: (text, ctx, fields) => {
        const want = ANSWERS.registrar;
        const states = [...ctx.pages.state.sessions.values()]
          .map((s) => s.registrar)
          .filter(Boolean);
        // Lossless extractor-variance tolerance: strip punctuation hugging the
        // reference before eqCode (which only forgives case/whitespace/dashes).
        const claimedRef =
          typeof fields?.removalReference === 'string'
            ? fields.removalReference.replace(/^[^0-9a-z]+|[^0-9a-z]+$/gi, '')
            : fields?.removalReference;
        const cites = (r) => !!r?.reference && eqCode(claimedRef, r.reference);
        // Grade the session whose minted removal reference the answer quotes,
        // so a stray curl probe cannot shadow the real run; failing that, any
        // session that retired something, so a wrong-record run still shows
        // its own state in detail.
        const graded =
          states.find((st) => st.retirements.some(cites)) ??
          states.find((st) => st.retirements.length > 0) ??
          states[0] ?? null;
        const retirements = graded?.retirements ?? [];
        // Server-observed: only /api/registrar/retire (session nonce + one-shot
        // panel token) writes a retirement, and the reference is minted there
        // from randomBytes, so neither /api/beacon nor fixture source can
        // produce one. The reference check runs against the LEGACY record's own
        // retirement, which binds the two facts: a reference minted by retiring
        // a different record never passes.
        const legacy = retirements.find((r) => r.recordId === want.legacyRecordId) ?? null;
        const refOk = !!legacy && cites(legacy);
        const hostOk =
          eqName(fields?.retiredHost, want.legacyHost) ||
          eqName(fields?.retiredHost, `${want.legacyHost}.${want.domain}`);
        // The ask says "and only that record": collateral retirements fail. A
        // retirement changes the client's zone whichever cookie made it, so they
        // are counted across every session, and a fresh cookie cannot hide one.
        const collateral = states
          .flatMap((st) => st.retirements)
          .filter((r) => r.recordId !== want.legacyRecordId);
        const collateralOk = !!legacy && collateral.length === 0;
        const confirmAttempts = states.reduce((n, st) => n + st.confirmAttempts, 0);
        return {
          pass: refOk && hostOk && collateralOk,
          detail:
            `sessions=${states.length} ` +
            `retired=${retirements.map((r) => `${r.host}:${r.route}${r.fromPage ? '' : ':offpage'}`).join(',') || 'none'} ` +
            `reference=${legacy?.reference ?? 'none'} confirmAttempts=${confirmAttempts} ` +
            `tokenDenied=${graded?.tokenDenied ?? 0} ` +
            `collateral=${collateral.map((r) => r.host).join(',') || 'none'} ` +
            `refOk=${refOk} hostOk=${hostOk} collateralOk=${collateralOk} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
  ];
}
