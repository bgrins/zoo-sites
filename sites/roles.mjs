// pages/roles/ - the Alderpost vacancy desk (faceted-search).
import { randomBytes } from 'node:crypto';

// pages/roles/ — the Alderpost vacancy desk (faceted-search). The catalogue,
// the client brief and every vacancy reference are minted per session from
// randomBytes and hang off session.roles, so state.reset() clears them and no
// fixture file on disk carries a vacancy, a facet count or a reference. The
// draw guarantees the properties the task rests on: exactly one vacancy carries
// all four of the brief's facet values; NO vacancy carries the brief's
// discipline, base and contract in the salary band ABOVE the brief's ceiling,
// so an agent that over-reads the ceiling lands in a genuinely empty result
// set; no vacancy at all sits in the brief's secondary town on that discipline
// and contract, which is the second dead end; and the winning
// discipline/location/contract cluster is one of FOUR clusters of the same
// shape and size, so the brief — not the shape of the catalogue — is the only
// thing that picks the answer out. Facet counts are computed here, drill-down
// style (a facet's own selection is excluded from its own counts), so they
// cannot be derived from the page.
const ROLES_PAGE_SIZE = 10;

const ROLES_CATALOGUE_SIZE = 86;

const ROLES_DECOY_CLUSTERS = 3;

const ROLES_VIA = ['initial', 'url', 'facet', 'page', 'clear', 'history'];

const ROLES_FACETS = {
  discipline: [
    { value: 'structural', label: 'Structural', noun: 'Structural' },
    { value: 'geotechnical', label: 'Geotechnical', noun: 'Geotechnical' },
    { value: 'highways', label: 'Highways and transport', noun: 'Highways' },
    { value: 'services', label: 'Building services', noun: 'Building Services' },
    { value: 'environmental', label: 'Environmental', noun: 'Environmental' },
    { value: 'fire', label: 'Fire engineering', noun: 'Fire Safety' },
  ],
  location: [
    { value: 'leeds', label: 'Leeds' },
    { value: 'manchester', label: 'Manchester' },
    { value: 'bristol', label: 'Bristol' },
    { value: 'glasgow', label: 'Glasgow' },
    { value: 'cardiff', label: 'Cardiff' },
    { value: 'newcastle', label: 'Newcastle' },
  ],
  contract: [
    { value: 'permanent', label: 'Permanent', canBrief: true },
    { value: 'fixed', label: 'Fixed term', canBrief: true },
    { value: 'interim', label: 'Interim', canBrief: true },
    // Never drawn as a brief's contract: a part-time advert is quoted pro rata
    // and would make the salary lines of the brief ambiguous.
    { value: 'parttime', label: 'Part time', canBrief: false },
  ],
  // `low` is where the band's LABEL starts and `floors`/`cap` are what is
  // actually advertised inside it. Every band leaves a gap between its label
  // start and its cheapest advert, which is what lets the brief's ceiling sit
  // inside the label of the band above the winning one while still being under
  // every advert in it. `cap` keeps every advertised range inside its own band,
  // so no vacancy below the winning band can be read as paying the brief's
  // floor and none above it as fitting the ceiling.
  band: [
    { value: 'b1', label: '£30,000 to £40,000', low: 30000, floors: [32000, 34000, 36000], cap: 39000 },
    { value: 'b2', label: '£40,000 to £50,000', low: 40000, floors: [42000, 44000, 46000], cap: 48000 },
    { value: 'b3', label: '£50,000 to £60,000', low: 50000, floors: [52000, 54000, 56000], cap: 58000 },
    { value: 'b4', label: '£60,000 to £75,000', low: 60000, floors: [62000, 64000, 66000, 68000], cap: 74000 },
    { value: 'b5', label: '£75,000 and above', low: 75000, floors: [80000, 82000, 85000, 88000], cap: 0 },
  ],
};

// Which bands may be drawn as the brief's target: b1 is too junior to be a
// client brief and b5 has no band above it to act as the trap.
const ROLES_TARGET_BANDS = [1, 2, 3];

const ROLES_TITLES = {
  b1: ['Graduate {d} Engineer', 'Assistant {d} Engineer'],
  b2: ['{d} Engineer', '{d} Design Engineer'],
  b3: ['Senior {d} Engineer', '{d} Project Engineer'],
  b4: ['Principal {d} Engineer', 'Lead {d} Engineer'],
  b5: ['Associate Director, {d}', 'Head of {d}'],
};

const ROLES_EMPLOYERS = [
  'Brackenhall Consulting', 'Wraysbury Group', 'Denholm and Pike', 'Astley Verge',
  'Kirkstall Partners', 'Ordsall Technical', 'Falgrove Engineers', 'Merrick Dane',
  'Penhaligon Works', 'Southwell Rivett', 'Tarnbrook Associates', 'Vellacourt Group',
  'Ashby Meredith', 'Corstorphine Ltd', 'Drumcree Engineering', 'Elmsfield Partnership',
  'Sedgemoor Consulting', 'Thurlow Technical', 'Inverleith Group', 'Jarrow Kemp',
  'Lowther Bramwell', 'Nithsdale Works', 'Oakhampton Rowe', 'Padstow Ellery',
];

const ROLES_CLIENTS = [
  'Norbeck Water', 'Culverdale Estates', 'Pennine Rail Partnership',
  'Harrowfield Health Trust', 'Stanegate Ports', 'Lyddington Energy',
];

const ROLES_SUMMARIES = {
  structural: 'Frame design and assessment across a mixed commercial and civic workload.',
  geotechnical: 'Ground investigation, slope stability and foundation advice on live sites.',
  highways: 'Junction improvement and active travel schemes from feasibility to handover.',
  services: 'Mechanical and electrical design for refurbishment and new-build schemes.',
  environmental: 'Discharge permitting, flood risk and consenting for infrastructure clients.',
  fire: 'Fire strategy, means of escape and smoke control on complex existing buildings.',
};

// The client's ceiling always overshoots the winning band and lands inside the
// LABEL of the band above it without reaching that band's cheapest advert, so
// the trap is tempting to read off the brief and holds nothing that fits it.
function rolesCeilings(target, trap) {
  const out = [];
  const highest = Math.min(...trap.floors) - 1000;
  for (let v = Math.max(trap.low, target.cap) + 1000; v <= highest; v += 1000) out.push(v);
  return out;
}

function rolesBuildDesk(draw = (_scope, n) => randomBytes(n)) {
  // The desk's whole difficulty draw runs through these, so a seeded run
  // (--seed) reproduces the vacancy board; identifiers stay on randomBytes.
  const rolesInt = (n) => draw('roles', 4).readUInt32BE(0) % n;
  const rolesPick = (list) => list[rolesInt(list.length)];
  const rolesSalary = (bandValue) => {
    const band = ROLES_FACETS.band.find((b) => b.value === bandValue);
    const min = rolesPick(band.floors);
    const spread = band.cap ? rolesPick([4000, 5000, 6000, 7000]) : 14000;
    const top = band.cap ? Math.min(min + spread, band.cap) : min + spread;
    return [min, top];
  };
  const facets = ROLES_FACETS;
  const dT = rolesPick(facets.discipline).value;
  const lT = rolesPick(facets.location).value;
  const cT = rolesPick(facets.contract.filter((c) => c.canBrief)).value;
  const lAdj = rolesPick(facets.location.filter((l) => l.value !== lT)).value;
  // The winning band, the brief's salary line and therefore the trap are drawn
  // per session: nothing about the salary facet is constant across mints, so a
  // model that has seen the task before still has to read the brief.
  const bandAt = rolesPick(ROLES_TARGET_BANDS);
  const targetBand = facets.band[bandAt];
  const trapBand = facets.band[bandAt + 1];
  const ceiling = rolesPick(rolesCeilings(targetBand, trapBand));
  const floor = targetBand.low;
  const months = cT === 'fixed' ? rolesPick([12, 14, 18]) : rolesPick([6, 9, 12]);

  const forbidden = (d, l, c, b) =>
    (d === dT && l === lT && c === cT && (b === targetBand.value || b === trapBand.value)) ||
    (d === dT && l === lAdj && c === cT);

  const postings = [];
  const add = (d, l, c, b) => {
    const disc = facets.discipline.find((x) => x.value === d);
    const [salaryMin, salaryMax] = rolesSalary(b);
    const posting = {
      id: '',
      ref: '',
      title: rolesPick(ROLES_TITLES[b]).replace('{d}', disc.noun),
      employer: rolesPick(ROLES_EMPLOYERS),
      discipline: d,
      location: l,
      contract: c,
      band: b,
      salaryMin,
      salaryMax,
      posted: 1 + rolesInt(27),
      summary: ROLES_SUMMARIES[d],
    };
    postings.push(posting);
    return posting;
  };

  // A cluster is one vacancy in the winning band plus 7-10 more on the same
  // discipline/location/contract in bands that cannot meet the brief's salary
  // line. The brief's own triple is one such cluster and ROLES_DECOY_CLUSTERS
  // others are drawn to the same shape and the same size range, so "group the
  // catalogue by the three labels, take the biggest group, take its dearest
  // advert" — the heuristic that needs no brief at all — returns four
  // candidates that only the brief can tell apart.
  const fillerBands = facets.band
    .map((b) => b.value)
    .filter((b) => b !== targetBand.value && b !== trapBand.value);
  // Each cluster also gets a halo: two more vacancies in the winning band one
  // facet off it on each of the three axes. Dropping any ONE of a cluster's
  // three facets therefore still leaves several rows — the answer cannot be
  // reached on two facets plus the salary band — and the halo is not a
  // signature of the winning cluster, because every cluster has one.
  const halo = (d, l, c) => {
    const axes = [
      () => [rolesPick(facets.discipline.filter((x) => x.value !== d)).value, l, c],
      () => [d, rolesPick(facets.location.filter((x) => x.value !== l)).value, c],
      () => [d, l, rolesPick(facets.contract.filter((x) => x.value !== c)).value],
    ];
    for (const axis of axes) {
      for (let i = 0; i < 2; i++) {
        for (let attempt = 0; attempt < 20; attempt++) {
          const [nd, nl, nc] = axis();
          if (forbidden(nd, nl, nc, targetBand.value)) continue;
          add(nd, nl, nc, targetBand.value);
          break;
        }
      }
    }
  };
  const cluster = (d, l, c) => {
    const head = add(d, l, c, targetBand.value);
    const rest = 7 + rolesInt(4);
    for (let i = 0; i < rest; i++) add(d, l, c, rolesPick(fillerBands));
    halo(d, l, c);
    return head;
  };

  const target = cluster(dT, lT, cT);
  const tripleKey = (d, l, c) => `${d}/${l}/${c}`;
  const seeded = new Set([tripleKey(dT, lT, cT), tripleKey(dT, lAdj, cT)]);
  for (let n = 0; n < ROLES_DECOY_CLUSTERS; n++) {
    let d;
    let l;
    let c;
    do {
      d = rolesPick(facets.discipline).value;
      l = rolesPick(facets.location).value;
      c = rolesPick(facets.contract).value;
    } while (seeded.has(tripleKey(d, l, c)));
    seeded.add(tripleKey(d, l, c));
    cluster(d, l, c);
  }

  // Every facet value must carry at least one vacancy overall, or a value
  // reading 0 would be a hole in the draw rather than a real dead end.
  for (const key of Object.keys(facets)) {
    for (const value of facets[key].map((v) => v.value)) {
      if (postings.some((p) => p[key] === value)) continue;
      for (let attempt = 0; attempt < 200; attempt++) {
        const draw = {
          discipline: rolesPick(facets.discipline).value,
          location: rolesPick(facets.location).value,
          contract: rolesPick(facets.contract).value,
          band: rolesPick(facets.band).value,
        };
        draw[key] = value;
        if (forbidden(draw.discipline, draw.location, draw.contract, draw.band)) continue;
        add(draw.discipline, draw.location, draw.contract, draw.band);
        break;
      }
    }
  }

  let guard = 0;
  while (postings.length < ROLES_CATALOGUE_SIZE && guard++ < 20000) {
    const d = rolesPick(facets.discipline).value;
    const l = rolesPick(facets.location).value;
    const c = rolesPick(facets.contract).value;
    const b = rolesPick(facets.band).value;
    if (forbidden(d, l, c, b)) continue;
    add(d, l, c, b);
  }

  // Ids and references are handed out AFTER the shuffle, so neither sequence
  // betrays which vacancy was seeded first. Both are minted from randomBytes
  // rather than from the index: an id cannot be guessed or walked, so the
  // catalogue is only reachable through the paged search, and an id lifted out
  // of one session 404s in another instead of quietly resolving to a different
  // session's vacancy.
  for (let i = postings.length - 1; i > 0; i--) {
    const j = rolesInt(i + 1);
    [postings[i], postings[j]] = [postings[j], postings[i]];
  }
  const ids = new Set();
  const refs = new Set();
  for (const posting of postings) {
    let id;
    do {
      id = 'alp-' + randomBytes(3).toString('hex');
    } while (ids.has(id));
    ids.add(id);
    posting.id = id;
    let ref;
    do {
      ref = 'AR-' + randomBytes(3).toString('hex').toUpperCase();
    } while (refs.has(ref));
    refs.add(ref);
    posting.ref = ref;
  }
  postings.sort((a, b) => a.posted - b.posted);

  const labelOf = (key, value) =>
    ROLES_FACETS[key].find((v) => v.value === value)?.label ?? value;

  return {
    brief: {
      client: rolesPick(ROLES_CLIENTS),
      discipline: dT,
      disciplineLabel: labelOf('discipline', dT),
      location: lT,
      locationLabel: labelOf('location', lT),
      secondary: lAdj,
      secondaryLabel: labelOf('location', lAdj),
      contract: cT,
      contractLabel:
        cT === 'permanent' ? 'Permanent' : `${labelOf('contract', cT)}, ${months} months`,
      floor,
      ceiling,
      salaryLabel: `£${floor.toLocaleString('en-GB')} to £${ceiling.toLocaleString('en-GB')}`,
    },
    targetId: target.id,
    targetRef: target.ref,
    targetBand: targetBand.value,
    targetBandLabel: targetBand.label,
    trapBand: trapBand.value,
    trapBandLabel: trapBand.label,
    postings,
    searches: [],
    facetApplies: 0,
    urlLoads: 0,
    historyLoads: 0,
    offPageSearches: 0,
    urlNavFilters: 0,
    deadEnds: 0,
    recoveries: 0,
    maxSelected: 0,
    deepestPage: 1,
    opened: [],
    detailOpens: 0,
    offPageOpens: 0,
  };
}

function rolesState(session, draw = (_scope, n) => randomBytes(n)) {
  return (session.roles ??= rolesBuildDesk(draw));
}

function rolesCleanFilters(raw) {
  const out = {};
  for (const key of Object.keys(ROLES_FACETS)) {
    const allowed = ROLES_FACETS[key].map((v) => v.value);
    const given = Array.isArray(raw?.[key]) ? raw[key] : [];
    out[key] = [...new Set(given.filter((v) => allowed.includes(v)))].slice(0, 8);
  }
  return out;
}

function rolesMatches(postings, filters) {
  return postings.filter((p) =>
    Object.keys(ROLES_FACETS).every(
      (key) => filters[key].length === 0 || filters[key].includes(p[key])
    )
  );
}

// Drill-down counts: a facet's own selection is lifted before its values are
// counted, which is what real refine panels show and what lets an agent see
// that "£75,000 and above" would leave nothing before clicking it.
function rolesFacetCounts(postings, filters) {
  const out = {};
  for (const key of Object.keys(ROLES_FACETS)) {
    const pool = rolesMatches(postings, { ...filters, [key]: [] });
    out[key] = ROLES_FACETS[key].map((v) => ({
      value: v.value,
      label: v.label,
      count: pool.filter((p) => p[key] === v.value).length,
    }));
  }
  return out;
}

function rolesRow(posting) {
  return {
    id: posting.id,
    title: posting.title,
    employer: posting.employer,
    location: ROLES_FACETS.location.find((l) => l.value === posting.location).label,
    contract: ROLES_FACETS.contract.find((c) => c.value === posting.contract).label,
    salary: `£${posting.salaryMin.toLocaleString('en-GB')} to £${posting.salaryMax.toLocaleString('en-GB')}`,
    discipline: ROLES_FACETS.discipline.find((d) => d.value === posting.discipline).label,
    posted: posting.posted,
    summary: posting.summary,
  };
}

// Same shape as consoleFromPage: a fetch the desk itself made carries a
// same-origin Sec-Fetch-Site or a /roles/ Referer, so a shell call that holds a
// cookie it minted is separable in the telemetry.
function rolesFromPage(req) {
  return (
    req.headers['sec-fetch-site'] === 'same-origin' || /\/roles\//.test(req.headers.referer ?? '')
  );
}

// A hand-edited address bar is a real document load, so the Referer the BROWSER
// puts on the desk's first fetch carries the filters. Corroborates the
// page-reported `via`, which page script could otherwise say anything about.
function rolesRefererFiltered(req) {
  try {
    const referer = new URL(req.headers.referer ?? '', 'http://localhost');
    return ['d', 'l', 'c', 's'].some((k) => (referer.searchParams.get(k) ?? '') !== '');
  } catch {
    return false;
  }
}

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage, draw } = ctx;
  return async (req, res, url, pathname0) => {
    // pages/roles/ — the Alderpost refine panel. Every search is answered here:
    // the page holds no catalogue, so the result rows AND the drill-down facet
    // counts are server-computed and cannot be derived from fixture source. The
    // counters recorded alongside are route telemetry for the validator's
    // detail line only — `via` is page-reported and a nonce is enough to post
    // any value, so nothing here gates a pass.
    if (req.method === 'POST' && pathname0 === '/api/roles/search') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const desk = rolesState(found.session, draw);
      const filters = rolesCleanFilters(payload?.filters);
      const selected = Object.values(filters).reduce((n, values) => n + values.length, 0);
      const matched = rolesMatches(desk.postings, filters);
      const pages = Math.max(1, Math.ceil(matched.length / ROLES_PAGE_SIZE));
      const page = Math.min(Math.max(1, Math.floor(Number(payload?.page) || 1)), pages);
      const via = ROLES_VIA.includes(payload?.via) ? payload.via : 'other';
      const previous = desk.searches[desk.searches.length - 1] ?? null;
      desk.searches.push({ filters, selected, via, total: matched.length, page });
      if (via === 'facet') desk.facetApplies += 1;
      if (via === 'url') desk.urlLoads += 1;
      if (via === 'history') desk.historyLoads += 1;
      if (!rolesFromPage(req)) desk.offPageSearches += 1;
      if (via === 'url' && rolesRefererFiltered(req)) desk.urlNavFilters += 1;
      if (matched.length === 0) desk.deadEnds += 1;
      if (previous && previous.total === 0 && matched.length > 0 && selected < previous.selected) {
        desk.recoveries += 1;
      }
      desk.maxSelected = Math.max(desk.maxSelected, selected);
      desk.deepestPage = Math.max(desk.deepestPage, page);
      return json(res, 200, {
        brief: desk.brief,
        // The cleaned filter set goes back to the page, which adopts it: a
        // hand-edited address bar carrying a value the desk does not know is
        // then simply never drawn as a chip, rather than showing a filter that
        // is not being applied.
        filters,
        total: matched.length,
        page,
        pages,
        pageSize: ROLES_PAGE_SIZE,
        facets: rolesFacetCounts(desk.postings, filters),
        results: matched
          .slice((page - 1) * ROLES_PAGE_SIZE, page * ROLES_PAGE_SIZE)
          .map(rolesRow),
      });
    }

    // The vacancy record. The reference lives ONLY here, so reporting one is
    // proof the record was opened in this session; `opened` is what the
    // validator grades against.
    if (req.method === 'GET' && pathname0 === '/api/roles/posting') {
      const found = requireSession(req, res);
      if (!found) return;
      const desk = rolesState(found.session, draw);
      const posting = desk.postings.find((p) => p.id === url.searchParams.get('id'));
      if (!posting) return json(res, 404, { error: 'No such vacancy.' });
      desk.detailOpens += 1;
      if (!desk.opened.includes(posting.id)) desk.opened.push(posting.id);
      if (!rolesFromPage(req)) desk.offPageOpens += 1;
      const row = rolesRow(posting);
      return json(res, 200, {
        ...row,
        reference: posting.ref,
        band: ROLES_FACETS.band.find((b) => b.value === posting.band).label,
        detail: [
          `${row.employer} is recruiting a ${row.title.toLowerCase()} for its ${row.location} office.`,
          row.summary,
          'The desk holds the full pack. Candidates are put forward by the consultant named below.',
        ],
        requirements: [
          'Chartered or working towards chartership with a relevant institution.',
          `Recent ${row.discipline.toLowerCase()} experience on comparable schemes.`,
          'Right to work in the UK without sponsorship.',
        ],
        consultant: 'Rhian Doulton, Alderpost desk',
      });
    }

    return false;
  };
}
