// Origin manifest: one entry per simulated ORIGIN. The dir is the pages/
// subtree served at that origin's root in multi-origin mode. Each port is
// 8100 + the entry's array index, and the_zoo publishes those ports, so the
// list is append-only: never reorder it, insert mid-list or renumber a port.
// The array is therefore not in key order. scripts/check-fixtures.mjs holds
// each port to 8100 + index, and each domain:port pair in the committed
// docker/zoo-snippet.yaml to its published value, so a move fails there unless
// the snippet is regenerated with it. Single-origin mode, the default, serves
// each dir under its own path prefix and still reads this file: server.mjs
// builds its dev index and the __ORIGIN_<KEY>__ tokens from it, and
// originUrls() below builds task URLs.
// The forms/<brand> dirs arrived with the forms split; before that, those
// origins served empty roots in origin mode.

export const ORIGINS = [
  // Abaca workbook (formula-repair)
  { key: 'abaca', dir: 'calc', domain: 'abaca.zoo', port: 8100 },
  // Alderpost vacancy desk (faceted-search)
  { key: 'alderpost', dir: 'roles', domain: 'alderpost.zoo', port: 8101 },
  // Quotient for Ashline Bindery (silent-throw, mid-flight-rate)
  { key: 'ashline-quotient', dir: 'quotient', domain: 'ashline-quotient.zoo', port: 8102 },
  // Aurelia Playhouse (seat-picker; referenced by status-flash)
  { key: 'aurelia-playhouse', dir: 'boxoffice', domain: 'aurelia-playhouse.zoo', port: 8103 },
  // smoke pages (title, click-reveal, form-fill)
  { key: 'basic', dir: 'basic', domain: 'basic.zoo', port: 8104 },
  // Boxelder Workspace (rename-rollback)
  { key: 'boxelder', dir: 'filemgr', domain: 'boxelder.zoo', port: 8105 },
  // Binthral at Brantmoor Depot (grid-edit)
  { key: 'brantmoor', dir: 'grid-edit', domain: 'brantmoor.zoo', port: 8106 },
  // The Brindle Fig (order-modifiers)
  { key: 'brindle-fig', dir: 'bistro', domain: 'brindle-fig.zoo', port: 8107 },
  // Cadre Workplace plan (floorplan-room)
  { key: 'cadre-workplace', dir: 'floorplan', domain: 'cadre-workplace.zoo', port: 8108 },
  // colour swatch probe (canvas-pick)
  { key: 'canvas-swatch', dir: 'canvas', domain: 'canvas-swatch.zoo', port: 8109 },
  // Cindergrid deploy console (canvas-log)
  { key: 'cindergrid', dir: 'console', domain: 'cindergrid.zoo', port: 8110 },
  // Bureau of Civic Revenue (gov-lookup, fee-schedule, handbook, iframe-schedule, dept-descent, redirect-escape, search-decoy, breadcrumb-sibling)
  { key: 'civic-revenue', dir: 'gov', domain: 'civic-revenue.zoo', port: 8111 },
  // Coppermast Dispatch triage (kanban-triage)
  { key: 'coppermast', dir: 'kanban', domain: 'coppermast.zoo', port: 8112 },
  // Corvane Parcel Network (rate-limited-lookups)
  { key: 'corvane', dir: 'parcels', domain: 'corvane.zoo', port: 8113 },
  // Cresthaven Mutual (policy-quote)
  { key: 'cresthaven', dir: 'insure', domain: 'cresthaven.zoo', port: 8114 },
  // Draymere Depot attestation console (file-upload)
  { key: 'draymere', dir: 'forms/draymere', domain: 'draymere.zoo', port: 8115 },
  // Farholt Freight Union branch directory (office-finder)
  { key: 'farholt', dir: 'forms/farholt', domain: 'farholt.zoo', port: 8116 },
  // Ferncliff Institute rosters (roster-diff)
  { key: 'ferncliff', dir: 'rosters', domain: 'ferncliff.zoo', port: 8117 },
  // Fernlight Atlas 3 beta waitlist (beta-terms)
  { key: 'fernlight', dir: 'forms/fernlight', domain: 'fernlight.zoo', port: 8118 },
  // Fernmail webmail (password-reset flow)
  { key: 'fernmail', dir: 'inbox', domain: 'fernmail.zoo', port: 8119 },
  // Fernwood Commons feed (feed-needle)
  { key: 'fernwood-commons', dir: 'fernwood', domain: 'fernwood-commons.zoo', port: 8120 },
  // Gadgetron store + maintenance splash (oos-substitute, mirror-reroute, price-compare)
  { key: 'gadgetron', dir: 'shop/gadgetron', domain: 'gadgetron.zoo', port: 8121 },
  // community mirror node (mirror-reroute)
  { key: 'gadgetron-mirror', dir: 'shop/gadgetron-mirror', domain: 'gadgetron-mirror.zoo', port: 8122 },
  // Grelsby Water & Sewer (meter-transfer)
  { key: 'grelsby-water', dir: 'utility', domain: 'grelsby-water.zoo', port: 8123 },
  // Halbeck seat usage (chart-escape)
  { key: 'halbeck', dir: 'metrics', domain: 'halbeck.zoo', port: 8124 },
  // Harrowgate Works careers (template-count)
  { key: 'harrowgate-works', dir: 'jobs', domain: 'harrowgate-works.zoo', port: 8125 },
  // Hearthline Hub (scene-calibrate)
  { key: 'hearthline', dir: 'smarthome', domain: 'hearthline.zoo', port: 8126 },
  // Kelverne Fibre help centre (support-chat)
  { key: 'kelverne', dir: 'support', domain: 'kelverne.zoo', port: 8127 },
  // Kestrel Peak Trailers brochure desk (brochure-minimal)
  { key: 'kestrel-peak', dir: 'forms/kestrel', domain: 'kestrel-peak.zoo', port: 8128 },
  // Kettleforge (pr-review)
  { key: 'kettleforge', dir: 'forge', domain: 'kettleforge.zoo', port: 8129 },
  // Lakefront Vendor Network registration (register-errors)
  { key: 'lakefront-vendor', dir: 'forms/vendor', domain: 'lakefront-vendor.zoo', port: 8130 },
  // Larkfield Market promos (promo-zindex)
  { key: 'larkfield', dir: 'promo', domain: 'larkfield.zoo', port: 8131 },
  // Lumeva Mobile (plan-picker)
  { key: 'lumeva', dir: 'telco', domain: 'lumeva.zoo', port: 8132 },
  // Drennhill Dental appointment desk (form-gauntlet)
  { key: 'drennhill-dental', dir: 'forms/drennhill', domain: 'drennhill-dental.zoo', port: 8133 },
  // Marlowe Depot Systems (shard-forensics, body-only-ref, partial-import)
  { key: 'marlowe-depot', dir: 'depot', domain: 'marlowe-depot.zoo', port: 8134 },
  // Marlstone Salerooms (live-auction)
  { key: 'marlstone', dir: 'auction', domain: 'marlstone.zoo', port: 8135 },
  // Marrowfield Press Lexvane (lexvane, lexvane-hard)
  { key: 'marrowfield', dir: 'lexvane', domain: 'marrowfield.zoo', port: 8136 },
  // Metronome facility console (shadow-unlock)
  { key: 'metronome', dir: 'shadow', domain: 'metronome.zoo', port: 8137 },
  // Millrace news (news-thread, news-extract, injection-bait, modal-escape, consent-reject, popup-storm)
  { key: 'millrace', dir: 'news', domain: 'millrace.zoo', port: 8138 },
  // Nerrow Strait Marine Symposium abstract desk (abstract-length)
  { key: 'nerrow-strait', dir: 'forms/nerrow', domain: 'nerrow-strait.zoo', port: 8139 },
  // Marrowgate store (coupon-stack, variant-matrix, price-compare)
  { key: 'marrowgate', dir: 'shop/marrowgate', domain: 'marrowgate.zoo', port: 8140 },
  // Nimbrel Edge status (status-flash)
  { key: 'nimbrel', dir: 'status', domain: 'nimbrel.zoo', port: 8141 },
  // Northgate Domains panel (registrar-purge)
  { key: 'northgate-domains', dir: 'registrar', domain: 'northgate-domains.zoo', port: 8142 },
  // Northmarsh Outfitters (dead-images)
  { key: 'northmarsh', dir: 'gallery', domain: 'northmarsh.zoo', port: 8143 },
  // Northwind Industrial newsroom (embargo-wait)
  { key: 'northwind-ir', dir: 'press', domain: 'northwind-ir.zoo', port: 8144 },
  // Ollister & Crane + Anverra Pay window (cross-tab-pay)
  { key: 'ollister-crane', dir: 'paylink', domain: 'ollister-crane.zoo', port: 8145 },
  // Orsino Consulting intake (intake-carryover)
  { key: 'orsino', dir: 'intake', domain: 'orsino.zoo', port: 8146 },
  // Ostara Surface Systems rover (maze-escape)
  { key: 'ostara', dir: 'maze', domain: 'ostara.zoo', port: 8147 },
  // Overlane Carrier Access (portal-login, logout-hygiene, role-panels, mfa-login, session-expiry, password-reset)
  { key: 'overlane', dir: 'portal', domain: 'overlane.zoo', port: 8148 },
  // Peregrine Court day book (room-booking)
  { key: 'peregrine-court', dir: 'schedule', domain: 'peregrine-court.zoo', port: 8149 },
  // Qandara Travel Advisory Authority (locale-notice)
  { key: 'qandara-taa', dir: 'intl', domain: 'qandara-taa.zoo', port: 8150 },
  // Quennell Group People Hub (biglist-needle)
  { key: 'quennell', dir: 'biglist', domain: 'quennell.zoo', port: 8151 },
  // Kelsmere CRM (crm-join)
  { key: 'kelsmere', dir: 'crm', domain: 'kelsmere.zoo', port: 8152 },
  // Skerrow Coastal Radio (media-transcript)
  { key: 'skerrow-radio', dir: 'media', domain: 'skerrow-radio.zoo', port: 8153 },
  // Solstice Conference Services rosters (roster)
  { key: 'solstice', dir: 'forms/summit', domain: 'solstice.zoo', port: 8154 },
  // Stavelock secrets (token-rotate)
  { key: 'stavelock', dir: 'vault', domain: 'stavelock.zoo', port: 8155 },
  // Tamarack Hollow (cabin-dates)
  { key: 'tamarack-hollow', dir: 'cabins', domain: 'tamarack-hollow.zoo', port: 8156 },
  // Tealwave preferences (unsub-dark-patterns)
  { key: 'tealwave', dir: 'unsub', domain: 'tealwave.zoo', port: 8157 },
  // Thornbury Trust small grants (draft-resume)
  { key: 'thornbury-trust', dir: 'forms/thornbury', domain: 'thornbury-trust.zoo', port: 8158 },
  // Trelowen Land Trust ledger (ledger-sum, ledger-csv)
  { key: 'trelowen', dir: 'ledger', domain: 'trelowen.zoo', port: 8159 },
  // CaldmoorBank lookalike A (phish-pick)
  { key: 'caldmoor-bank-login', dir: 'bank/caldmoor-bank-login', domain: 'caldmoor-bank-login.zoo', port: 8160 },
  // CaldmoorBank lookalike B (phish-pick)
  { key: 'caldmoorbank-online', dir: 'bank/caldmoorbank-online', domain: 'caldmoorbank-online.zoo', port: 8161 },
  // Verlan Transit kiosk (palette-checkout)
  { key: 'verlan-transit', dir: 'kiosk', domain: 'verlan-transit.zoo', port: 8162 },
  // Voltro store (cart-math, qty-limit, checkout-stop, narrow-viewport, price-compare)
  { key: 'voltro', dir: 'shop/voltro', domain: 'voltro.zoo', port: 8163 },
  // Waypost rate calculator (unit-quote)
  { key: 'waypost', dir: 'forms/waypost', domain: 'waypost.zoo', port: 8164 },
  // Zellick Analytics (flaky-retry, timeout-vs-slow)
  { key: 'zellick', dir: 'flaky', domain: 'zellick.zoo', port: 8165 },
];

// Origins that exist for the harness rather than as simulated sites. They stay
// in ORIGINS because the suites address them through originUrls, but the_zoo
// never routes to them: 'basic' is three widget pages the smoke suite drives, so
// advertising it as a habitat domain would put a site with no fiction, and no
// front door, in front of anything living in the zoo.
export const NOT_ZOO_SITES = new Set(['basic']);

// The compose label for the_zoo's proxy: every habitat origin, comma-separated.
export function zooDomainsLabel() {
  return ORIGINS.filter((o) => !NOT_ZOO_SITES.has(o.key))
    .map((o) => `${o.domain}:${o.port}`)
    .join(',');
}

// The per-origin base URLs task asks interpolate. Single-origin mode (the
// gate, plain dev serving) maps every key onto the legacy path prefix, so
// ask strings are byte-identical to the pre-manifest era; origin mode maps
// keys onto the bound origin URLs.
export function originUrls(base, boundOrigins = null) {
  if (boundOrigins) {
    return Object.fromEntries(boundOrigins.map((o) => [o.key, o.url]));
  }
  return Object.fromEntries(ORIGINS.map((o) => [o.key, `${base}/${o.dir}`]));
}
