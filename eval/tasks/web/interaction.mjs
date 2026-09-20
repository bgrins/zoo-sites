// Rich interaction: puzzles, canvas, shadow DOM, spatial search, drag-and-drop, diffs, and formula grids.
//
// One family of the web suite. tasks/web.mjs concatenates every family; see
// docs/authoring-fixtures.md for the rules a task and its fixture must follow.

import { originUrls } from '../../../manifest.mjs';
import { ANSWERS } from '../../answers.mjs';
import { eqCode, eqEnum, eqPerson, normalise, normaliseWords, soleCode } from '../../extract.mjs';

// The earliest-won game whose guess count the answer reports, else the
// earliest-won game, else the first game; and how many guesses every session
// spent on the same puzzle up to and including that win. The budget is counted
// across sessions in time order, so a fresh cookie that farmed feedback before
// the win buys nothing, while a probe made after an honest win, even one that
// replays it to the same count, cannot spoil it.
function lexvaneGraded(games, reportsCount) {
  const winAt = (g) => g.guesses.at(-1)?.at ?? Infinity;
  const earliest = (list) => list.reduce((a, g) => (a && winAt(a) <= winAt(g) ? a : g), null);
  const won = games.filter((g) => g.won);
  const game = earliest(won.filter(reportsCount)) ?? earliest(won) ?? games[0] ?? null;
  const wonAt = game?.won ? winAt(game) : Infinity;
  const spent =
    (game?.guesses.length ?? 0) +
    games
      .filter((g) => g !== game)
      .reduce((n, g) => n + g.guesses.filter((p) => p.at < wonAt).length, 0);
  return { game, spent };
}

// A server-minted PREFIX-HEX code, quoted with or without its constant prefix.
const eqMinted = (got, want, prefix) =>
  eqCode(got, want) || (typeof got === 'string' && eqCode(`${prefix}${got}`, want));

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
        // sites/lexvane.mjs and every guess goes through /api/lexvane/guess, so
        // a solve has to be played. Grade the won game the answer's count
        // describes, so a stray curl probe cannot shadow the real run. The word
        // is an ordinary English adjective, so an unanchored regex over the
        // answer text with no server gate would pass "the autumn air was crisp".
        const games = [...ctx.pages.state.sessions.values()]
          .map((s) => s.lexvaneEasy?.[0])
          .filter(Boolean);
        const { game, spent } = lexvaneGraded(
          games,
          (g) => g.guesses.length === fields?.guessesUsed
        );
        const won = game?.won === true;
        const used = game?.guesses.length ?? 0;
        // The ask promises six guesses, and a fresh cookie gets six more on the
        // same fixed word. 6 = LEXVANE_EASY_TRIES.
        const withinBudget = spent <= 6;
        // won === true is the real gate; the word and count are graded as
        // fields because the ask asks for them.
        const wordOk = eqEnum(fields?.answerWord, ANSWERS.lexvane.day0Word);
        const countOk = used > 0 && fields?.guessesUsed === used;
        return {
          pass: won && wordOk && countOk && withinBudget,
          detail:
            `sessions=${games.length} won=${won} used=${used} spent=${spent} ` +
            `withinBudget=${withinBudget} wordOk=${wordOk} countOk=${countOk} ` +
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
        // Grade the won day-3 game the answer's count describes, so a stray
        // curl probe cannot shadow the real run. The server refuses
        // rule-breaking guesses outright, so every counted guess in a won game
        // obeyed hard mode. The count is either the counted guesses or
        // counted-plus-refused ("5 attempts, 2 refused"), where refused covers
        // both free refusals: a dropped hint and a non-word.
        const games = [...ctx.pages.state.sessions.values()]
          .map((s) => s.lexvaneHard?.[3])
          .filter(Boolean);
        const refusedIn = (g) => g.violations.length + (g.nonWords?.length ?? 0);
        const { game, spent: totalUsed } = lexvaneGraded(games, (g) =>
          [g.guesses.length, g.guesses.length + refusedIn(g)].includes(fields?.finalGuessNumber)
        );
        const won = game?.won === true;
        const used = game?.guesses.length ?? 0;
        const refused = game ? refusedIn(game) : 0;
        // The five-try cap is the whole point, so it is enforced across ALL
        // sessions: minting fresh cookies to farm feedback on the same word and
        // then winning in one guess spends more than five counted guesses. A
        // legitimate run reuses one cookie (a reload included), and a session
        // that never posts a guess adds nothing. 5 = LEXVANE_HARD_TRIES.
        const withinBudget = totalUsed <= 5;
        const wordOk = eqEnum(fields?.answerWord, ANSWERS.lexvane.hardDay3);
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
      id: 'hovercard-oncall',
      ask:
        `orchid-api is paging errors. Open ${origins.cindergrid}/services/orchid-api.html and ` +
        `page whoever is on call for it right now, with this message: ` +
        `"${ANSWERS.consoleOncall.message}" Report the page receipt and the name of the person you paged.`,
      answerSchema: {
        type: 'object',
        properties: {
          pageReceipt: {
            type: ['string', 'null'],
            description: 'the receipt the console showed for the page, e.g. PG-1A2B3C',
          },
          personName: {
            type: ['string', 'null'],
            description: 'the full name of the person the answer says was paged, name only',
          },
        },
      },
      validate: (text, ctx, fields) => {
        const want = ANSWERS.consoleOncall;
        const states = [...ctx.pages.state.sessions.values()].map((s) => s.cgOncall).filter(Boolean);
        // Every page wakes a real person whichever cookie sent it, so pages are
        // counted across all sessions and exactly one may exist. The graded page
        // is the one whose minted receipt the answer cites, and it must have gone
        // to the on-call handle its session holds, with the dictated message;
        // the name is graded against that same record. The server draws who is
        // on call once per task, so every session holds the same one. The paged
        // person's card must also have been sent to some session before the
        // page, since only the card says who is on call: a page to a rotation
        // member picked blind lands on the right one a quarter of the time.
        const pages = states.flatMap((st) => st.pages.map((p) => ({ p, st })));
        const receipt = soleCode(fields?.pageReceipt, /PG-[0-9A-F]{6}/);
        const cited = pages.find(({ p }) => eqCode(receipt, p.receipt)) ?? null;
        const { p: page, st } = cited ?? pages[0] ?? {};
        const toOnCall = !!page && page.handle === st.onCall;
        const seenAt = page ? Math.min(...states.map((s) => s.cardAt?.[page.handle] ?? Infinity)) : Infinity;
        const seen = !!page && seenAt < page.at;
        // The ask sets the message in quotes, so one surrounding pair of quotes
        // and the closing period are not content; anything shorter or longer is.
        const bare = (s) =>
          normalise(s)
            .replace(/\.$/, '')
            .replace(/^(["'])(.*)\1$/, '$2')
            .replace(/\.$/, '');
        const messageOk = !!page && bare(page.message) === bare(want.message);
        const nameOk = !!st && eqPerson(fields?.personName, st.onCallName);
        const onePage = pages.length === 1;
        // Telemetry only: the cards the server released per handle (its view of
        // the hovers), where they were fetched from, and the profile pages loaded.
        const counts = (key) => {
          const sum = {};
          for (const s of states) for (const [h, n] of Object.entries(s[key])) sum[h] = (sum[h] ?? 0) + n;
          return Object.entries(sum).map(([h, n]) => `${h}:${n}`).join(',') || 'none';
        };
        const from = states.reduce(
          (acc, s) => ({ card: acc.card + s.cardFrom.card, profile: acc.profile + s.cardFrom.profile, other: acc.other + s.cardFrom.other }),
          { card: 0, profile: 0, other: 0 }
        );
        return {
          pass: !!cited && toOnCall && seen && messageOk && onePage && nameOk,
          detail:
            `sessions=${states.length} pages=${pages.length} onCall=${st?.onCall ?? 'none'} ` +
            `paged=${page ? `${page.handle}:${page.via || 'none'}${page.fromPage ? '' : ':offpage'}` : 'none'} ` +
            `cards=${counts('cardGets')} cardFrom=card:${from.card},profile:${from.profile},other:${from.other} ` +
            `profiles=${counts('profileLoads')} ` +
            `receiptOk=${!!cited} toOnCall=${toOnCall} ` +
            `cardSeen=${seen ? `${Math.round((page.at - seenAt) / 1000)}s-before` : 'no'} ` +
            `messageOk=${messageOk} onePage=${onePage} ` +
            `nameOk=${nameOk} fields=${JSON.stringify(fields)}`,
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
        // Case, whitespace and the separator's dash style (hyphen, en or em
        // dash, or none) do not matter; any other character does.
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
      id: 'range-select',
      ask:
        `In Boxelder's Scans folder (${origins.boxelder}/scans.html), apply the ` +
        `'Retain 7 years' label to exactly the files of intake batch 26-14, and to ` +
        `no other file. Leave every other file's label as it is, and report the label receipt.`,
      answerSchema: {
        type: 'object',
        properties: {
          receipt: {
            type: ['string', 'null'],
            description:
              'the label receipt the workspace issued, e.g. LB-1A2B3C; every receipt the answer ' +
              'names, when it names more than one',
          },
        },
      },
      validate: (text, ctx, fields) => {
        const want = ANSWERS.filemgrScans;
        const runs = [...ctx.pages.state.sessions.values()]
          .map((s) => s.scans)
          .filter((sc) => sc && Array.isArray(sc.jobs) && Array.isArray(sc.targetIds));
        // The receipts the answer names, with or without the prefix, and with
        // whatever notes it adds ("LB-1A2B3C (Retain 7 years, 25 files)"). A run
        // that labelled the batch in more than one job may name each receipt
        // ("LB-1A2B3C and 4D5E6F"); an "or" between them, or a negation, is a
        // hedge and grades as written. A bare body counts only with a digit in
        // it and never after a dash, so neither a word such as "decade" nor the
        // number in a file name such as SC-004787 reads as a receipt.
        const sole = soleCode(fields?.receipt, /LB-[0-9A-F]{6}/);
        const listed =
          typeof sole === 'string' && !/\b(?:or|not|never)\b|n't\b/i.test(sole)
            ? sole.match(
                /(?<![A-Za-z0-9])LB[\s\u2010-\u2015-]*[0-9A-F]{6}(?![A-Za-z0-9])|(?<![A-Za-z0-9\u2010-\u2015-])(?=[A-F]*[0-9])[0-9A-F]{6}(?![A-Za-z0-9])/gi
              ) ?? []
            : [];
        const claims = listed.length ? listed : [sole];
        const labelJob = (j) => j.action === 'apply' && j.label === want.label;
        const cites = (j) => labelJob(j) && claims.some((claim) => eqMinted(claim, j.receipt, 'LB-'));
        // Grade the session whose label receipt the answer quotes, so a probe
        // or a re-minted cookie cannot shadow the run; failing that, a session
        // that labelled anything, so a wrong run still shows its own state.
        const graded =
          runs.find((sc) => sc.jobs.some(cites)) ??
          runs.find((sc) => sc.jobs.some(labelJob)) ??
          runs.find((sc) => sc.jobs.length) ??
          runs[0] ??
          null;
        const cited = graded?.jobs.find(cites) ?? null;
        // One receipt named has to be a label receipt of the graded session.
        // The others may be any job of that session, named while narrating a
        // correction; a receipt the session never issued fails the answer.
        const issued = (claim) => graded.jobs.some((j) => eqMinted(claim, j.receipt, 'LB-'));
        const citedAll = !!cited && claims.every(issued);
        // Each session's labels replayed from the ones its folder opened with
        // through its job log: a later label replaces an earlier one and a
        // removal clears it. `changes` lists every file a job actually moved.
        const replay = (sc) => {
          const label = new Map(Object.entries(sc.seeded ?? {}));
          const changes = [];
          for (const j of sc.jobs) {
            for (const id of j.ids ?? []) {
              const next = j.action === 'remove' ? null : j.label;
              if ((label.get(id) ?? null) !== next) changes.push({ sc, j, id });
              label.set(id, next);
            }
          }
          return { label, changes };
        };
        const replays = new Map(runs.map((sc) => [sc, replay(sc)]));
        const finalLabel = graded ? replays.get(graded).label : new Map();
        const target = new Set(graded?.targetIds ?? []);
        const missing = [...target].filter((id) => finalLabel.get(id) !== want.label);
        const extra = [...finalLabel].filter(([id, l]) => l === want.label && !target.has(id));
        const setOk = target.size > 0 && missing.length === 0 && extra.length === 0;
        // "And to no other file" and "leave every other file's label as it is"
        // bind every job, not only the final state: a label applied past the
        // batch and removed again changed that file twice. Each session's jobs
        // are held to that session's own batch, across all sessions, so a fresh
        // cookie buys nothing. A job that left a file's label as it was, such as
        // a label it already had, changed nothing.
        const strays = runs.flatMap((sc) => {
          const own = new Set(sc.targetIds);
          return replays.get(sc).changes.filter(({ id }) => !own.has(id));
        });
        const overshootOk = strays.length === 0;
        // Telemetry, never graded: the rows the batch spans, since a snapshot
        // that prints the Batch column can stop short of them; whether an
        // overshoot reached the near-miss neighbours (a range one row long) or
        // covered a whole folder (select all); and each job's page-reported
        // gestures and menu route.
        const order = (graded?.files ?? []).map((f) => f.id);
        const [from, to] = [order.indexOf(graded?.targetIds[0]), order.indexOf(graded?.targetIds.at(-1))];
        const span =
          from < 0 || to < 0
            ? 'none'
            : `rows=${from + 1}-${to + 1}/${order.length} ${graded.files[from].name}..${graded.files[to].name}`;
        const near = new Set(graded?.neighbourIds ?? []);
        const nearTouched = strays.filter((s) => s.sc === graded && near.has(s.id)).length;
        const selectAll = runs.some((sc) => sc.jobs.some((j) => (j.ids ?? []).length === sc.files?.length));
        const gestures = (g) =>
          Object.entries(g ?? {})
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${k}${n}`)
            .join('+') || 'none';
        const jobs = (graded?.jobs ?? []).map(
          (j) =>
            `${j.receipt}:${j.action}:${j.label ?? '-'}:${(j.action === 'remove' ? j.cleared : j.ids)?.length ?? 0}` +
            `:${j.via?.menu ?? '-'}:${gestures(j.via?.gestures)}${j.fromPage ? '' : ':offpage'}`
        );
        return {
          pass: citedAll && setOk && overshootOk,
          detail:
            `sessions=${runs.length} batch=${want.batch} target=${target.size} ${span} ` +
            `cited=${cited?.receipt ?? 'none'} citedAll=${citedAll} missing=${missing.length} extra=${extra.length} ` +
            `strays=${strays.length} (sessions ${new Set(strays.map((s) => s.sc)).size}, ` +
            `nearMiss=${nearTouched}, selectAll=${selectAll}) ` +
            `jobs=[${jobs.join(' ') || 'none'}] reads=${graded?.reads ?? 0} refused=${graded?.refused ?? 0} ` +
            `setOk=${setOk} overshootOk=${overshootOk} fields=${JSON.stringify(fields)}`,
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
        const want = ANSWERS.floorplan;
        const openedBy = (s) => (s.roomClicks ?? []).map((c) => c.id);
        // Server-observed gate: only a GET /api/floorplan/room carrying the
        // session cookie plus nonce AND a page provenance header appends to
        // session.roomClicks, so a forged /api/beacon cannot fake it and a plain
        // shell probe does not count. The header is legibility, never proof:
        // curl sets Referer and sec-fetch-site freely.
        // Grade the session that opened the NE corner record, so a stray curl
        // probe or a re-minted cookie cannot shadow the real run.
        const sessions = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.roomClicks ?? []).length
        );
        const session = sessions.find((s) => openedBy(s).includes(want.room)) ?? sessions[0];
        const ids = session ? openedBy(session) : [];
        const opened = ids.includes(want.room);
        const name = String(fields?.occupantName ?? '');
        // Dashes are folded first, because a model may write NE‑4 with a
        // non-breaking hyphen.
        const roomCode = normalise(fields?.roomCode ?? '');
        const roomCited = want.roomPattern.test(roomCode);
        // A code naming some other room of the plan contradicts the claim.
        const otherRoom = !roomCited && /\b(?:ne|nw|se|sw)[\s-]?\d\b/.test(roomCode);
        // The surname is unguessable, so it is always required; the first name
        // may be dropped or initialled when the room code pins the answer down.
        // The field is the claimed occupant, so asserting a decoy as the
        // answer is a wrong value and the per-clause machinery is gone.
        const named =
          want.surnamePattern.test(name) && (want.firstNamePattern.test(name) || roomCited);
        const decoyClaimed = [want.decoyNeOccupant, want.decoySeOccupant, want.vacated].filter(
          (n) => new RegExp(`\\b${n.split(' ').pop()}\\b`, 'i').test(name)
        );
        // Telemetry, never a gate: record reads that carried no page
        // provenance, across every session, so a shell route stays legible.
        const offPageReads = [...ctx.pages.state.sessions.values()].reduce(
          (n, s) => n + (s.roomReadsOffPage ?? 0),
          0
        );
        return {
          pass: opened && named && !otherRoom && decoyClaimed.length === 0,
          detail:
            `sessions=${sessions.length} opened=[${ids.join(',')}] ne4=${opened} ` +
            `ne3=${ids.includes(want.decoyNeRoom)} named=${named} roomCited=${roomCited} ` +
            `otherRoom=${otherRoom} offPageReads=${offPageReads} ` +
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
        `it has saved.`,
      answerSchema: {
        type: 'object',
        properties: {
          boardRevision: { type: ['string', 'null'], description: 'the layout revision the board reported' },
        },
      },
      validate: (rawText, ctx, fields) => {
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
        // "Leave the Routine ones where they are" is graded against the dealt
        // columns frozen at mint (kb.startCols): a save that shuffles a routine
        // card fails even though every urgent/blocked card landed correctly.
        const offTarget = (kb, layout) => {
          const where = layout ? placement(layout) : new Map();
          const tagged = new Set([...kb.urgent, ...kb.blocked]);
          return {
            urgent: kb.urgent.filter((id) => where.get(id) !== 'done'),
            blocked: kb.blocked.filter((id) => where.get(id) !== 'backlog'),
            routine: Object.entries(kb.startCols ?? {})
              .filter(([id, col]) => !tagged.has(id) && where.size > 0 && where.get(id) !== col)
              .map(([id]) => id),
          };
        };
        const layoutOk = (kb, layout) => {
          if (!layout) return false;
          const off = offTarget(kb, layout);
          return !off.urgent.length && !off.blocked.length && !off.routine.length;
        };
        // The separator is loose because "CM 8D5495" and "cm-8d5495" are the
        // same id, and the `CM` prefix is optional because "returned revision
        // 8D5495" quotes the minted value exactly, minus a constant the fixture
        // chose. soleCode takes the id out of "Board revision CM-8D5495", and
        // its shape takes the bare body too, so "CM-8D5495 or FACADE" is a hedge.
        const claimed = soleCode(fields?.boardRevision, /(?:CM-)?[0-9A-F]{6}/);
        const quotedOf = (s) =>
          s.kanban.layouts.find((l) => eqMinted(claimed, l.revision, 'CM-')) ?? null;
        // The quoted revision has to be one the server issued for a triaged
        // board, and the last save has to be triaged too. Saving twice and
        // quoting the first correct save is still a report of that save; quoting
        // the revision of the dealt board saved before triage is not, and a
        // correct save followed by a bad one leaves the board wrong.
        const complete = (s) =>
          layoutOk(s.kanban, quotedOf(s)) && layoutOk(s.kanban, s.kanban.layouts.at(-1));
        const graded =
          sessions.find(complete) ??
          sessions.find(quotedOf) ??
          sessions.find((s) => layoutOk(s.kanban, s.kanban.layouts.at(-1))) ??
          sessions.filter((s) => s.kanban.layouts.length).at(-1) ??
          sessions.at(-1) ??
          null;
        const kb = graded?.kanban ?? null;
        const last = kb?.layouts.at(-1) ?? null;
        const quoted = graded ? quotedOf(graded) : null;
        const off = kb ? offTarget(kb, last) : { urgent: [], blocked: [], routine: [] };
        const savedOk = !!kb && layoutOk(kb, last);
        const revisionOk = !!quoted;
        const quotedOk = !!kb && layoutOk(kb, quoted);
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
          `layoutOk=${savedOk}; revisionQuoted=${revisionOk}; quotedLayoutOk=${quotedOk}; ` +
          `quotedSave=${quoted ? kb.layouts.indexOf(quoted) + 1 : 'none'}; ` +
          `urgentOffTarget=${off.urgent.join(',') || 'none'}; ` +
          `blockedOffTarget=${off.blocked.join(',') || 'none'}; ` +
          `routineOffStart=${off.routine.join(',') || 'none'}; ` +
          `routineMoved=${movedRoutine.join(',') || 'none'}; ` +
          `boardReads=${kb?.reads ?? 0}; offPageReads=${kb?.offPageReads ?? 0}; ` +
          `sessions=${sessions.length}`;
        return { pass: savedOk && revisionOk && quotedOk, detail };
      },
    },
    {
      id: 'pointer-drag',
      ask:
        `Open ${origins['skerrow-radio']}/desk/. Put the 18:00 bulletin's running order into ` +
        `the order the editor's note gives, lock it, and report the lock reference.`,
      answerSchema: {
        type: 'object',
        properties: {
          lockReference: {
            type: ['string', 'null'],
            description: 'the lock reference the desk issued for the 18:00 running order, e.g. RO-1A2B3C',
          },
        },
      },
      validate: (rawText, ctx, fields) => {
        const A = ANSWERS.mediaDesk;
        const sessions = [...ctx.pages.state.sessions.values()].filter((s) => s.mediaDesk);
        // The page labels everything by clock time (the 18:00 bulletin, 4:30
        // slot, locked at 17:58), so a time beside the reference, written
        // 18:00, 18.00, 18:00:00, 6pm or 6 p.m., is no second code. A lone
        // time is stripped only whole, never out of a code: the hex body holds
        // no m, so a 12-hour marker never ends inside one.
        const reference = fields?.lockReference;
        const claimed = soleCode(
          typeof reference === 'string'
            ? reference.replace(
                /(?<![\w:.])\d{1,2}(?:(?:[:.]\d{2}){1,2}(?:\s*[ap]\.?\s?m\b\.?)?|\s*[ap]\.?\s?m\b\.?)(?![\w:]|\.\d)/gi,
                ' '
              )
            : reference,
          /(?:RO-)?[0-9A-F]{6}/
        );
        const said = (code) => eqMinted(claimed, code, A.referencePrefix);
        const locked = sessions.filter((s) => s.mediaDesk.lock);
        // "Lock it" is one act for the whole run. Each session locks at most
        // once, so a lock in any second session, before the graded one or
        // after it, fails the run: a fresh cookie buys a fresh shuffle, never
        // a second try at the 18:00 order.
        const soleLock = locked.length === 1;
        const graded = locked.find((s) => said(s.mediaDesk.lock.reference)) ?? null;
        const desk = (graded ?? locked[0] ?? sessions.at(-1))?.mediaDesk ?? null;
        const lock = desk?.lock ?? null;
        const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
        // The order the server had built when the lock froze it, against the
        // editor's order dealt to that same session.
        const orderOk = !!graded && same(graded.mediaDesk.lock.order, graded.mediaDesk.target);
        // Everything below is telemetry for the detail line. `via` and
        // `trusted` are what page script reported about each gesture, so they
        // name the route (pointer, keyboard, menu) without proving it. A move
        // that arrived without browser fetch metadata or a desk Referer counts
        // as route 'offpage' and never toward a via. curl can send both, so
        // 'offpage' catches only a shell that did not bother.
        const misplaced = lock ? lock.order.filter((id, i) => id !== desk.target[i]).length : null;
        const lockedDealt = !!lock && same(lock.order, desk.dealt);
        const moves = desk?.moves ?? [];
        const pageMoves = moves.filter((m) => m.fromPage);
        const offPageMoves = moves.length - pageMoves.length;
        const count = (via) => pageMoves.filter((m) => m.via === via).length;
        const vias = new Set(pageMoves.map((m) => m.via));
        if (offPageMoves) vias.add('offpage');
        const route = !vias.size ? 'none' : vias.size > 1 ? 'mixed' : [...vias][0];
        // A dragstart and a drop the page cancelled, within a second of each
        // other and with no pointer move in the half second after them: a drag
        // that reported success and never reached the pointer sensor, which is
        // what drag_by_uid_to_uid does to this list. The page reports the two
        // events in one tick, so they can arrive in either order, and a burst
        // takes at most one of each: a quick second drag is a second no-op.
        const gestures = desk?.gestures ?? [];
        const bursts = [];
        for (const g of gestures) {
          const last = bursts.at(-1);
          if (last && !last.types.has(g.type) && g.at - last.start <= 1000) {
            last.end = g.at;
            last.types.add(g.type);
          } else bursts.push({ start: g.at, end: g.at, types: new Set([g.type]) });
        }
        const noOps = bursts.filter(
          (b) =>
            b.types.size === 2 &&
            !pageMoves.some((m) => m.via === 'pointer' && m.at >= b.start && m.at <= b.end + 500)
        ).length;
        const decoyClaimed = sessions
          .flatMap((s) => s.mediaDesk.earlier)
          .filter((e) => said(e.reference))
          .map((e) => e.bulletin);
        const detail =
          `sessions=${sessions.length} locks=${locked.length} referenceQuoted=${!!graded} ` +
          `orderOk=${orderOk} misplacedAtLock=${misplaced ?? 'no lock'} lockedDealtOrder=${lockedDealt} ` +
          `route=${route} moves=${moves.length} (pointer=${count('pointer')} keyboard=${count('keyboard')} ` +
          `menu=${count('menu')} other=${count('other')} untrusted=${pageMoves.filter((m) => !m.trusted).length} ` +
          `offPageMoves=${offPageMoves}) ` +
          `fewestMoves=${desk?.fewestMoves ?? 'n/a'} dragstartDrop=${gestures.filter((g) => g.type === 'dragstart').length}/` +
          `${gestures.filter((g) => g.type === 'drop').length} ` +
          `dragNoOps=${noOps} refused=${desk?.refused ?? 0} ` +
          `reads=${desk?.reads ?? 0} offPage=${desk?.offPage ?? 0} ` +
          `decoyClaimed=${decoyClaimed.join('/') || 'none'} fields=${JSON.stringify(fields)}`;
        return { pass: !!graded && orderOk && soleLock, detail };
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
        // answer is actually about, and only fall back to recency. A described
        // session that falls short is graded on what it lacks, rather than a
        // qualifying session it does not describe on the line it misses.
        const describes = (s) =>
          looseRe(s.forge.defect.key).test(String(fields?.identifier ?? '')) &&
          fields?.lineNumber === s.forge.defect.line;
        const good = sessions.filter(qualifies);
        const withHit = sessions.filter((s) => hitOf(s));
        const graded =
          good.find(describes) ??
          withHit.find(describes) ??
          sessions.find(describes) ??
          good.at(-1) ??
          withHit.at(-1) ??
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
            `fileInAnswer=${fileInAnswer} ` +
            `offPage=${graded?.forge?.offPage ?? 0} ` +
            `diffFetches=${graded?.forge?.diffFetches ?? 0} ` +
            `checkFetches=${graded?.forge?.checkFetches ?? 0} fields=${JSON.stringify(fields)}`,
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
        const sheets = [...ctx.pages.state.sessions.values()].map((s) => s.calc).filter(Boolean);
        // The workbook prints the checksum as RC-XXXXXX; accept the bare hex, a
        // space instead of the hyphen, and any letter case, but never a prefix of
        // it and never a longer token that merely contains it. soleCode takes it
        // out of "Reconciliation checksum RC-1A2B3C", and its shape takes the
        // bare hex too, so "RC-1A2B3C or FEDCBA" is a hedge.
        const claimed = soleCode(fields?.checksum, /(?:RC-)?[0-9A-F]{6}/);
        const hasCode = (code) => eqMinted(claimed, code, 'RC-');
        // The cell may be quoted absolute ($E$14), behind a sheet name
        // ('Q3 Recovery'!E14, Sheet1!E14) or in a phrase ("cell E14."), but it
        // has to name exactly one cell of the sheet's A-E columns: "E14 or C14"
        // commits to nothing.
        const refField = String(fields?.cellReference ?? '')
          .replace(/^.*!/, '')
          .replace(/\$/g, '');
        const refTokens = new Set(
          [...refField.toUpperCase().matchAll(/\b([A-E]\d{1,2})\b/g)].map((m) => m[1])
        );
        const hasRef = (ref) =>
          eqCode(refField, ref) || (refTokens.size === 1 && refTokens.has(ref));
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
        // The repair is the last accepted culprit edit up to the moment the
        // sheet first reconciled, not the first: a wrong but accepted attempt,
        // then a read, then the fix is an honest solve.
        const repair =
          accepted.filter((e) => e.ref === culprit && e.at <= (session?.reconciledAt ?? -1)).at(-1) ??
          null;
        const before = (r) => repair && r.at <= repair.at;
        const targeted = reads.some((r) => r.ref === culprit && before(r));
        const viaBulk = reads.some((r) => r.bulk && before(r));
        const inspected = targeted || viaBulk;
        const culpritRead = targeted ? 'targeted' : viaBulk ? 'bulk' : 'none';
        // `reconciled` latches when the sheet first agrees; the sheet has to
        // still agree now, or a run that repaired the cell and then broke it
        // again reports a checksum the workbook no longer shows.
        const reconciledNow = session?.reconciledNow === true;
        // Reported, never gated: whether the run blamed one of the seven correct
        // but oddly-spelled cells the formula audit also flags, how many formulas
        // it opened, whether it took the one bulk Show formulas read, and how
        // many correct flagged cells it rewrote before the repair (a
        // rewrite-every-flag sweep; the ask does not forbid editing them).
        const namedDecoy = ANSWERS.calc.auditDecoys.filter((ref) => hasRef(ref));
        const decoysRewritten = new Set(
          accepted
            .filter((e) => repair && e.at <= repair.at && ANSWERS.calc.auditDecoys.includes(e.ref))
            .map((e) => e.ref)
        ).size;
        return {
          pass:
            session?.reconciled === true &&
            reconciledNow &&
            fixedCulprit &&
            inspected &&
            codeOk &&
            refOk,
          detail:
            `sessions=${sheets.length} culprit=${culprit ?? 'none'} ` +
            `reconciled=${session?.reconciled === true} reconciledNow=${reconciledNow} ` +
            `fixedCulprit=${fixedCulprit} decoysRewritten=${decoysRewritten} ` +
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
