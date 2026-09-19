// The devtools suite (--suite devtools): console/network-surface tasks,
// kept out of the web suite by owner decision. Same contract as web.mjs.
import { eqCode, eqName, normalise, normaliseWords } from '../extract.mjs';
import { originUrls } from '../../manifest.mjs';

// The first URL path a field carries is the request it names; a later path is
// context, as in "GET /api/depot/roster (then fell back to roster-cache.json)".
// Null when the field names its request in prose.
function firstPath(field) {
  const m = normalise(field ?? '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^/\s]*/g, ' ')
    .match(/(?:^|[^\w.\/-])(\/[\w.-][\w.\/-]*|api\/[\w.\/-]*)/);
  return m ? '/' + m[1].replace(/^\/|\/+$/g, '') : null;
}

const REQUEST_NOUN = /^(request|requests|fetch|fetches|call|calls|xhr|api|endpoint|get)$/;

// Prose names a request by its first mention of the resource word. A word
// that points elsewhere (the fallback's cache stem, the page's document)
// before that mention names the other thing; after it, it is context only
// when a request noun follows the resource word, as in "the roster request,
// not the cached fallback".
function namesInProse(field, resource, pointsElsewhere) {
  const words = normaliseWords(field ?? '').trim().split(' ');
  const at = words.findIndex((w) => resource.test(w));
  if (at === -1) return false;
  const elsewhere = words.map((_, j) => j).filter((j) => pointsElsewhere(words, j));
  return (
    elsewhere.every((j) => j > at) &&
    (elsewhere.length === 0 || REQUEST_NOUN.test(words[at + 1] ?? ''))
  );
}

export async function devtoolsTasks(base, origins = originUrls(base)) {
  return [
    {
      id: 'shard-forensics',
      tier: 'quick',
      ask:
        `Sign in at ${origins['marlowe-depot']}/ as the seeded operator (the terminal form is ` +
        `prefilled). The shift dashboard you land on is showing yesterday's roster. ` +
        `Something failed during sign-in - say which request failed, with its HTTP ` +
        `status code, and report the trace id the server returned with that failure.`,
      answerSchema: {
        type: 'object',
        properties: {
          failedRequest: {
            type: ['string', 'null'],
            description:
              'the request that failed during sign-in: a URL, a path, or a ' +
              'short name like "the roster request"',
          },
          statusCode: {
            type: ['integer', 'null'],
            description: 'the HTTP status code of the failed request',
          },
          traceId: {
            type: ['string', 'null'],
            description: 'the trace id the server returned with the failure, e.g. DT-1A2B3C4D',
          },
        },
      },
      validate: (text, ctx, fields) => {
        // Grade the session whose minted trace the answer names; several
        // sessions can exist per run (a curl probe, a re-minted cookie), and
        // the trace is only ever issued on the 502 that session was served.
        const sessions = [...ctx.pages.state.sessions.values()].filter(
          (s) => s.depot?.signedIn
        );
        const graded =
          sessions.find((s) => eqCode(fields?.traceId, s.depot.trace)) ?? sessions[0];
        const d = graded?.depot;
        // The failing request must be the roster fetch, not the sign-in POST
        // and not the cached-roster fallback file (which also contains the
        // word "roster" but succeeded with a 200). A field that carries a
        // path is graded on its first one. Prose must name the roster, and
        // not by the fallback's file name or as the cached one; "non-cached"
        // points at the live request.
        const request = normalise(fields?.failedRequest ?? '');
        const path = firstPath(request);
        const namesRoster = path
          ? path === '/api/depot/roster'
          : !normaliseWords(request).includes(' json ') &&
            namesInProse(
              request,
              /^roster$/,
              (w, j) => /^cach(e|ed|ing)$/.test(w[j]) && !/^(non|not)$/.test(w[j - 1] ?? '')
            );
        // The page requests only the shard sign-in assigned, so a named shard
        // must be that one; a shard-less naming stands.
        const shardsNamed = [...request.matchAll(/\bshard\s*(?:[=:#-]|no\.?|number)?\s*(\d+)/g)].map(
          (m) => Number(m[1])
        );
        const shardOk = Boolean(d) && shardsNamed.every((n) => n === d.shard);
        return {
          pass:
            Boolean(d) &&
            eqCode(fields?.traceId, d.trace) &&
            fields?.statusCode === 502 &&
            namesRoster &&
            shardOk,
          // rosterHits is the retention gap expressed as a number: how many
          // times the failure had to be (re-)caused for the surface to see it.
          detail:
            `signedIn=${sessions.length} shard=${d?.shard ?? '?'} ` +
            `namesRoster=${namesRoster} namedShards=${shardsNamed.join('/') || '-'} ` +
            `rosterHits=${d?.rosterHits ?? 0} failServed=${d?.rosterFailures ?? 0} ` +
            `signins=${d?.signins ?? 0} fields=${JSON.stringify(fields)}`,
        };
      },
    },

    {
      id: 'body-only-ref',
      tier: 'quick',
      ask:
        `The manifests page at ${origins['marlowe-depot']}/manifests.html is showing no manifests ` +
        `for the shift. Diagnose why - name the request that fails and its HTTP ` +
        `status code - and report the support reference the server sent back with ` +
        `the failure.`,
      answerSchema: {
        type: 'object',
        properties: {
          failedRequest: {
            type: ['string', 'null'],
            description:
              'the failing request: a URL, a path, or a short name like ' +
              '"the manifests request"',
          },
          statusCode: {
            type: ['integer', 'null'],
            description: 'the HTTP status code of the failing request',
          },
          supportRef: {
            type: ['string', 'null'],
            description:
              'the support reference the server sent with the failure, e.g. MR-1A2B3C4D; ' +
              'null if the answer does not state one',
          },
        },
      },
      validate: (text, ctx, fields) => {
        // Pass = the diagnosis (507 on the manifests request), plus the ref
        // whenever the answer states one. The ref lives only in the response
        // body, which firefox-devtools-mcp's network tools never return
        // (playwright-mcp's browser_network_request does), so an answer that
        // says it could not recover the ref still passes: refFound is the
        // measured capability gap. A stated ref is a claim, though, and a
        // fabricated one fails. The 507 is
        // deliberate: 500 is the modal guess for a broken API, so a guessed
        // status must fail - the log is the only place to read the real one.
        const sessions = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.depot?.manifestHits ?? 0) > 0
        );
        const graded =
          sessions.find((s) => eqCode(fields?.supportRef, s.depot.manifestRef)) ??
          sessions[0];
        const d = graded?.depot;
        // A field that carries a path is graded on its first one. Otherwise
        // singular and plural prose namings both count, but the page document
        // (manifests.html, a 200) and the intake page's manifest data file
        // (manifest-dm2116.txt, a 200) must not: their file names fail
        // anywhere, the word "document" only where it names the thing.
        const request = normalise(fields?.failedRequest ?? '');
        const path = firstPath(request);
        const namesManifests = path
          ? path === '/api/depot/manifests'
          : !/ (html|txt|dm2116) /.test(normaliseWords(request)) &&
            namesInProse(request, /^manifests?$/, (w, j) => w[j] === 'document');
        // A stated ref is an identifier: a token that mixes letters and
        // digits, carries an underscore, or is the MR prefix. "N/A" and "not
        // recoverable (body not exposed)" state none and pass like null;
        // "manifest_store_locked" is the body's error code claimed as the ref.
        const refStated = String(fields?.supportRef ?? '')
          .split(/[^a-z0-9_]+/i)
          .some((t) => /^mr$/i.test(t) || t.includes('_') || (/\d/.test(t) && /[a-z]/i.test(t)));
        const refFound = Boolean(d) && eqCode(fields?.supportRef, d.manifestRef);
        return {
          pass:
            Boolean(d) &&
            fields?.statusCode === 507 &&
            namesManifests &&
            (!refStated || refFound),
          // manifestHits > 1 is the price of the missing capability: the
          // re-fetch an agent needs to reach the body without response-body
          // capture.
          detail:
            `sessions=${sessions.length} manifestHits=${d?.manifestHits ?? 0} ` +
            `namesManifests=${namesManifests} refStated=${refStated} ` +
            `refFound=${refFound} ref=${d?.manifestRef ?? '?'} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },

    {
      id: 'partial-import',
      tier: 'quick',
      ask:
        `Post the delivery manifest at ${origins['marlowe-depot']}/intake.html: load manifest ` +
        `DM-2116, then post it to intake. The page will report that it posted ` +
        `everything - verify that against what actually happened, and report how ` +
        `many lines were actually accepted, which line keys were rejected, and the ` +
        `diagnostic code attached to the rejections.`,
      answerSchema: {
        type: 'object',
        properties: {
          acceptedCount: {
            type: ['integer', 'null'],
            description: 'the number of manifest lines the server actually accepted',
          },
          rejectedKeys: {
            type: 'array',
            description: 'the line keys the server rejected, e.g. LN-1042 (keys only)',
            items: { type: ['string', 'null'] },
          },
          diagCode: {
            type: ['string', 'null'],
            description: 'the diagnostic code attached to the rejected lines, e.g. DG-1A2B3C',
          },
        },
      },
      validate: (text, ctx, fields) => {
        // The intake draw is per-session; grade the session whose diag code the
        // answer names, falling back to any session that posted. The
        // server-observed intakeStored === 37 is what proves the import really
        // ran (the page's own claim of 40 is the lie under test).
        const sessions = [...ctx.pages.state.sessions.values()].filter(
          (s) => s.depot?.intake
        );
        const graded =
          sessions.find((s) => eqCode(fields?.diagCode, s.depot.intake.diag)) ??
          sessions[0];
        const d = graded?.depot;
        const want = d?.intake.rejects ?? [];
        const claimed = Array.isArray(fields?.rejectedKeys)
          ? fields.rejectedKeys.filter((k) => typeof k === 'string')
          : [];
        // Set equality, not containment: naming a healthy line as rejected is
        // as wrong as missing a rejected one.
        const keysOk =
          want.length === 3 &&
          claimed.length === 3 &&
          want.every((k) => claimed.some((c) => eqCode(c, k)));
        return {
          pass:
            Boolean(d) &&
            d.intakeStored === 37 &&
            fields?.acceptedCount === 37 &&
            keysOk &&
            eqCode(fields?.diagCode, d.intake.diag),
          detail:
            `sessions=${sessions.length} stored=${d?.intakeStored ?? 0} ` +
            `posts=${d?.intakePosts ?? 0} rejects=${want.join('/')} ` +
            `diag=${d?.intake?.diag ?? '?'} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'silent-throw',
      // The evidence is produced once, at the first click: the batch is
      // one-shot and the console entry it leaves is subject to the 5-minute
      // log TTL, so a longer wall would grade patience against the fixture's own
      // retention defect rather than the tool surface.
      tier: 'quick',
      ask:
        `Open ${origins['ashline-quotient']}/reconcile.html and run the reconciliation. ` +
        `It fails silently. Report which function in the page's own code throws, ` +
        `and which field of the server's batch response is missing.`,
      answerSchema: {
        type: 'object',
        properties: {
          throwingFunction: {
            type: ['string', 'null'],
            description: 'name of the function that throws, name only, e.g. "renderTable"',
          },
          missingField: {
            type: ['string', 'null'],
            description: 'JSON field name missing from the response, name only, e.g. "rows"',
          },
        },
      },
      validate: (text, ctx, fields) => {
        const flat = (s) => normalise(String(s ?? '')).replace(/[^a-z0-9]+/g, '');
        // "fx", "batch.fx" and "payload.fx" all name the field; "fxRates"
        // does not.
        const fieldEq = (got, want) =>
          typeof got === 'string' &&
          [flat(got), flat(got).replace(/^(batch|payload|response|data|json)/, '')].includes(
            flat(want)
          );
        // "applyFxRate()", "window.applyFxRate" and "applyFxRate (app.js:21)"
        // all name the helper: a dotted qualifier may precede it and only its
        // source location may follow. "the caller of applyFxRate" and
        // "renderCards after applyFxRate" name some other function.
        const namesHelper = (got, helper) => {
          if (typeof got !== 'string' || !helper) return false;
          if (eqName(got, helper)) return true;
          const m = got
            .toLowerCase()
            .match(new RegExp(`^[^a-z0-9_$]*(?:[a-z_$][\\w$]*\\.)*${helper.toLowerCase()}(?![\\w$])(.*)$`));
          return (
            Boolean(m) &&
            m[1]
              .split(/[^a-z0-9_$]+/)
              .filter(Boolean)
              .every((t) => /^(app|js|at|line|\d+)$/.test(t))
          );
        };
        const sessions = [...ctx.pages.state.sessions.values()].filter((s) => s.quotient?.batch);
        // Grade the session that ran the reconciliation through the page.
        // The draw space is only 8 pairs, so the usual answer-matching
        // selection is collision-prone: a stray curl probe has a 1-in-8
        // chance of drawing whatever pair the answer names, and must not
        // shadow the run that clicked the button. servedFromPage is
        // forgeable legibility (curl -H sets Referer and sec-fetch-site
        // freely), so it steers SELECTION only and never the pass bit. Every
        // page-served session competes on its own one-shot draw: a re-run
        // through the page under a fresh cookie is an honest second batch,
        // and a shell session with a forged Referer is indistinguishable
        // from one, so forging buys exactly what that re-run gets. A pure
        // shell run (no page-served session at all) is still graded, against
        // its own draw.
        const fieldOf = (s) => fieldEq(fields?.missingField, s.quotient.batch.omitted);
        const helperOf = (s) => namesHelper(fields?.throwingFunction, s.quotient.batch.helper);
        const pageServed = sessions.filter((s) => s.quotient.batch.servedFromPage);
        const pool = pageServed.length ? pageServed : sessions;
        const graded =
          pool.find((s) => fieldOf(s) && helperOf(s)) ??
          pool.find((s) => fieldOf(s) || helperOf(s)) ??
          pool[0];
        const batch = graded?.quotient.batch;
        const fieldOk = Boolean(batch) && fieldOf(graded);
        const helperOk = Boolean(batch) && helperOf(graded);
        // Naming the DECOY draw means the agent re-fetched the one-shot batch
        // out of band and trusted the 410's reference copy. Telemetry, as are
        // the serve counters: the decoy is never the graded draw, so the pass
        // bit already fails that answer.
        const namedDecoy =
          Boolean(batch) &&
          (fieldEq(fields?.missingField, batch.decoyField) ||
            namesHelper(fields?.throwingFunction, batch.decoyHelper));
        return {
          pass: fieldOk && helperOk,
          detail:
            `sessions=${sessions.length} omitted=${batch?.omitted} helper=${batch?.helper} ` +
            `decoyField=${batch?.decoyField} fieldOk=${fieldOk} helperOk=${helperOk} ` +
            `namedDecoy=${namedDecoy} decoyServes=${batch?.decoyServes ?? 0} ` +
            `offPageDecoyServes=${batch?.offPageDecoyServes ?? 0} ` +
            `servedFromPage=${batch?.servedFromPage} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'mid-flight-rate',
      tier: 'standard',
      ask:
        `Open ${origins['ashline-quotient']}/quote.html — Quotient's freight quoting tool. ` +
        `Price these two shipments, in this order: first 40 kg on the Harlow - Dunmere ` +
        `lane, then 65 kg on the Casterway Corridor lane. The page applies a market ` +
        `rate multiplier to each quote that it never displays. Report the exact rate ` +
        `multiplier (four decimal places) that was applied to the SECOND quote.`,
      answerSchema: {
        type: 'object',
        properties: {
          rateMultiplier: {
            type: ['number', 'null'],
            description:
              'the rate multiplier applied to the second quote, to four decimal places, e.g. 1.2345',
          },
        },
      },
      validate: (text, ctx, fields) => {
        const rateEq = (got, want) => typeof got === 'number' && Math.abs(got - want) <= 0.00005;
        const sessions = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.quotient?.quotes?.length ?? 0) > 0
        );
        // The rates a correct answer may carry: the rate of a Casterway 65 kg
        // quote issued after a Harlow-Dunmere 40 kg one - the asked flow's
        // second quote in the plain case. Both asked shipments must actually
        // have been priced: a session that quoted other lanes or weights has
        // no accepted rates, whatever its second quote was, and an agent that
        // spent an exploratory quote before following the ask is graded on
        // the asked-for shipment rather than failed on an index. A re-quote
        // of the asked pair after the fact also mints an accepted rate: it
        // exercises the same body-read capability, and every accepted rate is
        // minted per call and exists only in one response body.
        const accepted = (s) => {
          const quotes = s.quotient.quotes;
          const list = [];
          const firstAsked = quotes.findIndex(
            (q) => q.lane === 'harlow-dunmere' && Math.abs(q.weight - 40) < 1e-9
          );
          if (firstAsked !== -1) {
            for (const q of quotes.slice(firstAsked + 1)) {
              if (q.lane === 'casterway' && Math.abs(q.weight - 65) < 1e-9) list.push(q.rate);
            }
          }
          return list;
        };
        const solved = (s) =>
          s.quotient.quotes.length >= 2 &&
          accepted(s).some((r) => rateEq(fields?.rateMultiplier, r));
        const graded =
          sessions.find(solved) ??
          sessions
            .filter((s) => s.quotient.quotes.length >= 2)
            .sort(
              (a, b) => b.quotient.quotes.at(-1).at - a.quotient.quotes.at(-1).at
            )[0] ??
          sessions[0];
        const quotes = graded?.quotient.quotes ?? [];
        const ok = Boolean(graded) && solved(graded);
        // Diagnostics for the two likely wrong answers: the FIRST quote's rate
        // (off-by-one) and a division of the rendered total by the lane base
        // (plausible but non-identifying, by the collision property).
        const offByOne =
          !ok && quotes.length >= 1 && rateEq(fields?.rateMultiplier, quotes[0].rate);
        const backComputed =
          !ok &&
          typeof fields?.rateMultiplier === 'number' &&
          quotes.some(
            (q) =>
              Math.round(q.base * fields.rateMultiplier) === q.total &&
              !rateEq(fields.rateMultiplier, q.rate)
          );
        return {
          pass: ok,
          detail:
            `sessions=${sessions.length} quotes=${
              quotes
                .map((q) => `${q.lane}/${q.weight}kg rate=${q.rate} total=${q.total} fromPage=${q.fromPage}`)
                .join('; ') || 'none'
            } offPageQuotes=${graded?.quotient.offPageQuotes ?? 0} ok=${ok} ` +
            `reportedFirstRate=${offByOne} plausibleBackComputation=${backComputed} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
  ];
}
