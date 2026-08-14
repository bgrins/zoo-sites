// Rich interaction: puzzles, canvas, shadow DOM, spatial search, drag-and-drop, diffs, and formula grids.
//
// One family of the web suite. tasks/web.mjs concatenates every family; see
// docs/authoring-fixtures.md for the rules a task and its fixture must follow.

import { originUrls } from '../../../manifest.mjs';
import { ANSWERS } from '../../answers.mjs';
import { eqCode, eqEnum, normaliseWords } from '../../extract.mjs';

export async function interactionTasks(base, origins = originUrls(base)) {
  return [
    {
      id: 'lexvane',
      ask:
        `Open ${origins.marrowfield}/?day=0 — a word puzzle. Play it until you solve it ` +
        `(you have 6 guesses; use the per-letter feedback shown after each guess to choose ` +
        `your next word). Then report the answer word and how many guesses you used.`,
      answerSchema: {
        type: 'object',
        properties: {
          answerWord: { type: ['string', 'null'] },
          guessesUsed: { type: ['integer', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        // Server-observed, exactly like lexvane-hard: the day-0 word is held in
        // server.mjs and every guess goes through /api/lexvane/guess, so a solve
        // has to be played. Grade the session that actually won, so a stray curl
        // probe cannot shadow the real run. The word is an ordinary English
        // adjective, so an unanchored regex over the answer text with no server
        // gate would pass "the autumn air was crisp".
        const games = [...ctx.pages.state.sessions.values()]
          .map((s) => s.lexvaneEasy?.[0])
          .filter(Boolean);
        const game = games.find((g) => g.won) ?? games[0];
        const won = game?.won === true;
        const used = game?.guesses.length ?? 0;
        // won === true is the real gate; the word and count are graded as
        // fields because the ask asks for them.
        const wordOk = eqEnum(fields?.answerWord, ANSWERS.lexvane.day0Word);
        const countOk = used > 0 && fields?.guessesUsed === used;
        return {
          pass: won && wordOk && countOk,
          detail:
            `sessions=${games.length} won=${won} used=${used} ` +
            `wordOk=${wordOk} countOk=${countOk} ` +
            `guesses=${(game?.guesses ?? []).map((g) => g.guess).join(',') || 'none'} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'lexvane-hard',
      ask:
        `Open ${origins.marrowfield}/?mode=hard&day=3 — the hard-mode word puzzle. ` +
        `The word is 7 letters and you get 5 tries, and hard mode is binding: ` +
        `every hint you have revealed must be reused in later guesses (a letter ` +
        `marked right-spot must stay in that spot, a letter marked in-word must ` +
        `appear again). A guess that drops a hint is refused and does not cost a try. ` +
        `Solve the puzzle, then report the answer word and the counted guess number ` +
        `the board ends on (the N in "Guess N of 5").`,
      answerSchema: {
        type: 'object',
        properties: {
          answerWord: { type: ['string', 'null'] },
          finalGuessNumber: {
            type: ['integer', 'null'],
            description: 'the N in "Guess N of 5" the board ends on',
          },
        },
      },
      validate: (rawText, ctx, fields) => {
        // Grade the session that actually played day 3 through the gated
        // endpoint, so a stray curl probe cannot shadow the real run. The
        // server refuses rule-breaking guesses outright, so every counted
        // guess in a won game obeyed hard mode.
        const games = [...ctx.pages.state.sessions.values()]
          .map((s) => s.lexvaneHard?.[3])
          .filter(Boolean);
        const game = games.find((g) => g.won) ?? games[0];
        const won = game?.won === true;
        const used = game?.guesses.length ?? 0;
        const refused = game?.violations.length ?? 0;
        // The five-try cap is the whole point, so it is enforced across ALL
        // sessions: minting fresh cookies to farm feedback on the same word and
        // then winning in one guess spends more than five counted guesses in
        // total. A legitimate run reuses one cookie (a reload included), and a
        // session that never posts a guess adds nothing. 5 = LEXVANE_HARD_TRIES.
        const totalUsed = games.reduce((sum, g) => sum + g.guesses.length, 0);
        const withinBudget = totalUsed <= 5;
        const wordOk = eqEnum(fields?.answerWord, ANSWERS.lexvane.hardDay3);
        // Either the counted guesses or counted-plus-refused ("5 attempts, 2
        // refused"), because won === true is the real gate.
        const countOk = used > 0 && [used, used + refused].includes(fields?.finalGuessNumber);
        return {
          pass: won && wordOk && countOk && withinBudget,
          detail:
            `sessions=${games.length} won=${won} used=${used} totalUsed=${totalUsed} ` +
            `withinBudget=${withinBudget} wordOk=${wordOk} countOk=${countOk} ` +
            `refusedGuesses=${refused} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'canvas-pick',
      ask:
        `Open ${origins['canvas-swatch']}/swatch.html — a color swatch grid drawn on a canvas ` +
        `(no clickable DOM elements per cell). Click the only ORANGE cell in the ` +
        `grid; a code will be revealed below the canvas. Report that code.`,
      answerSchema: {
        type: 'object',
        properties: {
          code: { type: ['string', 'null'], description: 'the code revealed below the canvas' },
        },
      },
      validate: (rawText, ctx, fields) => {
        const picks = ctx.pages.state.beaconsOf('canvas-pick');
        // A winning pick must not sit behind a blind sweep: 48 reveal POSTs with
        // zero canvas interaction otherwise pass, and per-session counters alone
        // are defeated by re-minting the session per guess. Exploration is
        // counted by ORDER across all sessions, so a stray probe after the win
        // cannot poison an honest run, and a sweep's own late hit can never
        // qualify. Thresholds are generous for honest misclicks (a few wrong
        // cells, a reload).
        const winner = picks.find((b, i) => {
          if (b.data?.cell !== ANSWERS.canvas.orangeCell) return false;
          const before = new Set(picks.slice(0, i).map((p) => p.data?.cell));
          const ownPicks = picks.slice(0, i + 1).filter((p) => p.sid === b.sid).length;
          const code = ctx.pages.state.sessions.get(b.sid)?.canvasCode;
          return before.size <= 6 && ownPicks <= 4 && eqCode(fields?.code, code);
        });
        const offPage = picks.filter((b) => b.data?.fromPage === false).length;
        return {
          pass: !!winner,
          detail:
            `picks=${picks.length} correctPicks=` +
            `${picks.filter((b) => b.data?.cell === ANSWERS.canvas.orangeCell).length} ` +
            `offPage=${offPage} winner=${winner ? 'yes' : 'no'} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'shadow-unlock',
      ask:
        `Open ${origins.metronome}/ — a facility access console. Enter the access code ` +
        `"ORCHID-22" in the access widget and press Unlock. Report the exact message ` +
        `shown after unlocking.`,
      answerSchema: {
        type: 'object',
        properties: {
          message: { type: ['string', 'null'], description: 'the exact message shown after unlocking' },
        },
      },
      validate: (text, ctx, fields) => {
        const unlocks = ctx.pages.state
          .beaconsOf('shadow-unlock')
          .filter((b) => b.data?.code === ANSWERS.shadow.code);
        const unlocked = unlocks.length > 0;
        // Route legibility, never a gate: an off-page unlock still passes by
        // policy, but it must be visible in the results row.
        const offPage = unlocks.filter((b) => b.data?.fromPage === false).length;
        const messageOk = new RegExp(ANSWERS.shadow.message, 'i').test(String(fields?.message ?? ''));
        return {
          pass: unlocked && messageOk,
          detail:
            `unlocked=${unlocked} offPageUnlocks=${offPage}/${unlocks.length} ` +
            `messageOk=${messageOk} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'maze-escape',
      tier: 'long',
      ask:
        `Open ${origins.ostara}/ — the traverse console for a surface rover parked ` +
        `at survey grid cell A1. Drive the rover to the extraction pad at F6 ` +
        `using the drive controls. The console maps obstructions only for the ` +
        `cells the rover has entered, so you have to explore; a drive into an ` +
        `obstruction is refused and moves nothing. When the rover reaches the ` +
        `pad, report the extraction code the console shows.`,
      answerSchema: {
        type: 'object',
        properties: {
          extractionCode: { type: ['string', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        const runs = [...ctx.pages.state.sessions.values()]
          .map((s) => s.maze)
          .filter((m) => m && typeof m.drives === 'number');
        const flat = text.replace(/[*_~`]+/g, '');
        // MZ, any punctuation a model might use as the separator (including en/em
        // dashes and a colon), then the four hex digits, which may be spaced out.
        const reports = (code) => eqCode(fields?.extractionCode, code);
        // Grade a session that actually reached the pad, preferring one whose code
        // the agent reported: a curl probe or a re-minted cookie must not shadow
        // the real run.
        const finished = runs.filter((m) => m.reachedExit && m.code);
        const winner = finished.find((m) => reports(m.code)) ?? finished[0];
        const reported = !!winner && reports(winner.code);
        return {
          pass: !!winner && reported,
          detail:
            `sessions=${runs.length} finished=${finished.length} ` +
            `code=${winner?.code ?? 'none'} reported=${reported} ` +
            `drives=${winner?.drives ?? '-'} (optimal ${winner?.optimal ?? '-'}) ` +
            `refused=${winner?.blocked ?? '-'} surveyed=${winner?.surveyed?.length ?? '-'}`,
        };
      },
    },
    {
      id: 'floorplan-room',
      ask:
        `Open ${origins['cadre-workplace']}/ — the facilities console for Ostmark House, ` +
        `showing the Level 04 space plan. Using the plan, open the space record ` +
        `for the corner office in the north-east of the building and report who ` +
        `occupies it.`,
      answerSchema: {
        type: 'object',
        properties: {
          occupantName: { type: ['string', 'null'], description: 'who occupies the office' },
          roomCode: { type: ['string', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        const text = rawText.replace(/[*_~`]+/g, '');
        const want = ANSWERS.floorplan;
        const openedBy = (s) => (s.roomClicks ?? []).map((c) => c.id);
        // Server-observed gate: only a same-origin GET /api/floorplan/room
        // appends to session.roomClicks, and it 403s (recording nothing)
        // without the session cookie plus nonce, so neither a forged
        // /api/beacon nor an off-page shell probe can fake it.
        // Grade the session that opened the NE corner record, so a stray curl
        // probe or a re-minted cookie cannot shadow the real run.
        const sessions = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.roomClicks ?? []).length
        );
        const session = sessions.find((s) => openedBy(s).includes(want.room)) ?? sessions[0];
        const ids = session ? openedBy(session) : [];
        const opened = ids.includes(want.room);
        const name = String(fields?.occupantName ?? '');
        const roomCited = want.roomPattern.test(String(fields?.roomCode ?? ''));
        // The surname is unguessable, so it is always required; the first name
        // may be dropped or initialled when the room code pins the answer down.
        // The field is the claimed occupant, so asserting a decoy as the
        // answer is a wrong value and the per-clause machinery is gone.
        const named =
          want.surnamePattern.test(name) && (want.firstNamePattern.test(name) || roomCited);
        const decoyClaimed = [want.decoyNeOccupant, want.decoySeOccupant, want.vacated].filter(
          (n) => new RegExp(`\\b${n.split(' ').pop()}\\b`, 'i').test(name)
        );
        return {
          pass: opened && named && decoyClaimed.length === 0,
          detail:
            `sessions=${sessions.length} opened=[${ids.join(',')}] ne4=${opened} ` +
            `ne3=${ids.includes(want.decoyNeRoom)} named=${named} roomCited=${roomCited} ` +
            `decoyClaimed=[${decoyClaimed.join(', ')}] fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'scene-calibrate',
      ask:
        `Open ${origins.hearthline}/ — the Hearthline Hub home console. The Evening ` +
        `Wind-down scene is waiting for calibration: set the three scene dials to ` +
        `the calibration targets shown on the card, then apply the scene. Report ` +
        `the confirmation code the hub issues and the brightness (percent), color ` +
        `temperature (kelvin) and fade time (seconds) you applied.`,
      answerSchema: {
        type: 'object',
        properties: {
          confirmationCode: { type: ['string', 'null'] },
          brightness: { type: ['number', 'null'] },
          colorTemp: { type: ['number', 'null'] },
          fadeSeconds: { type: ['number', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        const sessions = [...ctx.pages.state.sessions.values()].filter((s) => s.smarthome);
        const withApplies = sessions.filter((s) => s.smarthome.applies.length > 0);
        // Grade the session whose server-issued code the answer carries, so a
        // stray curl probe cannot shadow the real run; fall back to any session
        // the hub issued a code to, then to any that tried.
        const carries = (s) =>
          !!s.smarthome.code && eqCode(fields?.confirmationCode, s.smarthome.code);
        const session =
          withApplies.find(carries) ??
          withApplies.find((s) => s.smarthome.code) ??
          withApplies[0];
        const sh = session?.smarthome;
        const t = sh?.targets;
        // The code is only minted for an apply that matched this session's own
        // minted targets, so the three reported values and the code stay bound
        // together: the code proves the server saw a matching triple, and the
        // reported triple must be that same session's mint.
        const codeOk = !!session && carries(session);
        const valuesOk =
          !!t &&
          Number(fields?.brightness) === t.brightness &&
          Number(fields?.colorTemp) === t.colorTemp &&
          Number(fields?.fadeSeconds) === t.fadeSeconds;
        const applies = sh?.applies ?? [];
        return {
          pass: codeOk && valuesOk,
          detail:
            `sessions=${withApplies.length}/${sessions.length} applies=${applies.length} ` +
            `misses=${applies.filter((a) => !a.matched).length} ` +
            `offPageApplies=${applies.filter((a) => !a.fromPage).length} ` +
            `targets=${JSON.stringify(t ?? null)} code=${sh?.code ?? 'never issued'} ` +
            `codeOk=${codeOk} valuesOk=${valuesOk} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'kanban-triage',
      ask:
        `Open ${origins.coppermast}/ — the Coppermast Dispatch shift triage board for ` +
        `Terminal 3. Move every work order tagged Urgent into the Done lane and every ` +
        `work order tagged Blocked into the Backlog lane; leave the Routine ones where ` +
        `they are. Then click Save board. Report the board revision the page shows once ` +
        `it has saved, and say whether you moved the cards by dragging them between ` +
        `lanes or by using the move buttons on each card.`,
      answerSchema: {
        type: 'object',
        properties: {
          boardRevision: { type: ['string', 'null'], description: 'the layout revision the board reported' },
        },
      },
      validate: (rawText, ctx, fields) => {
        const text = rawText.replace(/[*_~`]+/g, '');
        const LANES = ['backlog', 'doing', 'done'];
        // The board is minted per session, so a curl probe and the browser run
        // carry different tag assignments and different revisions. Grade the
        // session the report is actually about.
        const sessions = [...ctx.pages.state.sessions.values()].filter((s) => s.kanban);
        const placement = (layout) => {
          const where = new Map();
          for (const lane of LANES) for (const id of layout.columns[lane] ?? []) where.set(id, lane);
          return where;
        };
        const triaged = (s) => {
          const last = s.kanban.layouts.at(-1);
          if (!last) return false;
          const where = placement(last);
          return (
            s.kanban.urgent.every((id) => where.get(id) === 'done') &&
            s.kanban.blocked.every((id) => where.get(id) === 'backlog')
          );
        };
        // Any revision the server issued to that session counts: saving twice and
        // quoting the first one is still a report of a save that happened. The
        // separator is loose because "CM 8D5495" and "cm-8d5495" are the same id,
        // and the `CM` prefix is optional because "returned revision 8D5495" quotes
        // the minted value exactly, minus a constant the fixture chose.
        const quoted = (s) =>
          s.kanban.layouts.filter(
            (l) =>
              eqCode(fields?.boardRevision, l.revision) ||
              eqCode(`CM-${fields?.boardRevision ?? ''}`, l.revision)
          );
        const graded =
          sessions.find((s) => triaged(s) && quoted(s).length) ??
          sessions.find((s) => quoted(s).length) ??
          sessions.find(triaged) ??
          sessions.filter((s) => s.kanban.layouts.length).at(-1) ??
          sessions.at(-1) ??
          null;
        const kb = graded?.kanban ?? null;
        const last = kb?.layouts.at(-1) ?? null;
        const where = last ? placement(last) : new Map();
        const misplacedUrgent = (kb?.urgent ?? []).filter((id) => where.get(id) !== 'done');
        const misplacedBlocked = (kb?.blocked ?? []).filter((id) => where.get(id) !== 'backlog');
        // "Leave the Routine ones where they are" is graded against the dealt
        // columns frozen at mint (kb.startCols): a save that shuffles a routine
        // card fails even though every urgent/blocked card landed correctly.
        const taggedIds = new Set([...(kb?.urgent ?? []), ...(kb?.blocked ?? [])]);
        const routineOffStart = Object.entries(kb?.startCols ?? {})
          .filter(([id]) => !taggedIds.has(id))
          .filter(([id, col]) => where.size > 0 && where.get(id) !== col)
          .map(([id]) => id);
        const savedOk =
          !!last && !misplacedUrgent.length && !misplacedBlocked.length && !routineOffStart.length;
        const revisionOk = !!kb && quoted(graded).length > 0;
        // Route telemetry: which affordance actually produced the moves. The page
        // reports it, so it is diagnostic only and never part of the decision —
        // `drag_by_uid_to_uid` has no task anywhere else in the suite, and this is
        // the line that says whether an agent ever reaches for it.
        const vias = new Set((kb?.layouts ?? []).flatMap((l) => l.moves).map((m) => m.via));
        const route = !vias.size ? 'none' : vias.size > 1 ? 'mixed' : [...vias][0];
        const moved = new Set((kb?.layouts ?? []).flatMap((l) => l.moves).map((m) => m.card));
        const tagged = new Set([...(kb?.urgent ?? []), ...(kb?.blocked ?? [])]);
        const movedRoutine = [...moved].filter((id) => !tagged.has(id));
        const detail =
          `route=${route}; saves=${kb?.layouts.length ?? 0}; ` +
          `moves=${(kb?.layouts ?? []).flatMap((l) => l.moves).length}; ` +
          `layoutOk=${savedOk}; revisionQuoted=${revisionOk}; ` +
          `urgentOffTarget=${misplacedUrgent.join(',') || 'none'}; ` +
          `blockedOffTarget=${misplacedBlocked.join(',') || 'none'}; ` +
          `routineMoved=${movedRoutine.join(',') || 'none'}; ` +
          `boardReads=${kb?.reads ?? 0}; offPageReads=${kb?.offPageReads ?? 0}; ` +
          `sessions=${sessions.length}`;
        return { pass: savedOk && revisionOk, detail };
      },
    },
    {
      id: 'pr-review',
      ask:
        `Open ${origins.kettleforge}/pulls/482/ — pull request 482 in hollowmill/brine-gateway ` +
        `on Kettleforge. One job in its pipeline is failing. Work out which single ` +
        `changed line of the diff causes that failure, leave a single review comment ` +
        `on exactly that line in the Files changed view, name the at-fault identifier ` +
        `in that comment, and submit the review with the Request changes verdict. ` +
        `Then report the file, the new-side line number and the identifier.`,
      answerSchema: {
        type: 'object',
        properties: {
          file: { type: ['string', 'null'], description: 'the file the at-fault line is in' },
          lineNumber: { type: ['integer', 'null'], description: 'the new-side line number' },
          identifier: { type: ['string', 'null'], description: 'the single at-fault identifier' },
        },
      },
      validate: (rawText, ctx, fields) => {
        const idents = ANSWERS.prReview.identifiers;
        const looseRe = (key) => new RegExp(idents[key].loose, 'i');
        const strictRe = (key) => new RegExp(idents[key].match, 'i');
        // A line number in prose: leading zeros are fine and so is a comma or a
        // full stop right before it ("quote.js,35"), but a digit — or a separator
        // that is itself inside a number — is not, so 1336.5 never satisfies 13.
        const lineRe = (n) => new RegExp(`(?<!\\d)(?<!\\d[.,])0*${n}(?![\\d])`);
        const sessions = [...ctx.pages.state.sessions.values()].filter(
          (s) => s.forge?.defect && (s.forge.reviews ?? []).length > 0
        );
        // Every distinct line this session has ever commented on. Addressing one
        // line is the task; spraying comments over the candidate addresses until
        // one sticks is not, and the line numbers move per session precisely so
        // that a memorised address cannot stand in for reading the diff.
        const addressesOf = (s) =>
          new Set(
            (s.forge.reviews ?? []).flatMap((r) =>
              (r.comments ?? []).map((c) => `${c.file}:${c.line}`)
            )
          );
        // Reviews carrying exactly ONE line comment, sitting on the seeded line.
        const onLineReviews = (s) =>
          (s.forge.reviews ?? []).filter(
            (r) =>
              (r.comments ?? []).length === 1 &&
              r.comments[0].file === s.forge.defect.file &&
              r.comments[0].line === s.forge.defect.line
          );
        const names = (s, r) => looseRe(s.forge.defect.key).test(r.comments[0].body);
        // Grade the best such review rather than the last one submitted: a
        // clarifying comment-only review before or after the real one neither
        // rescues a botched run nor spoils a good one.
        const hitOf = (s) => {
          const rs = onLineReviews(s);
          return (
            rs.find((r) => r.verdict === 'changes' && names(s, r)) ??
            rs.find((r) => r.verdict === 'changes') ??
            rs.find((r) => names(s, r)) ??
            rs[0] ??
            null
          );
        };
        const qualifies = (s) => {
          const r = hitOf(s);
          return (
            !!r &&
            r.verdict === 'changes' &&
            names(s, r) &&
            addressesOf(s).size <= 2 &&
            s.forge.diffFetches > 0
          );
        };
        // Each session draws its own defect, so a Bash probe and the browser run
        // can be graded against different ground truths. Pick the session the
        // answer is actually about, and only fall back to recency.
        const describes = (s) =>
          looseRe(s.forge.defect.key).test(String(fields?.identifier ?? '')) &&
          fields?.lineNumber === s.forge.defect.line;
        const good = sessions.filter(qualifies);
        const withHit = sessions.filter((s) => hitOf(s));
        const graded =
          good.find(describes) ??
          good.at(-1) ??
          withHit.find(describes) ??
          withHit.at(-1) ??
          sessions.find(describes) ??
          sessions.at(-1) ??
          null;
        const defect = graded?.forge?.defect ?? null;
        const onLine = graded ? hitOf(graded) : null;
        const verdictOk = onLine?.verdict === 'changes';
        // The identifier has to be named in the comment that sits ON the at-fault
        // line, which is what the ask calls for.
        const namedInReview = !!onLine && names(graded, onLine);
        const oneSite = !!graded && addressesOf(graded).size <= 2;
        const readDiff = (graded?.forge?.diffFetches ?? 0) > 0;
        // One identifier field is a commitment: the spread-bet clause machinery
        // (alsoNamed) is unrepresentable, and ruling rivals out in prose costs
        // nothing. The identifier is compared loose (the enclosing function may
        // legitimately be quoted), the rival check strict on the field alone.
        const claimed = String(fields?.identifier ?? '');
        const namedInAnswer = !!defect && looseRe(defect.key).test(claimed);
        const alsoNamed = defect
          ? Object.keys(idents).filter((k) => k !== defect.key && strictRe(k).test(claimed))
          : [];
        const lineInAnswer = !!defect && fields?.lineNumber === defect.line;
        const fileInAnswer =
          !!defect &&
          normaliseWords(fields?.file ?? '').includes(
            normaliseWords(String(defect.file ?? '').split('/').pop() ?? '')
          );
        return {
          pass:
            !!onLine &&
            verdictOk &&
            namedInReview &&
            oneSite &&
            readDiff &&
            namedInAnswer &&
            alsoNamed.length === 0 &&
            lineInAnswer &&
            fileInAnswer,
          detail:
            `sessions=${sessions.length} ` +
            `defect=${defect ? `${defect.key}@${defect.file}:${defect.line}` : 'none'} ` +
            `reviews=${graded?.forge?.reviews?.length ?? 0} ` +
            `commentedOnLine=${!!onLine} hitVerdict=${onLine?.verdict ?? 'none'} ` +
            `addresses=${graded ? addressesOf(graded).size : 0} ` +
            `namedInReview=${namedInReview} namedInAnswer=${namedInAnswer} ` +
            `alsoNamed=${alsoNamed.join('+') || 'none'} lineInAnswer=${lineInAnswer} ` +
            `offPage=${graded?.forge?.offPage ?? 0} ` +
            `diffFetches=${graded?.forge?.diffFetches ?? 0} ` +
            `checkFetches=${graded?.forge?.checkFetches ?? 0}`,
        };
      },
    },
    {
      id: 'formula-repair',
      ask:
        `Open ${origins.abaca}/ — the Abaca workbook holding Marchmont Haulage's Q3 ` +
        `freight recovery. The workbook's quarter total does not agree with the ` +
        `freight ledger control total on the reconciliation panel. Exactly one cell ` +
        `has a wrong formula. Find it, correct the formula so the whole sheet ` +
        `reconciles, and report the cell reference you corrected and the ` +
        `reconciliation checksum the workbook then issues.`,
      answerSchema: {
        type: 'object',
        properties: {
          cellReference: { type: ['string', 'null'], description: 'the corrected cell, e.g. E14' },
          checksum: { type: ['string', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        // Markdown emphasis and typographic dashes must not break the checksum or
        // cell-reference regexes ("**E14**", "RC‑828D95").
        const text = rawText
          .replace(/[*_~`]+/g, '')
          .replace(/[‐-―−]/g, '-');
        const sheets = [...ctx.pages.state.sessions.values()].map((s) => s.calc).filter(Boolean);
        // The workbook prints the checksum as RC-XXXXXX; accept the bare hex, a
        // space instead of the hyphen, and any letter case, but never a prefix of
        // it and never a longer token that merely contains it.
        // The workbook prints RC-XXXXXX; the bare hex also counts, and the
        // cell may be quoted absolute ($E$14).
        const hasCode = (code) =>
          eqCode(fields?.checksum, code) || eqCode(`RC-${fields?.checksum ?? ''}`, code);
        const hasRef = (ref) =>
          eqCode(String(fields?.cellReference ?? '').replace(/\$/g, ''), ref);
        // Every session gets its own sheet, its own defect and its own checksum,
        // so grade the reconciled session this ANSWER is about — the one whose
        // checksum it quotes and whose defect cell it actually repaired —
        // whatever order the sessions were created in. Falling back to the most
        // recently reconciled sheet (then to whichever session did the most work)
        // keeps the detail line useful when nothing matches.
        const reconciled = sheets.filter((c) => c.reconciled);
        const owns = (c) =>
          !!c.checksum &&
          hasCode(c.checksum) &&
          c.edits.some((e) => e.accepted && e.ref === c.culprit.ref);
        const session =
          reconciled.find(owns) ??
          reconciled.slice().sort((a, b) => (b.reconciledAt ?? 0) - (a.reconciledAt ?? 0))[0] ??
          sheets.slice().sort((a, b) => b.edits.length - a.edits.length)[0] ??
          null;
        const culprit = session?.culprit?.ref ?? null;
        const checksum = session?.checksum ?? null;
        const edits = session?.edits ?? [];
        const accepted = edits.filter((e) => e.accepted);
        const fixedCulprit = accepted.some((e) => e.ref === culprit);
        const codeOk = !!checksum && hasCode(checksum);
        const refOk = !!culprit && hasRef(culprit);
        // The defect cell's formula has to have been readable before the commit
        // that repaired it, either by selecting that cell or through the ribbon's
        // Show formulas view. Both are honest solves, so both count; what this
        // excludes is a blind sweep that rewrites flagged cells having read none.
        // It does NOT prove the run located the culprit — `refOk` is what grades
        // that, by requiring the answer to name it — so `culpritRead` below
        // reports which route was taken rather than gating on it.
        const reads = session?.formulaReads ?? [];
        const repair = accepted.find((e) => e.ref === culprit) ?? null;
        const before = (r) => repair && r.at <= repair.at;
        const targeted = reads.some((r) => r.ref === culprit && before(r));
        const viaBulk = reads.some((r) => r.bulk && before(r));
        const inspected = targeted || viaBulk;
        const culpritRead = targeted ? 'targeted' : viaBulk ? 'bulk' : 'none';
        // Reported, never gated: whether the run blamed one of the seven correct
        // but oddly-spelled cells the formula audit also flags, how many formulas
        // it opened, and whether it took the one bulk Show formulas read.
        const namedDecoy = ANSWERS.calc.auditDecoys.filter((ref) => hasRef(ref));
        return {
          pass: session?.reconciled === true && fixedCulprit && inspected && codeOk && refOk,
          detail:
            `sessions=${sheets.length} culprit=${culprit ?? 'none'} ` +
            `reconciled=${session?.reconciled === true} fixedCulprit=${fixedCulprit} ` +
            `inspected=${inspected} culpritRead=${culpritRead} ` +
            `refOk=${refOk} codeOk=${codeOk} ` +
            `checksum=${checksum ?? 'none'} ` +
            `edits=${accepted.length}/${edits.length} ` +
            `formulaReads=${reads.length} bulk=${reads.filter((r) => r.bulk).length} ` +
            `offPageReads=${reads.filter((r) => r.fromPage === false).length} ` +
            `sheetFetches=${session?.sheetFetches ?? 0} ` +
            `namedDecoys=[${namedDecoy.join(',')}]`,
        };
      },
    },
  ];
}
