// T118 locale-notice: pages/intl/ — the Qandara Travel Advisory Authority's three
// language editions. The supplementary notice for Port Vasiri was only ever
// published in the Arabic and Japanese editions, so the golden path has to leave
// the English page, switch edition through the site's own editions menu, and read
// a reference out of RTL Arabic body copy.

import { bumpCode, until } from './lib.mjs';

const localeNotice = {
  note: 'switches to the Arabic edition and reads the notice reference',
  wrong: 'The advisory reference for Port Vasiri is QTA-2026-0000.',
  async run({ goto, mcp, snapshot }) {
    // The link on the destination list carries no text of its own: the name and
    // the level sit in child spans, so resolve the anchor above the matching span.
    const anchorAbove = (snap, label) => {
      const lines = snap.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(`text="${label}"`)) continue;
        for (let j = i; j >= 0; j--) {
          const m = lines[j].match(/uid=(\S+) a\b/);
          if (m) return m[1];
        }
      }
      return null;
    };
    // Substring rather than an exact accessible name: our snapshot currently drops
    // the `<em>` update date out of each edition link, and the day it stops doing
    // that the name becomes `العربية آخر تحديث 24 يوليو 2026`. The driver should
    // survive that improvement.
    const linkContaining = (snap, label) => {
      for (const line of snap.split('\n')) {
        if (!line.includes(label)) continue;
        const m = line.match(/uid=(\S+) a\b/);
        if (m) return m[1];
      }
      return null;
    };
    const untilSnapshot = (test, what) =>
      until(what, async () => {
        const snap = await snapshot();
        return test(snap) ? snap : null;
      }, { tries: 25, gap: 200 });

    await goto('/intl/');
    const home = await untilSnapshot((s) => s.includes('Port Vasiri'), 'the destination list');
    const destUid = anchorAbove(home, 'Port Vasiri');
    if (!destUid) throw new Error('no Port Vasiri link in the destination list');
    await mcp('click_by_uid', { uid: destUid });

    const english = await untilSnapshot(
      (s) => /No supplementary notices/.test(s),
      'the English advisory page'
    );
    if (/QTA-2026-/.test(english)) {
      throw new Error('the English edition leaked an advisory reference');
    }

    // The editions menu is the only affordance that says other editions exist.
    const arUid = linkContaining(english, 'العربية');
    if (!arUid) throw new Error('no Arabic edition link in the editions menu');
    await mcp('click_by_uid', { uid: arUid });

    const arabic = await untilSnapshot(
      (s) => /المرجع: QTA-2026-[0-9A-F]{4}/.test(s),
      'the Arabic edition notice'
    );
    const reference = arabic.match(/QTA-2026-[0-9A-F]{4}/)[0];

    // Both translated editions must carry the same reference for the same notice;
    // assert it rather than assume it, so a divergence shows up here. Reached by
    // clicking the editions menu again rather than by a hand-built URL, so the
    // Japanese link is proven resolvable on our surface too.
    const jaUid = linkContaining(arabic, '日本語');
    if (!jaUid) throw new Error('no Japanese edition link in the editions menu');
    await mcp('click_by_uid', { uid: jaUid });
    const japanese = await untilSnapshot(
      (s) => /参照番号: QTA-2026-[0-9A-F]{4}/.test(s),
      'the Japanese edition notice'
    );
    const jaReference = japanese.match(/QTA-2026-[0-9A-F]{4}/)[0];
    if (jaReference !== reference) {
      throw new Error(`editions disagree: ar=${reference} ja=${jaReference}`);
    }

    // A wrong answer of exactly the right shape, guaranteed distinct from the
    // reference this session was actually issued; and the real reference put to
    // the one claim this task must never accept, that nothing further applies.
    localeNotice.wrong = [
      `The advisory reference for Port Vasiri is ${bumpCode(reference)}.`,
      `Advisory reference ${reference} keeps Port Vasiri at Level 2; nothing further ` +
        `applies to arrivals beyond the standing advisory level.`,
    ];
    localeNotice.alsoCorrect = [
      `Advisory reference: ${reference}\nApplies to sea arrivals: entry permit from ` +
        `the harbour office at least 72 hours before arrival; north quay closed; ` +
        `Ashkar Coast ferry suspended.`,
      `Beyond the standing Level 2 advisory, sea arrivals must obtain a harbour-office ` +
        `entry permit at least 72 hours ahead — the north quay is shut for dredging and ` +
        `the Ashkar Coast ferry is suspended. The notice relied on is ${reference}, ` +
        `carried by the Arabic and Japanese editions only.`,
      `Your colleagues need an entry permit from the harbour office 72 hours before ` +
        `docking; the notice is ${reference.toLowerCase()}.`,
      // A real agent answer, verbatim with the reference substituted: it
      // narrates the English page's "No supplementary notices" decoy BEFORE
      // reporting the real requirement, which baits an extractor into
      // requirement: null.
      `## What applies beyond the standing Level 2 advisory\n\n` +
        `The **English page** for Port Vasiri shows only "No supplementary notices," ` +
        `but the site states that the **Arabic edition is the authoritative text and ` +
        `English pages may lag behind it**. The Arabic edition does carry an active ` +
        `supplementary notice that hasn't yet been reflected in English:\n\n` +
        `**North Quay closure & entry-permit requirement**\n` +
        `- The North Quay at Port Vasiri is closed to passenger traffic until ` +
        `**14 August 2026** due to dredging work.\n` +
        `- **Arrivals by sea must obtain an entry permit from the port office at ` +
        `least 72 hours before arrival** (this requirement does **not** apply to ` +
        `arrivals by air).\n` +
        `- The ferry service between Port Vasiri and Ashkar Coast is suspended ` +
        `until further notice.\n\n` +
        `Since your colleagues are arriving by sea next Tuesday, this falls squarely ` +
        `within the closure window - they need to apply for the port-office entry ` +
        `permit at least 72 hours ahead, in addition to the standing Level 2 ` +
        `"exercise increased caution" guidance.\n\n` +
        `**Advisory reference:** ${reference} (issued 24 July 2026)`,
    ];

    const fields = {
      advisoryReference: reference,
      requirement:
        'Arrivals by sea must obtain an entry permit from the harbour office at least ' +
        '72 hours before arrival; the north quay is closed and the Ashkar Coast ferry suspended.',
    };
    localeNotice.wrongFields = [
      { advisoryReference: bumpCode(reference), requirement: fields.requirement },
      { advisoryReference: reference, requirement: null },
      { advisoryReference: reference, requirement: 'Nothing applies beyond the standing advisory level.' },
    ];
    localeNotice.alsoCorrectFields = [
      fields,
      { advisoryReference: reference.toLowerCase(), requirement: 'an entry permit is needed 72 hours ahead' },
    ];
    return {
      text: [
        `The English edition of the Qandara Travel Advisory Authority site carries no`,
        `supplementary notices for Port Vasiri, but the Arabic and Japanese editions both do.`,
        `Advisory reference ${reference}, issued 24 July 2026: the north quay is closed to`,
        `passengers for dredging until 14 August 2026, arrivals by sea must obtain an entry`,
        `permit from the harbour office at least 72 hours before arrival (arrivals by air are`,
        `not affected), and the Port Vasiri to Ashkar Coast ferry is suspended until further`,
        `notice. The standing advisory level is unchanged at Level 2.`,
      ].join(' '),
      fields,
    };
  },
};

export const DRIVERS = { 'locale-notice': localeNotice };
