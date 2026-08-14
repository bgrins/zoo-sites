// Wayfinding: deep hierarchies, sibling disambiguation, redirect chains, faceted search, and locale editions.
//
// One family of the web suite. tasks/web.mjs concatenates every family; see
// docs/authoring-fixtures.md for the rules a task and its fixture must follow.

import { originUrls } from '../../../manifest.mjs';
import { ANSWERS } from '../../answers.mjs';
import {
  eqCode,
  eqMoney,
  eqTime,
  normalise,
  normaliseDateWords,
  normaliseWords,
} from '../../extract.mjs';

export async function navigationTasks(base, origins = originUrls(base)) {
  return [
    {
      id: 'gov-lookup',
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
        // Date compared by tokens so "June 12" and "12 June" both name it, and
        // through the shared ordinal fold so "June 12th" does too.
        const d = normaliseDateWords(fields?.filingDeadline ?? '');
        const dateOk = d.includes(' june ') && d.includes(' 12 ');
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
        // it cannot be claimed), and that page's own script posted the per-path
        // token the server substituted into the body it served. sec-fetch-* is a
        // forbidden header for fetch() but `curl -H` sets it freely, so the
        // navigation record alone proves only "not an in-page fetch"; the pair is
        // the repo's live-session baseline (cookie + nonce + per-page token). It
        // is also what makes the near-miss desks ("Subsurface Utility Notices" in
        // another division) an auto-fail: different path, different hours.
        const navHit = (s) => (s.govNav ?? []).some((n) => n.path === g.deskPath);
        const viewHit = (s) => (s.govViews ?? []).some((v) => v.path === g.deskPath);
        const winners = sessions.filter((s) => navHit(s) && viewHit(s));
        // A navigation record with no matching beacon is the signature of a
        // forged-header request; reported so a suspicious pass is visible.
        const navOnly = sessions.filter((s) => navHit(s) && !viewHit(s)).length;
        // "Tuesday and Thursday" and "Tue & Thu" are the same right answer;
        // eqTime handles the European dot notation.
        const open = eqTime(fields?.opensAt, '9:15am');
        const close = eqTime(fields?.closesAt, '12:45pm');
        const gotDays = Array.isArray(fields?.daysOpen) ? fields.daysOpen : [];
        const hasDay = (prefix) =>
          gotDays.some((d) => typeof d === 'string' && normalise(d).startsWith(prefix));
        const days = gotDays.length === 2 && hasDay('tue') && hasDay('thu');
        const walked = sessions.reduce(
          (n, s) =>
            n + (s.govNav ?? []).filter((x) => x.path.startsWith('/gov/departments/')).length,
          0
        );
        return {
          pass: winners.length > 0 && open && close && days,
          detail:
            `deskVisits=${winners.length} navWithoutPageJs=${navOnly} open=${open} ` +
            `close=${close} days=${days} treePagesOpened=${walked} ` +
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
        const digits = String(fields?.telephoneNumber ?? '').replace(/\D/g, '');
        const wanted = digits.includes('0148862');
        const decoy = digits.includes('0143391');
        // Efficiency only, never scored: a session that walked back to the
        // directory root took the long way round instead of using breadcrumbs.
        const viaRoot = sessions.some((s) =>
          (s.govNav ?? []).some((n) => n.path === '/gov/departments/index.html')
        );
        return {
          pass: winners.length > 0 && wanted && !decoy,
          detail:
            `siblingVisits=${winners.length} navWithoutPageJs=${navOnly} has8862=${wanted} ` +
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
            description: 'the full mailing address for submitting Form RV-7',
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
        // 4410" and "Box 4410" all count; the annex box fails.
        const addr = normaliseWords(fields?.mailingAddress ?? '');
        const box = /(?<!\d)4410(?!\d)/.test(addr) && addr.includes(' box ');
        const decoyAddr = / box 7 a | box 7a |substation annex/.test(addr);
        return {
          pass: gate !== 'none' && box && !decoyAddr,
          detail:
            `gate=${gate} searches=${searches} openedRV7Instructions=${openedTruth.length} ` +
            `openedRV7A=${openedDecoy.length} hasBox4410=${box} decoyAddr=${decoyAddr} ` +
            `fields=${JSON.stringify(fields)}`,
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
        // "11/2019" and "November 2019" name the same revision.
        const d = normaliseWords(fields?.revisionDate ?? '');
        const rev = d.includes(' 2019 ') && (d.includes(' 11 ') || d.includes(' nov ') || d.includes(' november '));
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
        pass: fields?.retentionYears === 7,
        detail: `fields=${JSON.stringify(fields)}`,
      }),
    },
    {
      id: 'iframe-schedule',
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
        const opensOk = eqTime(fields?.opensAt, '10:00am');
        const closesOk = eqTime(fields?.closesAt, '6:30pm');
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
        // Emphasis marks stripped and the Unicode dash family folded, because a
        // reported reference turns up as **AR-4149B7** and AR–4149B7 alike.
        const text = rawText
          .replace(/[*_~`\\]+/g, '')
          .replace(/[\u2010-\u2015\u2212\u00ad]/g, '-')
          .replace(/[\u200b-\u200d\u2060\ufeff]/g, '');
        const cites = (ref) => !!ref && eqCode(fields?.reference, ref);
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
        // answer is a wrong value.
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
        },
      },
      validate: (text, ctx, fields) => {
        // Strip markdown emphasis and fold the unicode dash family onto '-', so a
        // prettified reference still reads as the reference it is. This answer is
        // copied out of an RTL run or out of Japanese text, so the reference token
        // itself routinely picks up a bidi mark, a zero-width space, a fullwidth
        // hyphen or Arabic-Indic digits on the way out — none of which change what
        // the agent read.
        const clean = String(text)
          .replace(/[*_~`]+/g, '')
          .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '')
          .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, '-')
          .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
          .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
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
              .filter((r) => r.dest === 'port-vasiri' && r.locale !== 'en')
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
        const cleanRef = (v) =>
          String(v ?? '')
            .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '')
            .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
            .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
        const carries = (ref) => eqCode(cleanRef(fields?.advisoryReference), ref);
        const record = releases.find((r) => carries(r.reference)) ?? releases[0];
        const refOk = carries(record.reference);
        // The one wrong answer this task must not hand out is "nothing applies
        // beyond the standing advisory".
        const requirement = String(fields?.requirement ?? '');
        const requirementOk =
          requirement.length > 0 &&
          (/(^|[^\d])72([^\d]|$)/.test(requirement) ||
            /permit|licen[cs]e|authoris|authoriz|clearance/i.test(requirement));
        // Every destination's reference is minted at session start, so this list is
        // populated whether or not the agent ever opened the other destination
        // and the signal below means what it says. With the reference a single
        // claimed field, quoting another destination's reference in prose costs
        // nothing; CLAIMING one is a wrong value.
        const decoys = Object.entries(record.refs)
          .filter(([dest]) => dest !== 'port-vasiri')
          .map(([, ref]) => ref);
        const detail =
          `reference=${record.reference} readIn=${record.locale} ` +
          `translatedReads=${releases.length} ` +
          `localesRead=${[...new Set(releases.map((r) => r.locale))].join('+')} ` +
          `${editions} sessions=${sessions.length} answerCarriesReference=${refOk} ` +
          `mentions72Hours=${/(^|[^\d])72([^\d]|$)/.test(clean)} ` +
          `mentionsPermit=${/permit|licen[cs]e|authoris|authoriz|clearance/i.test(clean)} ` +
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
