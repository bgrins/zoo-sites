// Extraction at scale: paginated tables, virtualized lists, joins across pages, charts, and canvas-rendered text.
//
// One family of the web suite. tasks/web.mjs concatenates every family; see
// docs/authoring-fixtures.md for the rules a task and its fixture must follow.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { originUrls } from '../../../manifest.mjs';
import { ANSWERS } from '../../answers.mjs';
import { eqCode, eqEnum, eqMoney, eqName, eqPerson, normalise, normaliseWords, soleCode } from '../../extract.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export async function extractionTasks(base, origins = originUrls(base)) {
  const newsItems = JSON.parse(
    await readFile(join(here, 'pages', 'news', 'items.json'), 'utf8')
  );
  return [
    {
      id: 'ledger-sum',
      truth: { kind: 'static', reason: 'published ledger; its server reads are route telemetry only' },
      ask:
        `Open ${origins.trelowen}/ — a 7-page transaction ledger. Sum the 'amount' ` +
        `column for every transaction tagged 'hardware' across all pages. ` +
        `Report the exact total in dollars and cents.`,
      answerSchema: {
        type: 'object',
        properties: {
          hardwareTotal: {
            type: ['number', 'null'],
            description: 'the exact total in dollars and cents',
          },
        },
      },
      validate: (rawText, ctx, fields) => {
        const total = eqMoney(fields?.hardwareTotal, ANSWERS.ledger.hardwareTotal);
        // Route telemetry, never a gate. Folio 1 ships an Export CSV button
        // whose hint advertises whole-ledger scope and the default snapshot of
        // /ledger/ carries no table rows, so summing the export in 4 calls is a
        // legitimate solve — it just has to be LEGIBLE, or a token comparison on
        // this task cannot be read as evidence about table handling. Only rows
        // reported route=table support that reading. The folio beacon is
        // page-load telemetry and forgeable like any beacon, which is exactly
        // why it decides nothing.
        const sessions = [...ctx.pages.state.sessions.values()];
        const exports = sessions.reduce((n, s) => n + (s.ledgerExports ?? 0), 0);
        const csvHits = sessions.reduce((n, s) => n + (s.ledgerCsvHits ?? 0), 0);
        const folios = new Set(
          ctx.pages.state.beaconsOf('ledger-folio').map((b) => b.data?.page)
        );
        // Folio markup the server actually served, whether the agent navigated
        // to it or pulled it with a scripted fetch. The beacon alone cannot tell
        // those apart: a scripted fetch runs no page script, so seven folios read
        // by script fire ONE beacon and score route=unknown. Rendered vs fetched
        // is the distinction that makes a token comparison on this task readable.
        const folioGets = new Set();
        for (const s of sessions) {
          for (const path of Object.keys(s.htmlGets ?? {})) {
            if (/^\/ledger\/(index|page-[2-7])\.html$/.test(path)) folioGets.add(path);
          }
        }
        const route =
          csvHits > 0
            ? 'csv'
            : folioGets.size >= 4
              ? folios.size >= 4
                ? 'table-rendered'
                : 'table-scripted'
              : 'unknown';
        return {
          pass: total,
          detail:
            `hardwareTotal=${total} route=${route} ` +
            `folioGets=${folioGets.size}/7 folioBeacons=${folios.size}/7 ` +
            `exports=${exports} csvHits=${csvHits} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'ledger-csv',
      ask:
        `Open ${origins.trelowen}/ and use its Export CSV feature. From the exported ` +
        `CSV, report the number of data rows and the largest single transaction ` +
        `amount.`,
      answerSchema: {
        type: 'object',
        properties: {
          dataRows: { type: ['integer', 'null'], description: 'number of data rows in the CSV' },
          largestAmount: { type: ['number', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        // Grade the per-session counters the export and CSV endpoints
        // maintain, NOT the beacons: /api/beacon accepts an arbitrary kind,
        // so beacon rows are forgeable with nothing but the page nonce.
        // Pick the session that completed BOTH halves so a curl probe or a
        // re-minted cookie cannot shadow the real run.
        const sessions = [...ctx.pages.state.sessions.values()];
        const both = sessions.filter(
          (s) => (s.ledgerExports ?? 0) > 0 && (s.ledgerCsvHits ?? 0) > 0
        );
        const winner = both[0] ?? sessions.find((s) => (s.ledgerExports ?? 0) > 0);
        const exported = (winner?.ledgerExports ?? 0) > 0;
        const fetched = (winner?.ledgerCsvHits ?? 0) > 0;
        // Both figures graded as bound fields: an unbound check passes a wrong
        // largest amount named in a context list, and a row count satisfied by
        // the header-inclusive line count.
        const rows = fields?.dataRows === ANSWERS.ledger.rowCount;
        const max = eqMoney(fields?.largestAmount, ANSWERS.ledger.maxAmount);
        return {
          pass: exported && fetched && rows && max,
          detail:
            `sessions=${sessions.length} completed=${both.length} ` +
            `exported=${exported} csvFetched=${fetched} ` +
            `rows=${rows} max=${max} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'crm-join',
      truth: { kind: 'static', reason: 'the orders and the directory are published page content' },
      ask:
        `Open ${origins.kelsmere}/ — a small CRM with an orders list and a customer ` +
        `directory. Every order names the account id it belongs to, and every ` +
        `account belongs to exactly one sales region. Across all 40 orders, ` +
        `which region generated the highest total order value? Report the ` +
        `region name and that region's total order value in dollars.`,
      answerSchema: {
        type: 'object',
        properties: {
          region: {
            type: ['string', 'null'],
            enum: ['Tidereach', 'Callowfen', 'Norhaven', 'Westmarch', null],
          },
          totalOrderValue: { type: ['number', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        // Answer-text only (via extracted fields): nothing about this task is
        // server-observable. The field is the claim, so the clause-scoping a
        // prose grader needs — to keep a rival named as winner with the right
        // figure in a table from passing — is unrepresentable here.
        const truth = Number(ANSWERS.crm.topRegionTotal.replace(/,/g, ''));
        const regionOk = eqEnum(fields?.region, ANSWERS.crm.topRegion);
        // A 0.5% relative window: dollar-rounded and thousand-rounded answers
        // count; the runner-up total is 19.8% away.
        const totalOk = eqMoney(fields?.totalOrderValue, truth, truth * 0.005);
        return {
          pass: regionOk && totalOk,
          detail: `regionOk=${regionOk} totalOk=${totalOk} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'roster-diff',
      truth: { kind: 'static', reason: 'both rosters are published page content' },
      ask:
        `Open ${origins.ferncliff}/ — an institute that publishes a staff roster for ` +
        `each programme year. Compare the 2025 roster with the 2026 roster and ` +
        `report every person who was ADDED, every person who was REMOVED, and ` +
        `every person whose title changed between the two years, saying which of ` +
        `those three categories each person falls in and giving the new title for ` +
        `any title change. List only the people who fall into one of the three ` +
        `categories — do not list staff whose roster entry is unchanged.`,
      answerSchema: {
        type: 'object',
        properties: {
          added: {
            type: 'array',
            items: { type: ['string', 'null'], description: "the person's name only, no title" },
          },
          removed: {
            type: 'array',
            items: { type: ['string', 'null'], description: "the person's name only, no title" },
          },
          titleChanged: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: ['string', 'null'], description: "the person's name only" },
                newTitle: { type: ['string', 'null'], description: 'their new job title' },
              },
            },
          },
        },
      },
      validate: (text, ctx, fields) => {
        const A = ANSWERS.rosters;
        // Exact set equality per category: swapped added/removed buckets, a
        // decoy or unchanged person listed as changed, and a missing person
        // all fail structurally.
        const setEq = (got, want) =>
          Array.isArray(got) &&
          got.length === want.length &&
          want.every((w) => got.some((g) => eqPerson(g, w)));
        const addedOk = setEq(fields?.added, A.added);
        const removedOk = setEq(fields?.removed, A.removed);
        const tc = Array.isArray(fields?.titleChanged) ? fields.titleChanged : [];
        // The new title must be stated FOR Dana Quill, and for her alone: the
        // unchanged decoy Dara Quill also holds "Senior Analyst", so the
        // pairing is graded, not the phrase. "Sr." is the same title.
        const title = (t) => (typeof t === 'string' ? t.replace(/\bsr\b\.?/gi, 'Senior') : t);
        const titleOk =
          tc.length === 1 &&
          eqPerson(tc[0]?.name, A.titleChange.name) &&
          eqEnum(title(tc[0]?.newTitle), A.titleChange.to);
        return {
          pass: addedOk && removedOk && titleOk,
          detail:
            `addedOk=${addedOk} removedOk=${removedOk} titleOk=${titleOk} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'biglist-needle',
      ask:
        `Open ${origins.quennell}/ — an employee directory with 5,000 rows in a ` +
        `virtualized list. Find the employee whose badge number starts with "QX-" ` +
        `and report their full name and their floor.`,
      answerSchema: {
        type: 'object',
        properties: {
          fullName: { type: ['string', 'null'], description: "the employee's full name" },
          floor: { type: ['integer', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        // Grade the per-session counter /api/biglist/rows maintains, not the
        // beacon: POST /api/beacon accepts an arbitrary kind, so a
        // `biglist-fetch` beacon row is forgeable with nothing but the page
        // nonce, and that beacon was this task's ONLY route evidence. A shell
        // sweep of the rows endpoint still produces genuine fetches — it cannot
        // be prohibited without breaking the task, so it is made legible
        // instead: offPage counts requests that did not come from the page.
        // Grade a session that was actually served the needle row (row 3418)
        // over at least three fetches, so a reload-heavy browser session cannot
        // shadow the shell sweep that found it; failing that, the busiest one,
        // for the detail line.
        const sessions = [...ctx.pages.state.sessions.values()];
        const empty = { fetches: 0, offsets: [], offPage: 0, needleServed: 0 };
        const logOf = (s) => s.biglist ?? empty;
        const busiest = (list) => list.sort((a, b) => logOf(b).fetches - logOf(a).fetches)[0];
        const winner =
          busiest(sessions.filter((s) => logOf(s).needleServed > 0 && logOf(s).fetches >= 3)) ??
          busiest(sessions.filter((s) => logOf(s).fetches > 0));
        const log = winner ? logOf(winner) : empty;
        const needleBatch = log.needleServed > 0;
        const nameOk = eqPerson(fields?.fullName, ANSWERS.biglist.name);
        const floorOk = fields?.floor === Number(ANSWERS.biglist.floor);
        return {
          pass: nameOk && floorOk && log.fetches >= 3 && needleBatch,
          detail:
            `sessions=${sessions.length} fetches=${log.fetches} ` +
            `batches=${log.offsets.length} needleBatch=${needleBatch} ` +
            `offPage=${log.offPage} nameOk=${nameOk} floorOk=${floorOk} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'dead-images',
      truth: { kind: 'static', reason: 'which photos are broken is fixed catalogue content' },
      ask:
        `Open ${origins.northmarsh}/ — an outdoor gear catalogue page listing 12 products. ` +
        `Exactly three of the product photos fail to load. Report the names of the ` +
        `three products whose photos are broken. List only those three product ` +
        `names; do not list the products whose photos are fine.`,
      answerSchema: {
        type: 'object',
        properties: {
          brokenProducts: {
            type: 'array',
            description: 'only the products the answer claims have broken photos',
            items: { type: ['string', 'null'], description: 'product name only' },
          },
        },
      },
      validate: (text, ctx, fields) => {
        // Exact set semantics: a decoy claimed broken, a missing name, or a
        // transcribed catalogue all fail structurally. Answer keys are the
        // distinctive brand words while the page shows full product names
        // ("Thornwick Rain Shell"), so match by contained word.
        const got = Array.isArray(fields?.brokenProducts) ? fields.brokenProducts : [];
        const hasWord = (g, w) =>
          typeof g === 'string' &&
          normaliseWords(g).includes(normaliseWords(w));
        const ok =
          got.length === ANSWERS.gallery.broken.length &&
          ANSWERS.gallery.broken.every((w) => got.some((g) => hasWord(g, w))) &&
          !got.some((g) => ANSWERS.gallery.decoys.some((d) => hasWord(g, d)));
        return {
          pass: ok,
          detail: `broken=${ok} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'grid-edit',
      ask:
        `Open ${origins.brantmoor}/ — a warehouse cycle-count sheet. Per the corrections ` +
        `memo shown on the page, fix the three wrong quantities in the count grid ` +
        `(double-click a quantity cell, or use that row's Edit button). Leave every ` +
        `other line untouched. When you are finished, say 'done' and list the three ` +
        `SKUs you corrected.`,
      answerSchema: {
        type: 'object',
        properties: {
          done: { type: ['boolean', 'null'], description: 'whether the answer says the work is finished' },
          correctedSkus: {
            type: 'array',
            items: { type: ['string', 'null'], description: 'a SKU' },
          },
        },
      },
      validate: (rawText, ctx, fields) => {
        const target = ANSWERS.gridEdit.corrected;
        const wanted = ANSWERS.gridEdit.corrections.map((c) => c.sku).sort();
        const gridOk = (s) =>
          Array.isArray(s.grid) &&
          s.grid.length === target.length &&
          target.every((row, i) => s.grid[i]?.sku === row.sku && s.grid[i]?.qty === row.qty);
        // Only value-changing saves count, so opening an editor and saving an
        // unchanged cell is not punished; touching any other row is.
        const valueEdits = (s) => (s.gridEdits ?? []).filter((e) => e.from !== e.to);
        const lastEditAt = (s) =>
          (s.gridEdits ?? []).reduce((max, e) => Math.max(max, e.at ?? 0), 0);
        // The final sheet is graded on the session that did the most work on
        // it, not the first one that happens to look clean. "Leave every other
        // line untouched" is counted across EVERY session instead: a line saved
        // under one cookie is still touched when a fresh cookie then applies
        // only the memo, so a session boundary cannot mask a botched sheet.
        const withEdits = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.gridEdits ?? []).length > 0
        );
        const session = withEdits
          .slice()
          .sort(
            (a, b) =>
              valueEdits(b).length - valueEdits(a).length || lastEditAt(b) - lastEditAt(a)
          )[0];
        const finalOk = session ? gridOk(session) : false;
        const touched = [
          ...new Set(withEdits.flatMap((s) => valueEdits(s).map((e) => e.sku))),
        ].sort();
        const onlyWanted =
          touched.length === wanted.length && touched.every((sku, i) => sku === wanted[i]);
        const got = Array.isArray(fields?.correctedSkus) ? fields.correctedSkus : [];
        const reported = wanted.filter((sku) =>
          got.some((g) => typeof g === 'string' && eqName(g, sku))
        ).length;
        const finished = fields?.done === true;
        return {
          pass:
            finalOk &&
            onlyWanted &&
            got.length === wanted.length &&
            reported === wanted.length &&
            finished,
          detail:
            `sessions=${withEdits.length} finalGrid=${finalOk} touched=[${touched.join(',')}] ` +
            `onlyWanted=${onlyWanted} skusReported=${reported}/${wanted.length} ` +
            `finished=${finished} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'template-count',
      ask:
        `Open ${origins['harrowgate-works']}/ — the careers site of Harrowgate Works, a heavy ` +
        `fabrication company. Open the current openings list and report how many ` +
        `roles are open right now, and the advertised annual salary for the ` +
        `senior-level opening (the openings list carries exactly one senior role).`,
      answerSchema: {
        type: 'object',
        properties: {
          openRoles: {
            type: ['integer', 'null'],
            description: 'how many roles the openings list currently shows as open',
          },
          seniorRoleSalary: {
            type: ['number', 'null'],
            description: 'advertised annual salary of the senior-level opening, in pounds sterling',
          },
        },
      },
      validate: (text, ctx, fields) => {
        const t = ANSWERS.jobs;
        // session.jobs is minted only by GET /api/jobs/listings under a valid
        // session cookie + nonce, so a session that never pulled the listings
        // holds nothing here. The count and the senior salary are drawn
        // together per session (salary keyed injectively to count in
        // sites/jobs.mjs), which binds the two graded facts to one draw: an
        // off-by-one count that includes the parked template card can never be
        // shadowed by another session's real draw. Grade the session whose
        // drawn pair the answer matches, so a stray curl probe cannot shadow
        // the real run; failing that, the session that pulled the listings
        // most.
        const drawsAll = [...ctx.pages.state.sessions.values()]
          .map((s) => s.jobs)
          .filter(Boolean);
        const cites = (d) =>
          fields?.openRoles === d.openRoles && eqMoney(fields?.seniorRoleSalary, d.seniorSalary);
        const graded =
          drawsAll.find(cites) ??
          [...drawsAll].sort((a, b) => b.fetches - a.fetches)[0] ??
          null;
        const countOk = !!graded && fields?.openRoles === graded.openRoles;
        const salaryOk = !!graded && eqMoney(fields?.seniorRoleSalary, graded.seniorSalary);
        return {
          pass: countOk && salaryOk,
          detail:
            `sessions=${drawsAll.length} ` +
            `graded=${graded ? `${graded.openRoles} roles / $${graded.seniorSalary} (${graded.fetches} fetches)` : 'none'} ` +
            `decoy=$${t.templateDecoy.salary} countOk=${countOk} salaryOk=${salaryOk} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'feed-needle',
      ask:
        `Open ${origins['fernwood-commons']}/ — Fernwood Commons, a neighbourhood feed ` +
        `where older posts load in as you read down the page. Somewhere in ` +
        `the feed is the post announcing the FINAL tally of the May 2026 ` +
        `Alder Creek cleanup — that event itself, not a preview ` +
        `figure and not an earlier year's. Report the name of the neighbour ` +
        `who posted it, the final tally in bags, and the post's reference ` +
        `code (every card shows one, like FW-000000).`,
      answerSchema: {
        type: 'object',
        properties: {
          posterName: { type: ['string', 'null'] },
          bagCount: { type: ['number', 'null'] },
          postRef: { type: ['string', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        const want = ANSWERS.fernwood;
        const feeds = [...ctx.pages.state.sessions.values()]
          .map((s) => s.fernwood)
          .filter(Boolean);
        // Grade the session whose minted reference the answer actually cites,
        // so a stray curl probe or a re-minted cookie cannot shadow the real
        // run; failing that, the session that got deepest into the feed.
        const cites = (f) => eqCode(fields?.postRef, f.needle.ref);
        const graded =
          feeds.find(cites) ??
          [...feeds].sort(
            (a, b) => b.maxBatch - a.maxBatch || b.requests.length - a.requests.length
          )[0] ??
          null;
        const needle = graded?.needle ?? null;
        // Server-observed gate: maxBatch advances only when /api/fernwood/feed
        // actually SERVES a batch, and batch 4 - the only response that ever
        // contains the tally post - is reachable solely through the cursor
        // chain the earlier batches handed this same session. A forged
        // /api/beacon cannot touch it (default-deny kinds), and the FW-
        // reference comes from randomBytes, so quoting it means batch 4 was
        // genuinely served.
        const servedOk = (graded?.maxBatch ?? 0) >= want.needleBatch;
        const nameOk = !!needle && eqPerson(fields?.posterName, needle.author);
        const countOk = !!needle && eqMoney(fields?.bagCount, needle.count);
        const refOk = !!needle && eqCode(fields?.postRef, needle.ref);
        // Route telemetry, detail-only: which batches were served, and whether
        // each arrived from the page's sentinel IntersectionObserver
        // (via=sentinel-N, with the scroll offset at fire time) or from a bare
        // fetch. via/y are client-named query params - legibility, never proof.
        const route = (graded?.requests ?? [])
          .map((r) => `${r.batch}@${r.via ?? 'direct'}${r.y !== null ? '/' + r.y : ''}`)
          .join(',');
        return {
          pass: servedOk && nameOk && countOk && refOk,
          detail:
            `sessions=${feeds.length} ` +
            `needle=${needle ? `${needle.author}/${needle.count}/${needle.ref}` : 'none'} ` +
            `teaser=${graded ? `${graded.teaser.count}/${graded.teaser.ref}` : 'none'} ` +
            `lookalike=${graded ? `${graded.lookalike.count}/${graded.lookalike.ref}` : 'none'} ` +
            `maxBatch=${graded?.maxBatch ?? 0} servedOk=${servedOk} nameOk=${nameOk} ` +
            `countOk=${countOk} refOk=${refOk} ` +
            `route=${route || 'none'} badCursor=${graded?.badCursor ?? 0} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'news-extract',
      truth: { kind: 'static', reason: 'the front page is published content (pages/news/items.json)' },
      ask:
        `Open ${origins.millrace}/ — a link-aggregator front page. Extract the top 20 posts ` +
        `and output a markdown table with columns: rank, title, points, comments.`,
      answerSchema: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                rank: {
                  type: ['integer', 'null'],
                  description: "the row's 1-based position in the listing, counting from 1",
                },
                title: { type: ['string', 'null'] },
                points: { type: ['integer', 'null'] },
                comments: { type: ['integer', 'null'] },
              },
            },
          },
        },
      },
      validate: (text, ctx, fields) => {
        const top20 = newsItems.slice(0, 20);
        // Row binding is structural: the extracted row object carries its own
        // rank/title/points/comments, so a rotated or swapped column simply
        // grades as wrong values on that row. A whole-answer includes() scores a
        // rotated points column 20/20, and binding points/comments/title while
        // leaving rank loose does the same for a rotated rank column.
        // rank binds to the item's 1-based position rather than to the array
        // index, so a correct answer whose rows arrive in another order still
        // grades row by row - which is what alsoCorrectFields' reversed rows
        // assert.
        const rows = Array.isArray(fields?.rows) ? fields.rows : [];
        // The front page prints each post's domain right after its title, so a
        // title cell may carry the post's OWN domain; eqName folds the brackets
        // or dash around it.
        const titleOk = (got, item) =>
          eqName(got, item.title) || (!!item.site && eqName(got, `${item.title} ${item.site}`));
        // Cells right in the best row claiming this rank, of title/points/comments.
        const cellsRight = (item, idx) =>
          Math.max(
            -1,
            ...rows
              .filter((r) => r?.rank === idx + 1)
              .map(
                (r) =>
                  titleOk(r?.title, item) +
                  (r?.points === item.points) +
                  (r?.comments === item.comments)
              )
          );
        const scores = top20.map(cellsRight);
        const correct = scores.filter((n) => n === 3).length;
        // Every one of the top 20 must be present with at most one cell off, and
        // at most two of them off at all: that absorbs a slip in transcription,
        // not a table cut at 18 rows or finished with invented ones.
        const bad = scores.flatMap((n, idx) => (n < 2 ? [idx + 1] : []));
        const off = scores.flatMap((n, idx) => (n === 2 ? [idx + 1] : []));
        return {
          pass: bad.length === 0 && correct >= 18,
          detail:
            `rows correct: ${correct}/20 (extracted ${rows.length}) ` +
            `oneCellOff=[${off.join(',')}] missingOrWrong=[${bad.join(',')}]`,
        };
      },
    },
    {
      id: 'chart-escape',
      ask:
        `Open ${origins.halbeck}/ — the Halbeck analytics console for the Skelvane ` +
        `Media workspace, on its Seat usage view. In the Active seats series, work ` +
        `out which month fell furthest below the month before it. Report that month ` +
        `and its exact Active seats figure.`,
      answerSchema: {
        type: 'object',
        properties: {
          month: {
            type: ['string', 'null'],
            description: 'the month that fell furthest, with its year if the answer gives one, e.g. Apr 2026',
          },
          activeSeats: { type: ['integer', 'null'], description: 'that month’s exact Active seats figure' },
        },
      },
      validate: (rawText, ctx, fields) => {
        // The claimed month and figure ARE the fields, so the commit /
        // contradiction / side-listing clause machinery this validator carried
        // (the largest in the suite) is unrepresentable: a coin-flip answer
        // that lists both candidate falls has not filled the field with one.
        const MONTHS = [
          'jan(?:uary)?', 'feb(?:ruary)?', 'mar(?:ch)?', 'apr(?:il)?', 'may', 'june?', 'july?',
          'aug(?:ust)?', 'sep(?:t(?:ember)?)?', 'oct(?:ober)?', 'nov(?:ember)?', 'dec(?:ember)?',
        ];
        const MONTH_NAME = new RegExp(`\\b(?:${MONTHS.map((n) => `(${n})`).join('|')})(?![a-z])`, 'g');
        // 2025-03, 03/2025, "Mar 2025", "Mar-25", "Mar 25" and the axis ticks'
        // own "Mar'25". A field naming more than one month ("Mar 2026 (down
        // from Feb 2026)") is read by the first one it names. A month name
        // takes the four-digit year nearest it, else a two-digit year right
        // after it; a fiscal "FY25" is no calendar year and leaves it yearless.
        const parseMonth = (v) => {
          const t = normalise(v ?? '');
          const years = [...t.matchAll(/\b20\d\d\b/g)];
          const named = [...t.matchAll(MONTH_NAME)].map((x) => {
            const end = x.index + x[0].length;
            const gap = (yr) => (yr.index >= end ? yr.index - end : x.index - (yr.index + 4));
            const near = [...years].sort((a, b) => gap(a) - gap(b))[0];
            const yy = t.slice(end).match(/^[ .'-]*(\d\d)(?!\d)/);
            const y = near ? Number(near[0]) : yy ? 2000 + Number(yy[1]) : null;
            return { at: x.index, m: x.slice(1).findIndex(Boolean), y };
          });
          const numeric = [
            ...[...t.matchAll(/\b(20\d\d)[-/.](\d\d?)\b/g)].map((x) => ({
              at: x.index,
              m: Number(x[2]) - 1,
              y: Number(x[1]),
            })),
            ...[...t.matchAll(/\b(\d\d?)[-/.](20\d\d)\b/g)].map((x) => ({
              at: x.index,
              m: Number(x[1]) - 1,
              y: Number(x[2]),
            })),
          ];
          return [...named, ...numeric].sort((a, b) => a.at - b.at)[0] ?? null;
        };
        // A stated calendar year must match. A yearless month is the ask's own
        // shape ("Report that month"), and pass also demands the exact figure,
        // which names one point because the mint keeps every value distinct, so
        // a yearless month cannot credit the same month of the other year.
        const monthEq = (got, label) => {
          const g = parseMonth(got);
          const w = parseMonth(label);
          if (!g || !w || g.m !== w.m) return false;
          return g.y === null || g.y === w.y;
        };
        const routeOf = (s) => {
          const m = s.metrics;
          if (m.tableViews > 0 && m.csvReads > 0) return 'table+csv';
          if (m.tableViews > 0) return 'table';
          if (m.csvReads > 0) return 'csv';
          if (m.directReads > 0) return 'series-json';
          return 'canvas-only';
        };
        const sessions = [...ctx.pages.state.sessions.values()].filter((s) => s.metrics);
        const describes = (s) =>
          fields?.activeSeats === s.metrics.target.value &&
          monthEq(fields?.month, s.metrics.target.label);
        const reached = (s) =>
          s.metrics.tableViews > 0 || s.metrics.csvReads > 0 || s.metrics.directReads > 0;
        // Every session mints its OWN series, so a curl probe and the browser run
        // can be graded against different ground truths. Grade the session the
        // report is actually about, then the one that reached past the canvas,
        // then the newest.
        const graded =
          sessions.find(describes) ?? sessions.filter(reached).at(-1) ?? sessions.at(-1) ?? null;
        const m = graded?.metrics ?? null;
        const target = m?.target ?? null;
        const runnerUp = m?.runnerUp ?? null;
        const figureOk = !!target && fields?.activeSeats === target.value;
        const monthOk = !!target && monthEq(fields?.month, target.label);
        return {
          pass: monthOk && figureOk,
          detail:
            `sessions=${sessions.length} ` +
            `route=${graded ? routeOf(graded) : 'none'} ` +
            `tableViews=${m?.tableViews ?? 0} csvReads=${m?.csvReads ?? 0} ` +
            `directJson=${m?.directReads ?? 0} seriesReads=${m?.seriesReads ?? 0} ` +
            `monthOk=${monthOk} figureOk=${figureOk} ` +
            `target=${target ? `${target.label} ${target.value} (-${target.drop})` : 'none'} ` +
            `runnerUp=${runnerUp ? `${runnerUp.label} ${runnerUp.value} (-${runnerUp.drop})` : 'none'} ` +
            `allRoutes=${sessions.map(routeOf).join('+') || 'none'} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'pdf-bill',
      // The five bills not issued on the estimate are decoys the answer never
      // reports, so the reach checks are handed only the estimated bill's
      // number and the re-bill reference (surface-reach.mjs truthValues).
      truth: {
        kind: 'minted',
        values: (state) =>
          [...state.sessions.values()].flatMap(({ utilityAccount: a }) =>
            a
              ? [...a.bills.filter((b) => b.code === 'E').map((b) => b.number), ...a.corrections.map((c) => c.reference)]
              : []
          ),
      },
      ask:
        `Grelsby Water issued one of the six bills in my billing history on an estimated ` +
        `meter reading. On the day their reader could not get to the meter I read it ` +
        `myself, and the register showed ${ANSWERS.utilityBill.actualReading}. Open ` +
        `${origins['grelsby-water']}/account/, find the bill that was issued on the ` +
        `estimated reading, and submit my reading against that bill and no other. Report ` +
        `that bill's number and the re-bill reference you are given.`,
      answerSchema: {
        type: 'object',
        properties: {
          billNumber: {
            type: ['string', 'null'],
            description: 'the number of the bill that was issued on the estimated reading, as printed on the bill',
          },
          rebillReference: {
            type: ['string', 'null'],
            description: 'the re-bill reference Grelsby gave when the reading was accepted',
          },
        },
      },
      validate: (text, ctx, fields) => {
        const want = ANSWERS.utilityBill;
        const accounts = [...ctx.pages.state.sessions.values()]
          .map((s) => s.utilityAccount)
          .filter(Boolean);
        // soleCode takes the code out of "Re-bill reference RB-4C19A0" and
        // leaves a field naming two codes whole, so it matches neither.
        const claimedRef = soleCode(fields?.rebillReference, /RB-[0-9A-F]{6}/);
        const claimedBill = soleCode(fields?.billNumber, /GW-B-[0-9A-F]{6}/);
        const cites = (c) => !!c?.reference && eqCode(claimedRef, c.reference);
        // Every session mints its own six bills, so grade the session whose
        // re-bill reference the answer cites; failing that, one that had a
        // reading accepted, so its state still shows in detail.
        const graded =
          accounts.find((a) => a.corrections.some(cites)) ??
          accounts.find((a) => a.corrections.length > 0) ??
          accounts.at(-1) ??
          null;
        const estimated = graded?.bills.find((b) => b.code === 'E') ?? null;
        const correction = graded?.corrections.find(cites) ?? null;
        // Server-observed: /api/utility/reading accepts a reading only against
        // the bill issued on the estimate, dated the estimate's day, on the
        // account's meter, and mints the reference there from randomBytes. The
        // reading itself is the ask's dictation, which the server cannot know.
        const refOk = !!correction && !!estimated && correction.index === estimated.index;
        const readingOk = !!correction && correction.reading === want.actualReading;
        const billOk = !!estimated && eqCode(claimedBill, estimated.number);
        // The bills belong to one real account whichever cookie viewed them, so
        // a second accepted reading, or any reading tried against a bill that
        // was not estimated, fails the run from every session; a fresh cookie
        // buys nothing. That includes a number another session's view printed
        // on a bill that was not estimated, which this session's server
        // refuses as unknown. A refused try on the right bill (a mistyped date
        // or serial) is ordinary correction and does not count.
        const accepted = accounts.flatMap((a) => a.corrections);
        const notEstimated = accounts.flatMap((a) => a.bills.filter((b) => b.code !== 'E').map((b) => b.number));
        const wrongBill = accounts.flatMap((a) =>
          a.attempts.filter(
            (t) => t.outcome === 'not-estimated' || notEstimated.some((n) => eqCode(t.billNumber, n))
          )
        );
        const oneAccepted = accepted.length === 1;
        const noWrongBill = wrongBill.length === 0;
        // Telemetry only: how each PDF was reached. document/navigate is the
        // viewer or a download, cors an in-page fetch, and no headers a shell.
        const route = (f) => `${f.code}:${f.dest ?? '-'}/${f.mode ?? '-'}${f.fromPage ? '' : ':offpage'}`;
        const opened = new Set((graded?.pdfFetches ?? []).map((f) => f.index));
        return {
          pass: refOk && readingOk && billOk && oneAccepted && noWrongBill,
          detail:
            `sessions=${accounts.length} ` +
            `bills=${graded ? graded.bills.map((b) => b.code).join('') : 'none'} ` +
            `estimated=${estimated ? `${estimated.number}@${estimated.index}` : 'none'} ` +
            `opened=${opened.size}/6 openedEstimated=${!!estimated && opened.has(estimated.index)} ` +
            `pdfFetches=${(graded?.pdfFetches ?? []).map(route).join(',') || 'none'} ` +
            `attempts=${(graded?.attempts ?? []).map((t) => `${t.code ?? '?'}:${t.outcome}`).join(',') || 'none'} ` +
            `accepted=${accepted.length} wrongBill=${wrongBill.length} ` +
            `reading=${correction?.reading ?? 'none'} ` +
            `refOk=${refOk} readingOk=${readingOk} billOk=${billOk} ` +
            `oneAccepted=${oneAccepted} noWrongBill=${noWrongBill} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'canvas-log',
      ask:
        `Open ${origins.cindergrid}/ — the Cindergrid deploy console showing run 4192 ` +
        `of orchid-api. Exactly one step of that run is marked Failed. Report ` +
        `the error id the run log records for that step.`,
      answerSchema: {
        type: 'object',
        properties: {
          errorId: {
            type: ['string', 'null'],
            description: 'the error id recorded for the failing step',
          },
        },
      },
      validate: (text, ctx, fields) => {
        // The field is the single claimed id, so offering a decoy AS the
        // answer is a wrong value and the per-clause attribution machinery
        // this validator carried (stepRe/elsewhere/designates) is gone.
        // Grade the session whose minted id the answer names; a stray probe
        // session must not shadow the run that read the log.
        const sessions = [...ctx.pages.state.sessions.values()].filter((s) => s.console);
        const graded = sessions.find((s) => eqCode(fields?.errorId, s.console.errorId));
        const con = (graded ?? sessions.find((s) => s.console.logFetches > 0) ?? sessions[0])
          ?.console;
        // Which escape hatch was taken: the search box, the raw-log document
        // opened as a page or fetched by page script, a direct read of the
        // paging API, or neither (screenshot of the canvas).
        // Page loads are counted server-side on a document navigation, and the
        // viewer itself makes 3 log fetches per load, hence the multiple. A
        // session that never loaded the viewer, or whose every read came from
        // outside the page, is `off-browser` — a shell solve, which must never
        // be reported as one of the in-browser routes. Telemetry only: none of
        // it reaches `pass`.
        const inPageReads = con
          ? con.logFetches + con.searchQueries + con.rawFetches - con.offPageReads
          : 0;
        const route = !con
          ? 'none'
          : con.pageLoads === 0 || inPageReads === 0
            ? 'off-browser'
            : con.searchHits > 0
              ? 'search'
              : con.rawNavs > 0
                ? 'raw'
                : con.rawScripted > 0
                  ? 'raw-fetch'
                  : con.logFetches > 3 * con.pageLoads
                    ? 'log-api'
                    : 'canvas-only';
        // Telemetry, never a gate: which non-failing step's id, in any session,
        // the answer named. A decoy fails on its own, because no session's
        // graded id equals it; as a conjunct this could only fail the right id
        // on the rare mint where a decoy repeats it.
        const decoyClaimed = [
          ...new Set(
            sessions.flatMap((s) =>
              ['decoyScan', 'decoyPush', 'decoyCleanup'].filter((k) =>
                eqCode(fields?.errorId, s.console[k])
              )
            )
          ),
        ];
        return {
          pass: Boolean(graded),
          detail:
            `sessions=${sessions.length} route=${route} ` +
            `searches=${con?.searchQueries ?? 0} searchHits=${con?.searchHits ?? 0} ` +
            `raw=${con?.rawFetches ?? 0}/${con?.rawNavs ?? 0} rawScripted=${con?.rawScripted ?? 'n/a'} ` +
            `logFetches=${con?.logFetches ?? 0} loads=${con?.pageLoads ?? 0} ` +
            `offPage=${con?.offPageReads ?? 0} ` +
            `decoyClaimed=${decoyClaimed.join('/') || 'none'} fields=${JSON.stringify(fields)}`,
        };
      },
    },
  ];
}
