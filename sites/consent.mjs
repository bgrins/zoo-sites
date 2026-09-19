// pages/news/consent.html - the 3-layer consent wall.

// pages/news/consent.html — the 3-layer consent wall over the Millrace front
// page. The CMP posts its whole toggle map to /api/consent/save; the submitted
// map and the accept-all count live on the session, so state.reset() clears
// them between tasks and a forged /api/beacon cannot fake a compliant save.
// The collapsed "Legitimate interest" rows and the layer-3 vendor rows are not
// in the first paint: the page fetches each tier from /api/consent/tier when
// that section is opened, the session remembers which tiers it was sent, and a
// save can only refuse a purpose whose tier this session has actually been
// shown. A blind "click every [data-key] and save" script therefore never
// learns that the five hidden toggles exist and leaves them on.
const CONSENT_TOGGLES = [
  'essential',
  'basicAds',
  'personalisedAds',
  'personalisedContent',
  'audienceMeasurement',
  'contentMeasurement',
  'developServices',
  'linkDevices',
  'combineData',
  'improveProducts',
  'vendorLarkfield',
  'vendorCindersmith',
];

const CONSENT_TIER_ROWS = {
  li: [
    { key: 'linkDevices', name: 'Link different devices' },
    { key: 'combineData', name: 'Match and combine data' },
    { key: 'improveProducts', name: 'Improve our products' },
  ],
  vendors: [
    {
      key: 'vendorLarkfield',
      name: 'Larkfield Media',
      desc: 'Ad selection and delivery. Retention 390 days.',
    },
    {
      key: 'vendorCindersmith',
      name: 'Cindersmith Analytics',
      desc: 'Audience modelling. Retention 180 days.',
    },
  ],
};

const consentTierOf = (key) =>
  Object.keys(CONSENT_TIER_ROWS).find((tier) =>
    CONSENT_TIER_ROWS[tier].some((row) => row.key === key)
  ) ?? null;

export function routes(ctx) {
  const { state, json, readJson, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/consent/state') {
      const found = requireSession(req, res);
      if (!found) return;
      const consent = (found.session.consent ??= { saves: [], acceptAlls: 0, served: [] });
      const last = consent.saves[consent.saves.length - 1] ?? null;
      return json(res, 200, {
        decided: !!last,
        toggles: last ? last.toggles : null,
        optionalOn: last ? last.optionalOn : null,
        // Which hidden tiers this session has opened, so the page's "Change
        // cookie choices" path can restore exactly the rows the reader has
        // already been shown and no more.
        served: consent.served,
      });
    }

    // A hidden tier's rows are served only when that section is opened, and the
    // session records having seen them; see /api/consent/save.
    if (req.method === 'GET' && pathname0 === '/api/consent/tier') {
      const found = requireSession(req, res);
      if (!found) return;
      const name = String(url.searchParams.get('name') ?? '');
      const rows = Object.hasOwn(CONSENT_TIER_ROWS, name) ? CONSENT_TIER_ROWS[name] : null;
      if (!rows) return json(res, 404, { error: 'unknown tier' });
      const consent = (found.session.consent ??= { saves: [], acceptAlls: 0, served: [] });
      if (!consent.served.includes(name)) consent.served.push(name);
      return json(res, 200, { name, rows });
    }

    if (req.method === 'POST' && pathname0 === '/api/consent/save') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const submitted = payload?.toggles;
      if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
        return json(res, 400, { error: 'A consent map is required.' });
      }
      const unknown = Object.keys(submitted).filter(
        (key) => !CONSENT_TOGGLES.includes(key)
      );
      if (unknown.length) {
        return json(res, 400, {
          error: 'Unrecognised purposes: ' + unknown.join(', ') + '.',
        });
      }
      const consent = (found.session.consent ??= { saves: [], acceptAlls: 0, served: [] });
      const toggles = {};
      for (const key of CONSENT_TOGGLES) {
        // Consent defaults to ON, exactly as the dialog shows it: a purpose is
        // recorded as refused only when this save says so explicitly AND its
        // tier has been served to this session. So a partial payload cannot
        // leave a pre-enabled purpose unmentioned and look compliant, and a
        // script that never opened the collapsed section or the vendor screen
        // cannot refuse toggles it was never shown. No error names those tiers.
        const tier = consentTierOf(key);
        const shown = !tier || consent.served.includes(tier);
        toggles[key] = shown ? submitted[key] !== false : true;
      }
      const optional = CONSENT_TOGGLES.filter((key) => key !== 'essential');
      const optionalOn = optional.filter((key) => toggles[key]).length;
      const via = String(payload.via ?? 'save');
      if (via === 'accept-all' || optionalOn === optional.length) {
        consent.acceptAlls += 1;
      }
      consent.saves.push({ toggles, optionalOn, via, at: Date.now() });
      return json(res, 200, { ok: true, optionalOn, decided: true });
    }

    return false;
  };
}
