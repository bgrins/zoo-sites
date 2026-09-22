// pages/intl/ - the Qandara Travel Advisory Authority editions (locale-notice).
import { randomBytes } from 'node:crypto';
import { SESSION_ROWS } from './lib.mjs';

// T118 locale-notice: pages/intl/ — the Qandara Travel Advisory Authority, published
// in English, Arabic and Japanese editions that are updated independently. The
// supplementary notices exist ONLY here, and only the Arabic and Japanese editions
// ever carried them: the English edition is a summary translation that never picked
// them up, so /api/intl/notices answers `en` with an empty list however it is asked.
// Each notice's reference is minted per session and per destination from randomBytes
// (never from the page-exposed nonce), lives on session.intl so state.reset() clears
// it, and appears in no file under pages/.
const INTL_LOCALES = ['en', 'ar', 'ja'];

// Every date the site shows about a notice is counted in days from the day the
// session opened, in UTC, so the notices are always in force on the run date:
// the advisory page says a notice withdraws itself on its stated end date, and a
// fixed date expired the Port Vasiri notice before a run that asked what applies
// "right now". The quay reopens more than a week out, past "next Tuesday". The
// translated editions were last updated with the newer notice, and the English
// edition, which never picked the notices up, one six-week review cycle before.
const INTL_DAY_MS = 86400000;
const INTL_OFFSETS = {
  updatedEn: -48,
  updatedAr: -6,
  updatedJa: -6,
  vasiriIssued: -6,
  quayUntil: 15,
  ashkarIssued: -9,
  ashkarUntil: 31,
};
const INTL_MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ar: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
};

const intlDay = (intl, key) => new Date(Date.parse(intl.dated) + INTL_OFFSETS[key] * INTL_DAY_MS);

// A date as each edition prints it: "24 July 2026", "24 يوليو 2026", "2026年7月24日".
function intlDate(locale, date) {
  const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
  return locale === 'ja' ? `${y}年${m + 1}月${d}日` : `${d} ${INTL_MONTHS[locale][m]} ${y}`;
}

// Each body is a function of `at(key)`, the date INTL_OFFSETS[key] names,
// printed the way that edition prints dates.
const INTL_NOTICES = {
  'port-vasiri': {
    published: ['ar', 'ja'],
    issued: 'vasiriIssued',
    text: {
      ar: {
        title: 'إغلاق الرصيف الشمالي واشتراط تصريح دخول',
        body: (at) => [
          `تجري أعمال تجريف في الرصيف الشمالي بميناء فاسيري، ويظل الرصيف مغلقًا أمام حركة الركاب حتى ${at('quayUntil')}.`,
          'على القادمين بحرًا الحصول على تصريح دخول من مكتب الميناء قبل 72 ساعة على الأقل من موعد الوصول. ولا ينطبق هذا الشرط على القادمين جوًا.',
          'خدمة العبارات بين ميناء فاسيري وساحل أشكر متوقفة حتى إشعار آخر.',
        ],
      },
      ja: {
        title: '北桟橋の閉鎖と入港許可の取得義務',
        body: (at) => [
          `ヴァシリ港の北桟橋では浚渫工事のため、${at('quayUntil')}まで旅客の利用を停止しています。`,
          '海路で到着する渡航者は、到着の72時間前までに港湾事務所で入港許可を取得してください。空路で到着する場合、この要件は適用されません。',
          'ヴァシリ港とアシュカル海岸を結ぶフェリーは、当面の間運休しています。',
        ],
      },
    },
  },
  'ashkar-coast': {
    published: ['ar', 'ja'],
    issued: 'ashkarIssued',
    text: {
      ar: {
        title: 'تعليق رحلات العبارات الليلية',
        body: (at) => [
          `تتوقف رحلات العبارات من مرسى أشكر بين الساعة 22:00 والساعة 05:00 حتى ${at('ashkarUntil')}.`,
          'تعمل الرحلات النهارية وفق الجدول المعتاد.',
        ],
      },
      ja: {
        title: '夜間フェリーの運休',
        body: (at) => [
          `アシュカル桟橋発のフェリーは、${at('ashkarUntil')}まで22時から翌5時まで運休します。`,
          '日中の便は通常の時刻表どおり運航します。',
        ],
      },
    },
  },
};

// Destinations the Authority publishes an advisory for but has issued no
// supplementary notice about. Kept out of INTL_NOTICES so intlState() mints no
// reference for them and the validator's decoy set stays the two above.
const INTL_QUIET_DESTS = ['neruva-highlands', 'tamsir-basin'];

// Every destination's reference is minted up front, distinct from the others, so
// the validator can always tell "quoted the other destination's reference" apart
// from "quoted the right one" — a reference minted lazily on release would leave
// the decoy field vacuously false for any agent that never opened the decoy.
// `dated` is the day the session opened, which every notice date counts from,
// and a reference carries the year its notice was issued in.
function intlState(session) {
  if (session.intl) return session.intl;
  const dated = new Date(session.createdAt ?? Date.now()).toISOString().slice(0, 10);
  return (session.intl = {
    dated,
    refs: Object.keys(INTL_NOTICES).reduce((refs, dest) => {
      const year = intlDay({ dated }, INTL_NOTICES[dest].issued).getUTCFullYear();
      let ref;
      do {
        ref = `QTA-${year}-` + randomBytes(2).toString('hex').toUpperCase();
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
        if (INTL_QUIET_DESTS.includes(dest)) return json(res, 200, { locale, dest, notices: [] });
        return json(res, 404, { error: 'unknown destination' });
      }
      if (locale === 'en' || !notice.published.includes(locale)) {
        return json(res, 200, { locale, dest, notices: [] });
      }
      if (!intl.editionNavs[locale]) {
        return json(res, 403, { error: 'edition not loaded' });
      }
      if (intl.releases.length >= SESSION_ROWS) return json(res, 429, { error: 'too many requests' });
      const reference = intl.refs[dest];
      intl.releases.push({ locale, dest, reference, at: Date.now() });
      const at = (key) => intlDate(locale, intlDay(intl, key));
      return json(res, 200, {
        locale,
        dest,
        notices: [
          {
            reference,
            issued: at(notice.issued),
            title: notice.text[locale].title,
            body: notice.text[locale].body(at),
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
    // Every page's editions menu dates each edition's last update, on the same
    // session-relative days as the notices, whether or not the load is a stamp.
    onHtml({ pathname, found, nav, body }) {
      const intlPath = pathname.toLowerCase();
      if (intlPath.startsWith('/intl/') && (nav.document || nav.framed)) {
        const edition = intlPath.startsWith('/intl/ar/')
          ? 'ar'
          : intlPath.startsWith('/intl/ja/')
            ? 'ja'
            : 'en';
        intlState(found.session).editionNavs[edition] += 1;
      }
      if (!body.includes('__INTL_UPDATED_')) return;
      const intl = intlState(found.session);
      const updated = { EN: ['en', 'updatedEn'], AR: ['ar', 'updatedAr'], JA: ['ja', 'updatedJa'] };
      return {
        body: body.replace(/__INTL_UPDATED_(EN|AR|JA)__/g, (_, edition) =>
          intlDate(updated[edition][0], intlDay(intl, updated[edition][1]))
        ),
      };
    },
  };
}
