# Site design audit

This inventory records the 2026-09-19 review. Use it when designing or
re-skinning a site, but check the current pages before treating any category
as full or empty. The authoring rule is in `docs/authoring-fixtures.md`.

The following style families include member sites (dirs under `pages/`).
They were measured on 2026-09-19, after the re-skins of that date, from
every origin's landing page in Playwright Firefox at 1366px. It records the
face that renders most of the text on macOS, the computed colours, the nav
pattern, and the corner and shadow treatment, not the first name in a CSS
stack: `forms/draymere` asks for IBM Plex Sans and renders the generic
sans-serif, which is Helvetica. Re-measure before relying on this list.
`events`, which arrived later that day, was entered from its
stylesheet and landing page rather than re-measured.

The crowded families below are poor defaults for a new site. Give it a design
that makes sense for its genre and stands apart from its neighbours.

## Main face

- Trebuchet MS, the largest face family: `biglist`, `fernwood`, `forge`,
  `intl`, `paylink`, `promo`, `shop/marrowgate`.
- Futura: `boxoffice` (with Copperplate, on brown-black), `forms/summit`,
  `smarthome`, `telco`, `unsub`.
- Lucida Grande: `forms/farholt` (with Rockwell headings), `grid-edit`,
  `news`, `registrar`.
- Avenir or Avenir Next: `crm`, `maze`, `portal`, `support`.
- Helvetica Neue: `parcels`, `press`, `shop/voltro`, and `bank/*`, the
  phishing pair, identical by design.
- Arial Narrow: `depot`, `kiosk`, and `shop/gadgetron` with its mirror, a
  pair by design.
- SF through system-ui: `filemgr`, `forms/drennhill`, `forms/waypost`,
  `status`, and half of `calc`.
- Monospace throughout: `console`, `forms/fernlight`, `media`, `shadow`, and
  the other half of `calc`.
- Palatino: `bistro`, `insure`, `ledger`.
- Seravek: `gallery`, `quotient`.
- DIN Alternate: `jobs`, `kanban`.

## Palette and chrome

- A near-black ground: `boxoffice` (brown-black and gold), `console`,
  `forms/draymere` (ice cyan), `kiosk` (amber), `shadow` (hazard yellow),
  `smarthome` (teal).
- A warm cream or parchment ground: `bistro`, `cabins`, `fernwood`,
  `forms/farholt`, `forms/kestrel` (the original, Optima and rust), `intl`,
  `ledger`, `paylink`, `promo`, `unsub`. Three of them set oxblood or wine
  on that paper: `bistro`, `forms/farholt`, `ledger`.
- A grey-green or sage ground: `calc`, `forms/thornbury` (with moss),
  `inbox`, `kanban`.
- Rust, brick, terracotta or burnt orange as the lead accent:
  `forms/kestrel`, `paylink`, `press`, `roles`. `crm`, `grid-edit`, `intl`,
  `lexvane` and `registrar` set it on secondary text or rules.
- Lime or chartreuse: `metrics` and `telco`, both under a near-black bar,
  and `jobs`, in yellow-lime bands.
- Purple, plum or indigo chrome: `biglist`, `crm`, `forge`, `forms/summit`,
  `news`, `promo`, `registrar`.
- A dark green or teal band across the top: `cabins`, `grid-edit`, `intl`,
  `parcels`, `shop/voltro`, `status`.
- A navy or slate header or nav band: `bank/*`, `floorplan`, `forms/nerrow`,
  `forms/vendor`, `insure`, `media`, `utility`.
- A pale grey SaaS ground with white rounded cards and a blue or indigo
  primary: `filemgr`, `forms/drennhill`, `forms/waypost`, `portal`.
- Marketplace yellow or amber buy buttons on a product grid:
  `shop/gadgetron`, `shop/marrowgate`, `shop/voltro`.

## Navigation

- A full-height left rail: `biglist`, `console`, `floorplan`, `grid-edit`,
  `inbox`, `metrics`, `quotient`, `registrar`, `support`, `vault`. Five of
  them hang the rail under a dark full-width top bar, the console look:
  `console`, `floorplan`, `grid-edit`, `metrics`, `support`.
- A centred masthead, with the wordmark and the nav on the centre line:
  `bistro`, `boxoffice`, `insure`, `promo`.
- The defaults, which claim nothing on their own: a horizontal top nav whose
  current item is underlined or filled, on 37 landing pages, and a dark
  full-width top bar, on 23. A dark top bar over a left rail is the console
  look above.

## Corners and depth

- Hard offset shadows with no blur: `lexvane`, `promo`, `vault`.
- The rest are counts, not families, and most sites are square and flat:
  38 landing pages have no corner of 8px or more and no shadow at all. Cards
  rounded to 8px or more: `fernwood`, `forms/drennhill`, `forms/summit`,
  `forms/thornbury`, `forms/waypost`, `gallery`, `inbox`, `intake`,
  `kanban`, `lexvane`, `portal`, `roles`, `smarthome`, `status`, `telco`.
  Pill chips or buttons: `biglist`, `forms/thornbury`, `intake`,
  `lexvane`, `roles`, `smarthome`. Soft card shadows: `crm`, `fernwood`,
  `flaky`, `forms/thornbury`, `forms/waypost`, `intake`, `kanban`, `roles`.

## Distinctive combinations

Avoid copying these wholesale:
- `gov`: legacy HTML 4.01 tables and `<font>`, in Times.
- `auction`: Gill Sans with Baskerville headings on stone.
- `cabins`: a Rockwell body under a forest-green header on cream;
  `forms/farholt` sets only its headings in Rockwell.
- `canvas`: a Hoefler Text body under Didot headings on cool grey, with a
  CMYK rule.
- `forms/kestrel`: Optima with Avenir Next Condensed caps, on cream and rust.
- `forms/nerrow`: an Iowan Old Style body on blue-grey; `quotient` uses the
  face for headings only.
- `utility`: Georgia with Verdana labels under a navy municipal bar.
- `schedule`: Verdana, grey toolbar tabs and a client-coloured day grid.
- `inbox`: Arial, because its Franklin Gothic stack falls back, in a light
  fern-green webmail.
- `floorplan`: PT Sans, a navy bar with an orange rule, and a left rail.
- `metrics`: Hiragino Sans with DIN figures and square panels. Only the face
  is its own: the black bar, the grey rail and the lime put it in the lime
  and the console-look families above.
- `forms/thornbury`: Charter throughout, which `roles` gave up on
  2026-09-19, with pill tabs and rounded white cards. Its moss on a pale
  green-white wash sits in the grey-green family above.
- `forms/vendor`: Geneva, close in texture to `schedule`'s Verdana, under a
  slate civic header with a teal rule, which sits in the navy-or-slate
  family above.
- `rosters`: a learned-society site. A Cochin body under Big Caslon
  headings, white and ochre, a centred column under a ruled text nav, and
  booktabs tables.
- `flaky`: a SharePoint-style intranet. Tahoma behind a Segoe UI stack, a
  white suite bar with a sky-blue waffle, a hub nav strip and a command bar
  over a right-hand bulletin column, sky tiles, and square Fluent-shadowed
  web parts.
- `roles`: a WordPress job-board theme. Sukhumvit Set behind a Poppins stack,
  white and burnt orange, pill chips, rounded result cards, and a dark brief
  card.
- `vault`: neo-brutalism. Galvji behind a Space Grotesk stack, a yellow rail,
  2px black borders with hard offset shadows, and electric-blue links.
- `lexvane`: a newspaper puzzle page. Superclarendon with Athelas italics on
  dotted newsprint, a white masthead under a coral rule, ink-blue chrome, and
  green, ochre and slate tiles.
- `intake`: a Material 3 app. Kohinoor Telugu behind a Roboto stack, dusty
  rose tonal surfaces on a rose-white ground, a surface-coloured app bar
  over primary tabs, elevated cards and pill buttons.
- `events`: a council service in the GOV.UK manner. A PT Serif body on
  white under an 8px tangerine rule, a periwinkle tab strip whose current
  tab is filled white, a breadcrumb over a ruled side column, square and
  flat throughout, and tangerine buttons with an ink bottom border.

## Repeated habits

House tics already widespread in the review: letterspaced caps labels (34 of
66 landing pages carried three or more), a two-tone split wordmark (about 11),
and a founding year in the tagline (about 11). Avoid adding these by habit.

## Less-used directions

These were less common at the time of the review:
- Genres: a broadsheet newspaper front page, a 2014 Bootstrap corporate
  site, a dense Japanese portal, a Shopify-style direct-to-consumer store, a
  WordPress magazine or blog theme, a Swiss International-style grid, a 2003
  portal with bevels and gradients.
- Faces no site renders its text mainly in: American Typewriter, Bodoni 72,
  Marion, STIX Two Text, Baskerville, Courier New, PT Mono, Hiragino Mincho,
  Microsoft Sans Serif, Marker Felt.
- Palettes no site leads with: seafoam and peach, which appear only as small
  tints (`status`, `roles`). Dusty rose (`intake`), sky blue on a light ground
  (`flaky`), and periwinkle with tangerine (`events`) were taken on
  2026-09-19.
- Webfonts: none shipped then, so a self-hosted OFL face under the site's own
  directory was open territory too (follow its licence and attribution terms).
