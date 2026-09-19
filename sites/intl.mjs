// pages/intl/ - the Qandara Travel Advisory Authority editions (locale-notice).
import { randomBytes } from 'node:crypto';

// T118 locale-notice: pages/intl/ — the Qandara Travel Advisory Authority, published
// in English, Arabic and Japanese editions that are updated independently. The
// supplementary notices exist ONLY here, and only the Arabic and Japanese editions
// ever carried them: the English edition is a summary translation that never picked
// them up, so /api/intl/notices answers `en` with an empty list however it is asked.
// Each notice's reference is minted per session and per destination from randomBytes
// (never from the page-exposed nonce), lives on session.intl so state.reset() clears
// it, and appears in no file under pages/.
const INTL_LOCALES = ['en', 'ar', 'ja'];

const INTL_NOTICES = {
  'port-vasiri': {
    published: ['ar', 'ja'],
    issued: { ar: '24 يوليو 2026', ja: '2026年7月24日' },
    text: {
      ar: {
        title: 'إغلاق الرصيف الشمالي واشتراط تصريح دخول',
        body: [
          'تجري أعمال تجريف في الرصيف الشمالي بميناء فاسيري، ويظل الرصيف مغلقًا أمام حركة الركاب حتى 14 أغسطس 2026.',
          'على القادمين بحرًا الحصول على تصريح دخول من مكتب الميناء قبل 72 ساعة على الأقل من موعد الوصول. ولا ينطبق هذا الشرط على القادمين جوًا.',
          'خدمة العبارات بين ميناء فاسيري وساحل أشكر متوقفة حتى إشعار آخر.',
        ],
      },
      ja: {
        title: '北桟橋の閉鎖と入港許可の取得義務',
        body: [
          'ヴァシリ港の北桟橋では浚渫工事のため、2026年8月14日まで旅客の利用を停止しています。',
          '海路で到着する渡航者は、到着の72時間前までに港湾事務所で入港許可を取得してください。空路で到着する場合、この要件は適用されません。',
          'ヴァシリ港とアシュカル海岸を結ぶフェリーは、当面の間運休しています。',
        ],
      },
    },
  },
  'ashkar-coast': {
    published: ['ar', 'ja'],
    issued: { ar: '21 يوليو 2026', ja: '2026年7月21日' },
    text: {
      ar: {
        title: 'تعليق رحلات العبارات الليلية',
        body: [
          'تتوقف رحلات العبارات من مرسى أشكر بين الساعة 22:00 والساعة 05:00 حتى 30 أغسطس 2026.',
          'تعمل الرحلات النهارية وفق الجدول المعتاد.',
        ],
      },
      ja: {
        title: '夜間フェリーの運休',
        body: [
          'アシュカル桟橋発のフェリーは、2026年8月30日まで22時から翌5時まで運休します。',
          '日中の便は通常の時刻表どおり運航します。',
        ],
      },
    },
  },
};

// Every destination's reference is minted up front, distinct from the others, so
// the validator can always tell "quoted the other destination's reference" apart
// from "quoted the right one" — a reference minted lazily on release would leave
// the decoy field vacuously false for any agent that never opened the decoy.
function intlState(session) {
  return (session.intl ??= {
    refs: Object.keys(INTL_NOTICES).reduce((refs, dest) => {
      let ref;
      do {
        ref = 'QTA-2026-' + randomBytes(2).toString('hex').toUpperCase();
      } while (Object.values(refs).includes(ref));
      refs[dest] = ref;
      return refs;
    }, {}),
    requests: { en: 0, ar: 0, ja: 0 },
    editionNavs: { en: 0, ar: 0, ja: 0 },
    releases: [],
  });
}

export function routes(ctx) {
  const { json, requireSession } = ctx;
  return async (req, res, url, pathname0) => {
    // The notices panel of a destination advisory. Locale-gated: the English
    // edition never carried these notices, so `en` is answered with an empty list
    // whoever asks. A translated edition is served only to a session that really
    // navigated into that edition (stamped by documents() below), so an
    // agent that never left the English pages cannot pull a reference out of the
    // API, and the release is recorded on the session — that record, not a beacon,
    // is what the validator grades.
    if (req.method === 'GET' && pathname0 === '/api/intl/notices') {
      const found = requireSession(req, res);
      if (!found) return;
      const locale = String(url.searchParams.get('locale') ?? '');
      const dest = String(url.searchParams.get('dest') ?? '');
      if (!INTL_LOCALES.includes(locale)) {
        return json(res, 400, { error: 'unknown edition' });
      }
      const intl = intlState(found.session);
      intl.requests[locale] += 1;
      const notice = Object.hasOwn(INTL_NOTICES, dest) ? INTL_NOTICES[dest] : null;
      // A destination we do not publish is an error, not an empty list: an empty
      // list here would let a mistyped slug read as an authoritative "nothing
      // applies", which is the one wrong answer this task must not hand out.
      if (!notice) {
        return json(res, 404, { error: 'unknown destination' });
      }
      if (locale === 'en' || !notice.published.includes(locale)) {
        return json(res, 200, { locale, dest, notices: [] });
      }
      if (!intl.editionNavs[locale]) {
        return json(res, 403, { error: 'edition not loaded' });
      }
      const reference = intl.refs[dest];
      intl.releases.push({ locale, dest, reference, at: Date.now() });
      return json(res, 200, {
        locale,
        dest,
        notices: [
          {
            reference,
            issued: notice.issued[locale],
            title: notice.text[locale].title,
            body: notice.text[locale].body,
          },
        ],
      });
    }

    return false;
  };
}

export function documents() {
  return {
    prefix: '/intl/',

    // T118 locale-notice: an edition counts as opened only on a real document
    // navigation into it. An in-page fetch() cannot set the sec-fetch-* headers,
    // so /api/intl/notices cannot hand a translated notice to a session that only
    // ever loaded the English pages. Framed loads count, like the other framed nav
    // stamps, so the preview contact sheet still renders a live edition.
    // The path is lowercased first because the fixture tree is served off a
    // case-insensitive filesystem: /INTL/AR/advisory.html serves the Arabic
    // page, and a case-sensitive test here would leave that load unstamped and
    // the page reporting "no notices" for a reason the agent cannot see.
    onHtml({ pathname, found, nav }) {
      const intlPath = pathname.toLowerCase();
      if (intlPath.startsWith('/intl/') && (nav.document || nav.framed)) {
        const edition = intlPath.startsWith('/intl/ar/')
          ? 'ar'
          : intlPath.startsWith('/intl/ja/')
            ? 'ja'
            : 'en';
        intlState(found.session).editionNavs[edition] += 1;
      }
    },
  };
}
