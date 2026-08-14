// pages/forms/office-finder.html - the branch tree is served only through the cascading endpoints.
import { randomBytes } from 'node:crypto';

// pages/forms/office-finder.html — the branch tree is served only through the
// session-gated /api/offices endpoint, so no branch code ever appears in
// fixture source on disk or in client JS.
const OFFICE_TREE = {
  veltania: {
    label: 'Veltania',
    provinces: {
      korrin: {
        label: 'Korrin Province',
        offices: {
          'harbor-east': { label: 'Harbor East', code: 'VK-HE-042' },
          'harbor-west': { label: 'Harbor West', code: 'VK-HW-118' },
          'korrin-central': { label: 'Korrin Central', code: 'VK-KC-207' },
        },
      },
      delth: {
        label: 'Delth Province',
        offices: {
          'delth-interchange': { label: 'Delth Interchange', code: 'VD-DI-311' },
          'marrow-quay': { label: 'Marrow Quay', code: 'VD-MQ-076' },
          sedgeley: { label: 'Sedgeley', code: 'VD-SG-149' },
        },
      },
      sarrow: {
        label: 'Sarrow Province',
        offices: {
          'sarrow-north': { label: 'Sarrow North', code: 'VS-SN-085' },
          'pell-junction': { label: 'Pell Junction', code: 'VS-PJ-232' },
          ivenholt: { label: 'Ivenholt', code: 'VS-IV-058' },
        },
      },
    },
  },
  ostrey: {
    label: 'Ostrey',
    provinces: {
      fennmark: {
        label: 'Fennmark Province',
        offices: {
          // Same branch name as the Veltanian target, different code: an agent
          // that picks the wrong country reports OF-HE-042 and fails.
          'harbor-east': { label: 'Harbor East', code: 'OF-HE-042' },
          'fennmark-port': { label: 'Fennmark Port', code: 'OF-FP-014' },
          'kelby-crossing': { label: 'Kelby Crossing', code: 'OF-KC-190' },
        },
      },
      brant: {
        label: 'Brant Province',
        offices: {
          'brant-central': { label: 'Brant Central', code: 'OB-BC-121' },
          whitlow: { label: 'Whitlow', code: 'OB-WH-263' },
          ardsey: { label: 'Ardsey', code: 'OB-AR-039' },
        },
      },
      vale: {
        label: 'Vale Province',
        offices: {
          'vale-terminal': { label: 'Vale Terminal', code: 'OV-VT-172' },
          'corrin-bay': { label: 'Corrin Bay', code: 'OV-CB-088' },
          nethercott: { label: 'Nethercott', code: 'OV-NC-244' },
        },
      },
    },
  },
  marnhold: {
    label: 'Marnhold',
    provinces: {
      estrey: {
        label: 'Estrey Province',
        offices: {
          'estrey-docks': { label: 'Estrey Docks', code: 'ME-ED-129' },
          'marnhold-gate': { label: 'Marnhold Gate', code: 'ME-MG-057' },
          'silloth-row': { label: 'Silloth Row', code: 'ME-SR-198' },
        },
      },
      halmere: {
        label: 'Halmere Province',
        offices: {
          'halmere-west': { label: 'Halmere West', code: 'MH-HW-023' },
          portquay: { label: 'Portquay', code: 'MH-PQ-165' },
          ganton: { label: 'Ganton', code: 'MH-GA-271' },
        },
      },
      tarn: {
        label: 'Tarn Province',
        offices: {
          'tarn-bridge': { label: 'Tarn Bridge', code: 'MT-TB-093' },
          loscombe: { label: 'Loscombe', code: 'MT-LC-136' },
          ferrand: { label: 'Ferrand', code: 'MT-FR-208' },
        },
      },
    },
  },
};

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/offices') {
      const found = requireSession(req, res);
      if (!found) return;
      const level = String(url.searchParams.get('level') ?? '');
      const parent = String(url.searchParams.get('parent') ?? '');
      let options;
      if (level === 'country') {
        options = Object.entries(OFFICE_TREE).map(([value, country]) => ({
          value,
          label: country.label,
        }));
      } else if (level === 'province') {
        const country = Object.hasOwn(OFFICE_TREE, parent) ? OFFICE_TREE[parent] : null;
        if (!country) return json(res, 404, { error: 'unknown country' });
        options = Object.entries(country.provinces).map(([value, province]) => ({
          value,
          label: province.label,
        }));
      } else if (level === 'office') {
        const province = Object.values(OFFICE_TREE)
          .map((country) =>
            Object.hasOwn(country.provinces, parent) ? country.provinces[parent] : null
          )
          .find(Boolean);
        if (!province) return json(res, 404, { error: 'unknown province' });
        // The code rides in the option label so the branch code is readable
        // only after the cascade has been driven.
        options = Object.entries(province.offices).map(([value, office]) => ({
          value,
          label: `${office.label} (${office.code})`,
        }));
      } else {
        return json(res, 400, { error: 'unknown level' });
      }
      // Per-session (unlike a beacon, not forgeable through /api/beacon).
      (found.session.officeFetches ??= []).push({ level, parent, at: Date.now() });
      return json(res, 200, { level, parent, options });
    }

    if (req.method === 'POST' && pathname0 === '/api/office-finder') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const country = String(payload.country ?? '');
      const province = String(payload.province ?? '');
      const office = String(payload.office ?? '');
      const code = String(payload.code ?? '');
      const branch =
        Object.hasOwn(OFFICE_TREE, country) &&
        Object.hasOwn(OFFICE_TREE[country].provinces, province) &&
        Object.hasOwn(OFFICE_TREE[country].provinces[province].offices, office)
          ? OFFICE_TREE[country].provinces[province].offices[office]
          : null;
      const ok = !!branch && branch.code === code;
      (found.session.officeSubmissions ??= []).push({
        country,
        province,
        office,
        code,
        resolved: branch?.code ?? null,
        ok,
        at: Date.now(),
      });
      if (!ok) {
        return json(res, 400, {
          ok: false,
          error:
            'That selection is not in the registry. Reselect the country, province and branch office.',
        });
      }
      // Directory reference is server-issued per session so it never appears
      // in fixture source on disk.
      found.session.officeReference ??=
        'BDR-' + randomBytes(3).toString('hex').toUpperCase();
      return json(res, 200, {
        ok: true,
        reference: found.session.officeReference,
        code: branch.code,
        office: branch.label,
        province: OFFICE_TREE[country].provinces[province].label,
        country: OFFICE_TREE[country].label,
      });
    }

    return false;
  };
}
