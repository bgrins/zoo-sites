// Wayfinding: deep hierarchies, sibling disambiguation, redirect chains, faceted search, and locale editions.
//
// One family of the web suite. tasks/web.mjs concatenates every family; see
// docs/authoring-fixtures.md for the rules a task and its fixture must follow.

import { originUrls } from '../../../manifest.mjs';
import { ANSWERS } from '../../answers.mjs';
import {
  MONTH_NAMES,
  eqCode,
  eqMoney,
  eqTime,
  normalise,
  normaliseDateWords,
  normaliseWords,
  soleCode,
} from '../../extract.mjs';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const RANGE_WORDS = /\b(?:to|through|thru|till?|until)\b/;
// The only marks that may separate two days of a list.
const LIST_MARKS = /^[\s,&/+;:|()[\]'"、・]*$/;
const CLOCK = String.raw`\d{1,2}(?:[:.]?\d{2})?\s*(?:[ap]\.?\s?m\b\.?)?`;
// A time, or a span of two, inside a day item ("Tue & Thu 9:15 AM - 12:45 PM").
const CLOCK_SPAN = new RegExp(`${CLOCK}(?:\\s*(?:-|~|〜|to|till?|until)\\s*${CLOCK})?`, 'g');

// The set of weekdays an extracted list names, however the answer grouped,
// shortened or qualified them: ['Tuesday and Thursday'], ['Tue & Thu 9:15 AM -
// 12:45 PM'], ['Tu', 'Th'] and ['Tuesday mornings', 'Thursday mornings'] all
// name tuesday and thursday. Words that are not days are skipped, and so are
// times. Between two days only a list mark or a word may sit; a range word or
// any other mark ("Tue - Thu", "Tuesday to Thursday", "Tue ~ Thu", "Tue → Thu")
// makes the list unreadable (null), so a range never collapses into its two
// endpoints.
function weekdaysOf(items) {
  if (!Array.isArray(items)) return null;
  const days = new Set();
  for (const item of items) {
    if (typeof item !== 'string') return null;
    const text = item
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[*_`]+/g, '')
      .replace(/[‐-―−]/g, '-')
      .replace(/\d+(?:st|nd|rd|th)\b/g, ' ')
      .replace(CLOCK_SPAN, ' ')
      .replace(/([a-z])\.(?!\.)/g, '$1');
    // What sits between the previous day and this part; null before the first day.
    let gap = null;
    for (const [part] of text.matchAll(/[a-z]+|[^a-z]+/g)) {
      const stem = part.replace(/s$/, '');
      const day =
        /^[a-z]/.test(part) &&
        stem.length >= 2 &&
        WEEKDAYS.find((d) => d.startsWith(part) || d.startsWith(stem));
      if (!day) {
        if (gap !== null) gap += /^[a-z]/.test(part) ? ` ${part} ` : part;
        continue;
      }
      if (gap !== null && (RANGE_WORDS.test(gap) || !LIST_MARKS.test(gap.replace(/[a-z0-9]+/g, ' ')))) {
        return null;
      }
      days.add(day);
      gap = '';
    }
  }
  return days;
}

// Telemetry for the gov page gates: page-view beacons for `path` whose POST
// carried neither the browser's same-origin fetch metadata nor a Referer.
const beaconsOffPage = (sessions, path) =>
  sessions.reduce(
    (n, s) => n + (s.govViews ?? []).filter((v) => v.path === path && v.fromPage === false).length,
    0
  );

export async function navigationTasks(base, origins = originUrls(base)) {
  return [
    {
      id: 'gov-lookup',
      truth: { kind: 'static', reason: 'the deadline and instructions URL are published page content' },
      ask:
        `Open ${origins['civic-revenue']}/ — a government agency site. Find the annual filing deadline ` +
        `for Form RV-7 and the URL of the RV-7 instructions page. Report both.`,
      answerSchema: {
        type: 'object',
        properties: {
          filingDeadline: {
            type: ['string', 'null'],
            description: 'the annual filing deadline as stated, e.g. a month and day',
          },
          instructionsUrl: { type: ['string', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        // Month and day must sit next to each other, in either order, so "June
        // 12" and "12 June" both name it and "May 12 to June 30" does not; the
        // shared fold turns "June 12th" and "Jun 12" into the same tokens.
        const [month, day] = normaliseDateWords(ANSWERS.gov.deadline).trim().split(' ');
        const d = normaliseDateWords(fields?.filingDeadline ?? '');
        const dateOk = d.includes(` ${month} ${day} `) || d.includes(` ${day} ${month} `);
        const urlOk =
          typeof fields?.instructionsUrl === 'string' &&
          fields.instructionsUrl.toLowerCase().includes(ANSWERS.gov.instructionsPath);
        return {
          pass: dateOk && urlOk,
          detail: `dateOk=${dateOk} urlOk=${urlOk} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'fee-schedule',
      truth: { kind: 'static', reason: 'the fee table is published page content' },
      ask:
        `Open ${origins['civic-revenue']}/fee-schedule.html — an agency fee schedule. According to the ` +
        `schedule, what is the total fee in dollars for filing Form RV-7 two months ` +
        `late? Include the base fee and any applicable late surcharge, and report a ` +
        `single dollar amount.`,
      answerSchema: {
        type: 'object',
        properties: {
          totalFee: {
            type: ['number', 'null'],
            description: 'the single total dollar amount, base fee plus surcharge',
          },
        },
      },
      validate: (text, ctx, fields) => {
        const total = eqMoney(fields?.totalFee, Number(ANSWERS.gov.rv7LateTotal));
        return { pass: total, detail: `total=${total} fields=${JSON.stringify(fields)}` };
      },
    },
    {
      id: 'dept-descent',
      tier: 'long',
      ask:
        `Open ${origins['civic-revenue']}/departments/ — the Bureau's department directory. Somewhere ` +
        `under it is the Subsurface Permits desk. Navigate the directory to that desk's ` +
        `own page and report its public counter hours: the days it is open and the ` +
        `opening and closing times.`,
      answerSchema: {
        type: 'object',
        properties: {
          daysOpen: {
            type: 'array',
            description: 'the days the counter is open',
            items: { type: ['string', 'null'], description: 'a weekday name' },
          },
          opensAt: { type: ['string', 'null'] },
          closesAt: { type: ['string', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        const g = ANSWERS.govNav;
        const sessions = [...ctx.pages.state.sessions.values()];
        // Two server-observed factors on ONE session: the static handler recorded
        // a document navigation to the desk path (path taken from the request, so
        // it cannot be claimed), and a page-view beacon carried the per-path token
        // the server substituted into the body it served. sec-fetch-* is a
        // forbidden header for fetch(), so the record rules out an in-page fetch,
        // but `curl -H` sets it freely and the same shell can scrape the token and
        // post the beacon: the pair proves a navigation-shaped request whose body
        // reached a cookie holder, not a rendering browser, and beaconsOffPage in
        // detail shows a beacon sent without the browser's fetch metadata. It is
        // also what makes the near-miss desks ("Subsurface Utility Notices" in
        // another division) an auto-fail: different path, different hours.
        const navHit = (s) => (s.govNav ?? []).some((n) => n.path === g.deskPath);
        const viewHit = (s) => (s.govViews ?? []).some((v) => v.path === g.deskPath);
        const winners = sessions.filter((s) => navHit(s) && viewHit(s));
        // Telemetry: a navigation record with no matching beacon is what a
        // forged-header request that never posted the beacon leaves behind.
        const navOnly = sessions.filter((s) => navHit(s) && !viewHit(s)).length;
        // The ask is to navigate the directory to the desk, so every index page
        // above the desk must have been requested during the run, in some
        // session. htmlGets is every HTML GET a session made, so a request from
        // in-page script counts, and so does one from a shell: curl with no
        // cookie jar mints a session per request, and a scripted crawl of the
        // directory is a route the eval measures rather than fails. What fails
        // is a desk reached with no walk at all, such as a URL lifted from grep
        // of pages/.
        const tree = g.deskPath.split('/').slice(2, -1);
        const ancestors = tree.map((_, i) => `/gov/${tree.slice(0, i + 1).join('/')}/index.html`);
        const fetched = (s, a) => (s.htmlGets?.[a] ?? 0) > 0;
        const descended = ancestors.every((a) => sessions.some((s) => fetched(s, a)));
        // Telemetry: whether the session that visited the desk walked the tree
        // itself, or the walk came from other cookies.
        const descent = !descended
          ? 'none'
          : winners.some((s) => ancestors.every((a) => fetched(s, a)))
            ? 'one-session'
            : 'cross-session';
        const want = g.subsurfaceHours;
        const open = eqTime(fields?.opensAt, want.opens);
        const close = eqTime(fields?.closesAt, want.closes);
        const gotDays = weekdaysOf(fields?.daysOpen);
        const days =
          !!gotDays && gotDays.size === want.days.length && want.days.every((d) => gotDays.has(d));
        // Telemetry: every directory page the run opened, detours included.
        const walked = sessions.reduce(
          (n, s) =>
            n + (s.govNav ?? []).filter((x) => x.path.startsWith('/gov/departments/')).length,
          0
        );
        return {
          pass: winners.length > 0 && descended && open && close && days,
          detail:
            `deskVisits=${winners.length} descent=${descent} navWithoutPageJs=${navOnly} ` +
            `beaconsOffPage=${beaconsOffPage(sessions, g.deskPath)} ` +
            `open=${open} close=${close} days=${days} treePagesOpened=${walked} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'breadcrumb-sibling',
      ask:
        `Open ${origins['civic-revenue']}${ANSWERS.govNav.deskPath.replace(/^\/gov/, '')} — the Subsurface Permits desk in the ` +
        `Bureau's department directory. Its sibling desk in the same section is Surface ` +
        `Permits. Navigate to the Surface Permits desk's own page (the breadcrumbs may ` +
        `help) and report that desk's telephone number.`,
      answerSchema: {
        type: 'object',
        properties: {
          telephoneNumber: {
            type: ['string', 'null'],
            description: "the Surface Permits desk's telephone number",
          },
        },
      },
      validate: (rawText, ctx, fields) => {
        const g = ANSWERS.govNav;
        const sessions = [...ctx.pages.state.sessions.values()];
        const navHit = (s) => (s.govNav ?? []).some((n) => n.path === g.siblingPath);
        const viewHit = (s) => (s.govViews ?? []).some((v) => v.path === g.siblingPath);
        const winners = sessions.filter((s) => navHit(s) && viewHit(s));
        const navOnly = sessions.filter((s) => navHit(s) && !viewHit(s)).length;
        // Swapped attribution was the failure mode this task exists to catch;
        // the field names the target desk by construction, so handing the
        // start desk's number to the target is a wrong VALUE (the decoy digits
        // fail numerically) and the per-clause machinery is gone.
        // The seven local digits, so the area code is optional.
        const local = (phone) => phone.replace(/\D/g, '').slice(-7);
        const digits = String(fields?.telephoneNumber ?? '').replace(/\D/g, '');
        const wanted = digits.includes(local(g.surfacePhone));
        const decoy = digits.includes(local(g.subsurfacePhone));
        // Efficiency only, never scored: a session that walked back to the
        // directory root took the long way round instead of using breadcrumbs.
        const viaRoot = sessions.some((s) =>
          (s.govNav ?? []).some((n) => n.path === '/gov/departments/index.html')
        );
        return {
          pass: winners.length > 0 && wanted && !decoy,
          detail:
            `siblingVisits=${winners.length} navWithoutPageJs=${navOnly} ` +
            `beaconsOffPage=${beaconsOffPage(sessions, g.siblingPath)} hasNumber=${wanted} ` +
            `decoy=${decoy} viaDirectoryRoot=${viaRoot} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'search-decoy',
      ask:
        `Open ${origins['civic-revenue']}/ and use the site search to find the mailing address for ` +
        `submitting Form RV-7 (careful: NOT Form RV-7A — they are different forms and ` +
        `they do not share an address). Report the full mailing address.`,
      answerSchema: {
        type: 'object',
        properties: {
          mailingAddress: {
            type: ['string', 'null'],
            description:
              'the full mailing address for submitting Form RV-7, the address only: leave out ' +
              'any remark about another form or its address',
          },
        },
      },
      validate: (rawText, ctx, fields) => {
        const sessions = [...ctx.pages.state.sessions.values()];
        const searched = (s) => (s.govSearches ?? []).length > 0;
        const opened = (s) =>
          (s.govNav ?? []).some((n) => n.path === '/gov/rv7-instructions.html') &&
          (s.govViews ?? []).some((v) => v.path === '/gov/rv7-instructions.html');
        // Prefer the session that did BOTH — the house rule is to grade the
        // session that completed the flow. The cross-session fallback only exists
        // for a cookie re-minted mid-task, and `detail` says which branch fired so
        // a split pass is visible in the results.
        const searches = sessions.reduce((n, s) => n + (s.govSearches ?? []).length, 0);
        const openedTruth = sessions.filter(opened);
        const gate = sessions.some((s) => searched(s) && opened(s))
          ? 'one-session'
          : searches > 0 && openedTruth.length > 0
            ? 'cross-session'
            : 'none';
        const openedDecoy = sessions.filter((s) =>
          (s.govNav ?? []).some((n) => n.path === '/gov/rv7a-instructions.html')
        );
        // The field is RV-7's address by construction, so the swap this task
        // measures (handing RV-7 the annex box) is a wrong VALUE and the
        // per-clause attribution machinery is gone. "PO Box 4410", "P.O. Box
        // 4410" and "Box 4410" all count, with the station the ask's "full"
        // address needs; any part of the RV-7A address, its unit included, fails.
        const g = ANSWERS.govNav;
        const addr = normaliseWords(fields?.mailingAddress ?? '');
        const box = new RegExp(`(?<!\\d)${g.rv7Box}(?!\\d)`).test(addr) && addr.includes(' box ');
        const station = addr.includes(normaliseWords(g.rv7Station));
        const decoyAddr = g.rv7aDecoyWords.some((w) => addr.includes(normaliseWords(w)));
        return {
          pass: gate !== 'none' && box && station && !decoyAddr,
          detail:
            `gate=${gate} searches=${searches} openedRV7Instructions=${openedTruth.length} ` +
            `openedRV7A=${openedDecoy.length} ` +
            `beaconsOffPage=${beaconsOffPage(sessions, '/gov/rv7-instructions.html')} ` +
            `hasBox=${box} hasStation=${station} ` +
            `decoyAddr=${decoyAddr} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'redirect-escape',
      ask:
        `Open ${origins['civic-revenue']}/forms.html and retrieve the archived Form RV-3 page through ` +
        `the legacy archive link in the forms table (that old address is unreliable). ` +
        `Report the revision date shown on the archived page.`,
      answerSchema: {
        type: 'object',
        properties: {
          revisionDate: { type: ['string', 'null'], description: 'the revision date shown' },
        },
      },
      validate: (rawText, ctx, fields) => {
        const sessions = [...ctx.pages.state.sessions.values()];
        // rv3.hits is incremented only by the server's ?v=2 branch, and that
        // branch serves the archive only to a session that has already been
        // through the loop and been handed the notice, and only for a document
        // navigation. So the loop is load-bearing: a cold `?v=2` guess (or an
        // in-page fetch of it) gets a 409 and is counted in rv3.cold instead.
        // Interstitials are re-checked here so the gate does not rest on the
        // ordering inside one server branch.
        const served = sessions.filter(
          (s) => (s.rv3?.hits ?? 0) > 0 && (s.rv3?.interstitials ?? 0) > 0
        );
        const bounces = sessions.reduce((n, s) => n + (s.rv3?.bounces ?? 0), 0);
        const notices = sessions.reduce((n, s) => n + (s.rv3?.interstitials ?? 0), 0);
        const cold = sessions.reduce((n, s) => n + (s.rv3?.cold ?? 0), 0);
        // "11/2019", "2019-11", "Nov 2019" and "November 2019" name the same
        // revision. The claim is each month bound to the revision year: named
        // or numbered just before it, named with a day between ("March 11,
        // 2019"), or numbered just after it ("2019-11"). Every one must be the
        // right month, so "March 11, 2019" and a hedge between two 2019 months
        // fail, and so does "3/11/2019", where either number could be the
        // month; a month bound to another year ("supersedes Mar 2017") is not
        // the claim. The form number the ask names is dropped first, so the 3
        // in "RV-3, 11/2019" or "RV-3 11 2019" is never read as a day.
        const [mm, yyyy] = ANSWERS.govNav.rv3Revision.split('/').map(Number);
        const raw = String(fields?.revisionDate ?? '')
          .normalize('NFKC')
          .replace(/[‐-―−]/g, '-')
          .replace(/(?<![A-Za-z0-9])RV[\s-]*3(?!\d)/gi, ' ');
        const words = normaliseDateWords(raw).trim().split(' ');
        const named = (w) => MONTH_NAMES.indexOf(w) + 1 || null;
        const num = (w) => (/^\d{1,2}$/.test(w ?? '') ? Number(w) : null);
        const monthNum = (w) => (num(w) >= 1 && num(w) <= 12 ? num(w) : null);
        const bound = words.flatMap((w, i) => {
          if (w !== String(yyyy)) return [];
          const [before2, before, after] = [words[i - 2], words[i - 1], words[i + 1]];
          if (named(before)) return [named(before)];
          if (num(before) && named(before2)) return [named(before2)];
          if (monthNum(before)) return [monthNum(before2) ? NaN : monthNum(before)];
          return monthNum(after) ? [monthNum(after)] : [];
        });
        const rev = bound.length > 0 && bound.every((m) => m === mm);
        return {
          pass: served.length > 0 && rev,
          detail:
            `archiveServed=${served.length} bounces=${bounces} notices=${notices} ` +
            `coldAttempts=${cold} rev=${rev} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'handbook',
      truth: { kind: 'static', reason: 'section 22 is published page content' },
      ask:
        `Open ${origins['civic-revenue']}/handbook.html — an agency's 30-section compliance handbook. ` +
        `Per section 22, what is the retention period for FIELD AUDIT LOGS? Report the period.`,
      answerSchema: {
        type: 'object',
        properties: {
          retentionYears: {
            type: ['number', 'null'],
            description: 'the retention period in years, as a number',
          },
        },
      },
      validate: (text, ctx, fields) => ({
        pass: fields?.retentionYears === ANSWERS.gov.handbookRetentionYears,
        detail: `fields=${JSON.stringify(fields)}`,
      }),
    },
    {
      id: 'iframe-schedule',
      truth: { kind: 'static', reason: 'the embedded schedule is published page content' },
      ask:
        `Open ${origins['civic-revenue']}/offices.html — an agency's office locations page, which embeds ` +
        `a weekly schedule widget. What are the THURSDAY hours of the Harborview satellite ` +
        `office, per the embedded schedule? Report the opening and closing times.`,
      answerSchema: {
        type: 'object',
        properties: {
          opensAt: { type: ['string', 'null'] },
          closesAt: { type: ['string', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        const want = ANSWERS.gov.harborviewThursday;
        const opensOk = eqTime(fields?.opensAt, want.opens);
        const closesOk = eqTime(fields?.closesAt, want.closes);
        return {
          pass: opensOk && closesOk,
          detail: `opensOk=${opensOk} closesOk=${closesOk} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'faceted-search',
      ask:
        `Open ${origins.alderpost}/ — the Alderpost vacancy desk. The Live brief panel on ` +
        `that page sets out what one client is looking for, and exactly one vacancy ` +
        `on the desk meets every line of it. Work out which one and report its ` +
        `Alderpost reference. Every value in the Refine panel carries the number of ` +
        `vacancies it would leave, and a reference is only ever shown on a vacancy's ` +
        `own record.`,
      answerSchema: {
        type: 'object',
        properties: {
          reference: { type: ['string', 'null'], description: 'the reference on the matching vacancy record' },
        },
      },
      validate: (rawText, ctx, fields) => {
        // A reported reference turns up as **AR-4149B7**, AR–4149B7 and
        // "Reference AR-4149B7" alike; eqCode folds the first two and soleCode
        // takes the code out of the third.
        const claimed = soleCode(fields?.reference, ANSWERS.facetedSearch.referencePattern);
        const cites = (ref) => !!ref && eqCode(claimed, ref);
        const desks = [...ctx.pages.state.sessions.values()].map((s) => s.roles).filter(Boolean);
        // Every session mints its OWN catalogue, brief and references, so a curl
        // probe and the browser run are graded against different ground truth.
        // Grade the session whose reference the answer actually quotes, then the
        // one that opened its own target record, then the one that worked the
        // refine panel hardest — so a run that never got there still reports its
        // route instead of an empty detail line.
        const graded =
          desks.find((d) => cites(d.targetRef)) ??
          desks.filter((d) => d.opened.includes(d.targetId)).at(-1) ??
          [...desks].sort((a, b) => b.searches.length - a.searches.length)[0] ??
          null;
        // `opened` is written only by GET /api/roles/posting, which is the only
        // place a reference exists at all: it is minted from randomBytes, is not
        // derivable from the page nonce, and appears in no fixture file. A
        // forged /api/beacon cannot set it.
        const openedTarget = !!graded && graded.opened.includes(graded.targetId);
        const reported = !!graded && cites(graded.targetRef);
        // The field is the single claimed reference, so the shotgun/targetLast
        // machinery (which rejects normal reviewing prose) is unrepresentable:
        // quoting rejected references in prose costs nothing, claiming one as the
        // answer is a wrong value. References are unique per desk, so `reported`
        // already excludes a decoy; this conjunct is defence in depth that names
        // the decoy in `detail`.
        const decoyClaimed = graded
          ? graded.postings.filter((p) => p.id !== graded.targetId && cites(p.ref)).map((p) => p.ref)
          : [];
        const searches = graded?.searches ?? [];
        const route = !graded
          ? 'none'
          : graded.facetApplies > 0 && graded.urlLoads > 0
            ? 'facets+url'
            : graded.facetApplies > 0
              ? 'facets'
              : graded.urlLoads > 0
                ? 'url-edited'
                : graded.offPageSearches >= searches.length && searches.length > 0
                  ? 'api-only'
                  : searches.length > 0
                    ? 'unfiltered'
                    : 'no-search';
        const brief = graded?.brief ?? null;
        // The drill-down counts show what a value would leave BEFORE it is
        // ticked, so a careful run never has to enter the salary dead end. This
        // separates "read the counts and stepped around the trap" from "never
        // reached the salary facet at all", which deadEnds=0 alone conflates.
        const bandSearches = searches.filter((s) => s.filters.band.length > 0);
        const trapTicked = bandSearches.some((s) => s.filters.band.includes(graded?.trapBand));
        const avoidedTrap = bandSearches.length > 0 && !trapTicked;
        const lastEmpty = searches
          .filter((s) => s.total === 0)
          .slice(-3)
          .map((s) =>
            Object.entries(s.filters)
              .filter(([, values]) => values.length)
              .map(([key, values]) => `${key}=${values.join('+')}`)
              .join(',')
          );
        return {
          pass: openedTarget && reported && decoyClaimed.length === 0,
          detail:
            `sessions=${desks.length} ` +
            `brief=${brief ? `${brief.discipline}/${brief.location}/${brief.contract}/${brief.floor}-${brief.ceiling} (also ${brief.secondary})` : 'none'} ` +
            `bands=${graded?.targetBand ?? 'none'}/trap=${graded?.trapBand ?? 'none'} ` +
            `target=${graded?.targetId ?? 'none'} ref=${graded?.targetRef ?? 'none'} ` +
            `openedTarget=${openedTarget} reported=${reported} ` +
            `decoyClaimed=${decoyClaimed.join(',') || 'none'} fields=${JSON.stringify(fields)} ` +
            `route=${route} searches=${searches.length} ` +
            `facetApplies=${graded?.facetApplies ?? 0} urlLoads=${graded?.urlLoads ?? 0} ` +
            `historyLoads=${graded?.historyLoads ?? 0} ` +
            `offPageSearches=${graded?.offPageSearches ?? 0} ` +
            `urlNavFilters=${graded?.urlNavFilters ?? 0} ` +
            `deadEnds=${graded?.deadEnds ?? 0} recoveries=${graded?.recoveries ?? 0} ` +
            `salaryFacet=${bandSearches.length} avoidedTrap=${avoidedTrap} ` +
            `maxFacets=${graded?.maxSelected ?? 0} deepestPage=${graded?.deepestPage ?? 1} ` +
            `recordsOpened=${graded?.opened.length ?? 0}/${graded?.detailOpens ?? 0} ` +
            `offPageOpens=${graded?.offPageOpens ?? 0} ` +
            `lastEmpty=[${lastEmpty.join(' | ')}]`,
        };
      },
    },
    {
      id: 'locale-notice',
      ask:
        `Two colleagues arrive at Port Vasiri by sea next Tuesday. Using the Qandara ` +
        `Travel Advisory Authority site at ${origins['qandara-taa']}/, tell me what applies to ` +
        `arrivals at Port Vasiri right now beyond the standing advisory level, and quote ` +
        `the advisory reference of the notice you are relying on.`,
      answerSchema: {
        type: 'object',
        properties: {
          advisoryReference: { type: ['string', 'null'] },
          requirement: {
            type: ['string', 'null'],
            description:
              'what applies beyond the standing advisory level, quoted from the ' +
              'answer. null ONLY if the answer concludes that nothing further ' +
              'applies: an answer reporting a requirement found in another ' +
              'language edition states a requirement, even if it notes the ' +
              'English page shows none',
          },
          seaArrivalsNeedPermit: {
            type: ['boolean', 'null'],
            description:
              'true if the answer says travellers arriving by sea need an entry ' +
              'permit or other clearance from the harbour or port office before ' +
              'they arrive; false if it says arrivals by sea need none; null if it ' +
              'does not say',
          },
        },
      },
      validate: (text, ctx, fields) => {
        const dest = ANSWERS.localeNotice.dest;
        const sessions = [...ctx.pages.state.sessions.values()];
        const sum = (pick) => sessions.reduce((n, s) => n + (s.intl ? pick(s.intl) : 0), 0);
        const editions = ['en', 'ar', 'ja']
          .map((l) => `${l}=${sum((i) => i.requests[l])}req/${sum((i) => i.editionNavs[l])}nav`)
          .join(' ');
        // Server-observed gate: /api/intl/notices releases a Port Vasiri notice only
        // to a session that really navigated into a translated edition, so this list
        // is empty for an agent that never left the English pages. Beacons are not
        // used — POST /api/beacon takes an arbitrary kind and would be forgeable.
        const releases = sessions
          .flatMap((s) =>
            (s.intl?.releases ?? [])
              .filter((r) => r.dest === dest && r.locale !== 'en')
              .map((r) => ({ ...r, refs: s.intl.refs }))
          )
          .sort((a, b) => b.at - a.at);
        if (!releases.length) {
          return {
            pass: false,
            detail:
              `no session was ever served the translated Port Vasiri notice ` +
              `(sessions=${sessions.length} ${editions})`,
          };
        }
        // Grade the release the ANSWER names. Several sessions can exist in one run
        // (a curl probe, a re-minted cookie), and an agent that re-checks its work
        // afterwards leaves a newer release carrying a different reference; fall
        // back to the newest so an answer with no reference still reports one.
        // The reference is copied out of RTL or Japanese text, so it arrives with
        // bidi marks, fullwidth hyphens or Arabic-Indic digits; eqCode folds
        // those, and soleCode takes it out of "المرجع: QTA-2026-1A2B".
        const claimed = soleCode(fields?.advisoryReference, ANSWERS.localeNotice.referencePattern);
        const carries = (ref) => eqCode(claimed, ref);
        const record = releases.find((r) => carries(r.reference)) ?? releases[0];
        const refOk = carries(record.reference);
        // The one wrong answer this task must not hand out is "nothing applies
        // beyond the standing advisory". The colleagues arrive by sea, so the
        // claim graded is the one the notice makes about sea arrivals, as its
        // own field: a keyword test over the requirement passed "no permit is
        // needed" and the notice's own air/sea clause swapped.
        const requirement = String(fields?.requirement ?? '');
        const requirementOk = requirement.length > 0 && fields?.seaArrivalsNeedPermit === true;
        // Telemetry: whether the prose mentions the permit or the 72 hours, so a
        // run whose extraction nulled the sea-arrival claim is visible as such.
        const prose = normalise(text);
        // Telemetry too, since refOk already fails it. Every destination's
        // reference is minted at session start, so this list is populated whether
        // or not the agent ever opened the other destination and the signal below
        // means what it says. With the reference a single claimed field, quoting
        // another destination's reference in prose costs nothing; CLAIMING one is
        // a wrong value.
        const decoys = Object.entries(record.refs)
          .filter(([d]) => d !== dest)
          .map(([, ref]) => ref);
        const detail =
          `reference=${record.reference} readIn=${record.locale} ` +
          `translatedReads=${releases.length} ` +
          `localesRead=${[...new Set(releases.map((r) => r.locale))].join('+')} ` +
          `${editions} sessions=${sessions.length} answerCarriesReference=${refOk} ` +
          `seaArrivalsNeedPermit=${fields?.seaArrivalsNeedPermit ?? null} ` +
          `mentions72Hours=${/(^|[^\d])72([^\d]|$)/.test(prose)} ` +
          `mentionsPermit=${/permit|licen[cs]e|authoris|authoriz|clearance/.test(prose)} ` +
          `namesAnotherDestinationsReference=${decoys.some((ref) => carries(ref))}`;
        if (!refOk) {
          return {
            pass: false,
            detail: `answer does not carry the advisory reference — ${detail}`,
          };
        }
        if (!requirementOk) {
          return {
            pass: false,
            detail: `answer does not state the requirement beyond the standing advisory — ${detail}`,
          };
        }
        return { pass: true, detail };
      },
    },
  ];
}
