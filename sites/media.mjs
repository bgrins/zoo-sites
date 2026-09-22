// pages/media/ - Skerrow Coastal Radio recording (media-transcript) and the
// newsroom desk's running order (pointer-drag).
import { randomBytes } from 'node:crypto';
import { MONTH_NAMES, dayText, lcg, pushTrimmed } from './lib.mjs';

// pages/media/ — Skerrow Coastal Radio, the latest coastal forecast recording
// (media-transcript). The audio is SYNTHESISED here (a per-chapter sine tone in
// a PCM WAV container) rather than shipped as a file, and the transcript text is
// released per session through /api/media/cues, so no fixture file under pages/
// carries a line of the bulletin. The chapter-3 line is withheld from that
// payload entirely: it is only ever returned by /api/media/heard, and only to a
// session that has both been served the recording and reported a playhead at or
// past the cue. The three SKW references are minted from randomBytes, not from
// the page nonce, so none of them is reproducible from anything the page shows.
const MEDIA_DURATION = 48;

const MEDIA_SAMPLE_RATE = 8000;

// The station transmits every six hours from 0535 UTC and holds each recording
// for six hours, so exactly one recording is held at a time: the last one
// transmitted before the session opened. The bulletin list, the bulletin page and
// the recording's own "supersedes" line are counted back from it (rule 9 in
// docs/authoring-fixtures.md), so on any run date the held recording is current.
// The slot is fixed when the session opens, so a session opened just before a
// transmission shows a held recording that passes its six hours during the run.
const SLOT_MS = 6 * 3600000;
const FIRST_SLOT_MS = (5 * 60 + 35) * 60000;
const LISTED_SLOTS = 5;

const heldSlot = (createdAt) => Math.floor((createdAt - FIRST_SLOT_MS) / SLOT_MS) * SLOT_MS + FIRST_SLOT_MS;

const slotTime = (ms) => {
  const at = new Date(ms);
  return String(at.getUTCHours()).padStart(2, '0') + String(at.getUTCMinutes()).padStart(2, '0');
};

const slotDay = (ms) => dayText(ms, { weekday: false, year: false });

const slotShort = (ms) => {
  const at = new Date(ms);
  return `${at.getUTCDate()} ${MONTH_NAMES[at.getUTCMonth()].slice(0, 3)}`;
};

function mediaBulletin(media) {
  return {
    station: 'SKW',
    name: 'Skerrow Coastal Radio',
    title: `Coastal forecast, ${slotTime(media.issuedAt)} UTC`,
    issued: `${slotTime(media.issuedAt)} UTC, ${slotDay(media.issuedAt)}`,
  };
}

// __SKW_<KEY>_<k>__ describes the recording k slots before the held one;
// __SKW_VALID__ is when the held forecast lapses, and __SKW_PURGED__ is the
// purged-recording notice for the transmission time in ?t=.
function mediaRender(body, createdAt, url) {
  const held = heldSlot(createdAt);
  const slot = (k) => held - k * SLOT_MS;
  const keys = { TIME: slotTime, DAY: slotDay, SHORT: slotShort };
  const t = url.searchParams.get('t');
  const purged = Array.from({ length: LISTED_SLOTS - 1 }, (_, k) => slot(k + 1)).find((at) => slotTime(at) === t);
  const valid = held + 2 * SLOT_MS;
  return body
    .replace(/__SKW_([A-Z]+)_(\d)__/g, (token, key, k) =>
      keys[key] && Number(k) < LISTED_SLOTS ? keys[key](slot(Number(k))) : token)
    .replaceAll('__SKW_VALID__', `${slotTime(valid)} UTC, ${slotDay(valid)}`)
    .replaceAll(
      '__SKW_PURGED__',
      purged === undefined
        ? 'This transmission is older than the six hour retention window.'
        : `The ${slotShort(purged)} ${t.slice(0, 2)}:${t.slice(2)} transmission is older than the six hour ` +
            'retention window.'
    );
}

const MEDIA_CHAPTERS = [
  { n: 1, title: 'General synopsis', start: 0, end: 12, tone: 320 },
  { n: 2, title: 'Sea area forecast', start: 12, end: 26, tone: 400 },
  { n: 3, title: 'Station reports', start: 26, end: 38, tone: 262 },
  { n: 4, title: 'Inshore waters', start: 38, end: 48, tone: 480 },
];

// `locked` marks the graded line. Its text never leaves this module except
// through the unlock branch of /api/media/heard.
const MEDIA_SCRIPT = [
  { chapter: 1, start: 0.6, text: 'Skerrow Coastal Radio, coastal forecast.' },
  { chapter: 1, start: 4, text: 'Low 986 west of Talvig, deepening.' },
  { chapter: 1, start: 8, text: 'Supersedes __SUPERSEDES__ from __PREVIOUS__.' },
  { chapter: 2, start: 12.4, text: 'Braithe, Munroe Bank: southwest 5 to 7.' },
  { chapter: 2, start: 16, text: 'Calder Deep: veering west, gale 8 later.' },
  { chapter: 2, start: 20, text: 'Talvig, Orrin Sound: rain then showers.' },
  { chapter: 2, start: 23, text: 'Fetlan: moderate becoming rough.' },
  { chapter: 3, start: 26, locked: true, text: 'Log reference __REFERENCE__ for these reports.' },
  { chapter: 3, start: 29, text: 'Skerrow Head: west 6, 1009 falling.' },
  { chapter: 3, start: 32, text: 'Braithe Light: southwest 5, 1007 falling.' },
  { chapter: 3, start: 35, text: 'Munroe Bank buoy: west 7, 1004 falling.' },
  { chapter: 4, start: 38.4, text: 'Cape Ardnoy to Fetlan Point, 12 miles.' },
  { chapter: 4, start: 42, text: 'Wind southwest 4 to 6, 7 later.' },
  { chapter: 4, start: 45, text: 'Identifier __IDENTIFIER__ ends transmission.' },
];

// One tone per chapter with a short gap at each boundary, so the recording is
// audible in QA and the chapter edges can be heard. Built once and reused: the
// bytes are identical for every session, and nothing about them is graded.
let MEDIA_WAV = null;

function mediaWav() {
  if (MEDIA_WAV) return MEDIA_WAV;
  const samples = MEDIA_DURATION * MEDIA_SAMPLE_RATE;
  const pcm = Buffer.alloc(samples * 2);
  for (const chapter of MEDIA_CHAPTERS) {
    const from = Math.round(chapter.start * MEDIA_SAMPLE_RATE);
    const to = Math.min(samples, Math.round(chapter.end * MEDIA_SAMPLE_RATE));
    const gap = from + Math.round(0.35 * MEDIA_SAMPLE_RATE);
    for (let i = from; i < to; i++) {
      const level = i < gap ? 0 : 0.11 * Math.sin((2 * Math.PI * chapter.tone * i) / MEDIA_SAMPLE_RATE);
      pcm.writeInt16LE(Math.round(level * 32767), i * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(MEDIA_SAMPLE_RATE, 24);
  header.writeUInt32LE(MEDIA_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  MEDIA_WAV = Buffer.concat([header, pcm]);
  return MEDIA_WAV;
}

// The two decoy references are minted alongside the graded one and are always
// released, so "quoted the superseded bulletin" is distinguishable from "never
// reached chapter three" — a lazily minted decoy would leave that check
// vacuously false for a session that never played the rest of the recording.
function mediaState(session) {
  if (!session.media) {
    const codes = [];
    while (codes.length < 3) {
      const code = 'SKW-' + randomBytes(3).toString('hex').toUpperCase();
      if (!codes.includes(code)) codes.push(code);
    }
    session.media = {
      issuedAt: heldSlot(session.createdAt ?? Date.now()),
      reference: codes[0],
      supersedes: codes[1],
      identifier: codes[2],
      audioServed: 0,
      cueReads: 0,
      offPageReports: 0,
      heard: [],
      chapterJumps: 0,
      maxTime: 0,
      unlocks: 0,
      unlockedAt: null,
      unlockRoute: null,
    };
  }
  return session.media;
}

function mediaCueText(media, cue) {
  return cue.text
    .replace('__SUPERSEDES__', media.supersedes)
    .replace('__PREVIOUS__', slotTime(media.issuedAt - SLOT_MS))
    .replace('__IDENTIFIER__', media.identifier)
    .replace('__REFERENCE__', media.reference);
}

// pages/media/desk/ - the 18:00 bulletin's running order (pointer-drag). The
// stories live here and nowhere under pages/, and each session is dealt its
// own starting order and its own editor's note. The order changes only through
// one move per PATCH, and the lock takes no order: it freezes whatever the
// server has built, so posting the answer is not a route.
const DESK_STORIES = [
  { id: 'st-lifeboat', slug: 'LIFEBOAT', seconds: 45, summary: 'Braithe lifeboat launched to a yacht aground on Munroe Bank' },
  { id: 'st-ferry', slug: 'FERRY', seconds: 30, summary: 'Orrin Sound ferry cut to a reduced timetable from tomorrow' },
  { id: 'st-dredging', slug: 'DREDGING', seconds: 35, summary: 'Harbour dredging starts on Monday, with berths 4 to 7 closed' },
  { id: 'st-quota', slug: 'QUOTA', seconds: 40, summary: 'Fetlan skippers told the spring quota is nearly used up' },
  { id: 'st-foghorn', slug: 'FOGHORN', seconds: 25, summary: 'Braithe Light foghorn repair put back to August' },
  { id: 'st-regatta', slug: 'REGATTA', seconds: 20, summary: 'Talvig regatta moved to Sunday after the gale warning' },
  { id: 'st-pier', slug: 'PIER', seconds: 25, summary: 'Skerrow Head pier reopens to foot traffic after storm repairs' },
  { id: 'st-coastguard', slug: 'COASTGUARD', seconds: 20, summary: 'Coastguard exercise off Cape Ardnoy on Thursday, flares expected' },
  { id: 'st-cable', slug: 'CABLE', seconds: 20, summary: 'Subsea cable work closes Orrin Sound to anchoring for a week' },
];

const DESK_IDS = DESK_STORIES.map((s) => s.id);

const DESK_SLOT_SECONDS = 270;
const DESK_MOVES = [5, 6];

// Stories that must move, at fewest: those outside the longest run of
// `order` already in `target`'s relative order.
function deskMovesNeeded(order, target) {
  const tails = [];
  for (const x of order.map((id) => target.indexOf(id))) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = x;
  }
  return order.length - tails.length;
}

const deskReference = () => 'RO-' + randomBytes(3).toString('hex').toUpperCase();

// The starting order and the editor's order are a difficulty draw, so a seeded
// run deals paired conditions the same shuffle: five or six stories out of
// place, never fewer, and a different lead. How many is a pick, so a row names
// it and an experiment can hold it; the shuffle deals until it matches. The
// lock references, the 18:00 one and the two earlier bulletins' decoys, stay on
// randomBytes.
function deskState(session, { draw, pick }) {
  if (!session.mediaDesk) {
    const needed = pick('media.desk.moves', DESK_MOVES);
    const rand = lcg(draw('media.desk', 4));
    const shuffle = () => {
      const list = [...DESK_IDS];
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    };
    let dealt;
    let target;
    do {
      dealt = shuffle();
      target = shuffle();
    } while (dealt[0] === target[0] || deskMovesNeeded(dealt, target) !== needed);
    const refs = new Set();
    while (refs.size < 2) refs.add(deskReference());
    const [early, noon] = [...refs];
    session.mediaDesk = {
      dealt,
      target,
      order: [...dealt],
      fewestMoves: needed,
      earlier: [
        { bulletin: '07:00', reference: early },
        { bulletin: '12:00', reference: noon },
      ],
      moves: [],
      gestures: [],
      reads: 0,
      offPage: 0,
      refused: 0,
      lock: null,
    };
  }
  return session.mediaDesk;
}

function deskView(desk) {
  const story = (id) => DESK_STORIES.find((s) => s.id === id);
  return {
    bulletin: { slot: '18:00', seconds: DESK_SLOT_SECONDS },
    stories: desk.order.map((id) => {
      const { slug, seconds, summary } = story(id);
      return { id, slug, seconds, summary };
    }),
    note: { setAt: '17:21', order: desk.target.map((id) => story(id).slug) },
    earlier: desk.earlier,
    lock: desk.lock ? { reference: desk.lock.reference } : null,
  };
}

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
  // Did this request come from the player page, or from a shell? Same idiom as
  // the console fixture's `offPageReads`: Sec-Fetch-Site is a forbidden header
  // name for fetch()/XHR and the media element sets it too, but `curl -H` sets it
  // freely, so this is a counter and a route label, never a gate.
  const mediaFromPage = fromPage('/media/');
  // The same idiom for the desk, and the same limit: telemetry, never a gate.
  const deskFromPage = fromPage('/media/desk/');
  return async (req, res, url, pathname0) => {
    // pages/media/ — the held Skerrow recording (media-transcript). The cue list
    // is the only place the bulletin text exists, and the chapter-3 line is not
    // in it: `text` is null for the locked cue, so reading this payload straight
    // out of the network cannot produce the graded reference.
    if (req.method === 'GET' && pathname0 === '/api/media/cues') {
      const found = requireSession(req, res);
      if (!found) return;
      const media = mediaState(found.session);
      media.cueReads += 1;
      return json(res, 200, {
        bulletin: mediaBulletin(media),
        duration: MEDIA_DURATION,
        chapters: MEDIA_CHAPTERS.map(({ n, title, start, end }) => ({ n, title, start, end })),
        cues: MEDIA_SCRIPT.map((cue, index) => ({
          index,
          chapter: cue.chapter,
          start: cue.start,
          locked: Boolean(cue.locked),
          text: cue.locked ? null : mediaCueText(media, cue),
        })),
      });
    }

    // The recording itself. The nonce travels in `k` because an <audio src> can
    // set no headers, the same way the metrics CSV export is authenticated.
    // Fetching this is cheap for a shell client, so it is not treated as proof a
    // browser decoded anything: what makes a shell solve legible is that neither
    // this request nor the unlock report carried the player page's provenance.
    if (req.method === 'GET' && pathname0 === '/api/media/bulletin.wav') {
      const found = requireSession(req, res, url.searchParams.get('k'));
      if (!found) return;
      const media = mediaState(found.session);
      media.audioServed += 1;
      if (!mediaFromPage(req)) media.offPageReports += 1;
      const wav = mediaWav();
      // Ranges are served because that is what makes a jump to chapter 3 land
      // where it was aimed: without them the playhead can only move into the
      // part that has already been downloaded, so a jump taken moments after the
      // page loads clamps short and the graded cue is missed by seconds.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
        if (!(start <= end && end < wav.length)) {
          res.writeHead(416, { 'Content-Range': `bytes */${wav.length}` });
          return res.end();
        }
        const slice = wav.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Type': 'audio/wav',
          'Content-Length': slice.length,
          'Content-Range': `bytes ${start}-${end}/${wav.length}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
        return res.end(slice);
      }
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': wav.length,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      return res.end(wav);
    }

    // The transcript writes itself out as the playhead passes each cue, and this
    // is where it asks for the line. Every cue but one is already in the payload
    // the page holds; the locked cue's text is minted per session and released
    // only here, only once the reported playhead has reached it and only to a
    // session the recording was actually served to. `via`, the order of the
    // reports and the request's provenance are route telemetry for the
    // validator's detail line, never part of the pass decision — a page nonce is
    // enough to claim any of them.
    if (req.method === 'POST' && pathname0 === '/api/media/heard') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const media = mediaState(found.session);
      const index = Number(payload?.cue);
      const cue = Number.isInteger(index) ? MEDIA_SCRIPT[index] : undefined;
      if (!cue) return json(res, 400, { error: 'unknown cue' });
      const at = Number(payload?.t);
      if (!Number.isFinite(at) || at + 0.25 < cue.start) {
        return json(res, 409, { error: 'the playhead has not reached this cue' });
      }
      const heardBefore = MEDIA_SCRIPT.slice(0, index).every((_, i) => media.heard.includes(i));
      const fromPage = mediaFromPage(req);
      if (!fromPage) media.offPageReports += 1;
      if (payload?.via === 'chapter') media.chapterJumps += 1;
      if (at > media.maxTime) media.maxTime = at;
      if (!media.heard.includes(index)) media.heard.push(index);
      if (!cue.locked) return json(res, 200, { index, text: mediaCueText(media, cue) });
      if (media.audioServed === 0) {
        return json(res, 409, { error: 'the recording has not been loaded in this session' });
      }
      media.unlocks += 1;
      if (!media.unlockedAt) {
        media.unlockedAt = Date.now();
        // A report that did not come from the player page is its own route:
        // a shell solve costs one GET of the WAV, so `audioServed` cannot tell
        // it apart from a browser, but its provenance can.
        media.unlockRoute = !fromPage
          ? 'off-page'
          : heardBefore
            ? 'played-through'
            : media.chapterJumps > 0
              ? 'chapter-jump'
              : 'scripted-seek';
      }
      return json(res, 200, { index, text: mediaCueText(media, cue) });
    }

    if (req.method === 'GET' && pathname0 === '/api/media/rundown') {
      const found = requireSession(req, res);
      if (!found) return;
      const desk = deskState(found.session, ctx);
      desk.reads += 1;
      if (!deskFromPage(req)) desk.offPage += 1;
      return json(res, 200, deskView(desk));
    }

    // One move: the story in slot `from` takes slot `to`, the rows between
    // closing up, which is what a drop on another row does in the page. A
    // `story` that is no longer in slot `from` means the page was working from
    // a stale list, so nothing moves and the current list goes back. `via` and
    // `trusted` are what page script says about the gesture: route telemetry
    // for the validator's detail line, never graded.
    if (req.method === 'PATCH' && pathname0 === '/api/media/rundown/move') {
      let payload = await ctx.readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload.nonce);
      if (!found) return;
      const desk = deskState(found.session, ctx);
      if (desk.lock) {
        desk.refused += 1;
        return json(res, 409, { error: 'The running order is locked.', ...deskView(desk) });
      }
      const from = Number(payload.from);
      const to = Number(payload.to);
      const slots = desk.order.length;
      if (![from, to].every((n) => Number.isInteger(n) && n >= 0 && n < slots)) {
        return json(res, 400, { error: `Give slots from 0 to ${slots - 1}.` });
      }
      if (payload.story != null && desk.order[from] !== String(payload.story)) {
        return json(res, 409, { error: 'The running order changed on the desk. It has been reloaded.', ...deskView(desk) });
      }
      const fromPageCall = deskFromPage(req);
      if (!fromPageCall) desk.offPage += 1;
      if (from !== to) {
        const [id] = desk.order.splice(from, 1);
        desk.order.splice(to, 0, id);
        pushTrimmed(desk.moves, {
          story: id,
          from,
          to,
          via: ['pointer', 'keyboard', 'menu'].includes(payload.via) ? payload.via : 'other',
          trusted: payload.trusted === true,
          fromPage: fromPageCall,
          at: Date.now(),
        });
      }
      return json(res, 200, deskView(desk));
    }

    // The page cancels the browser's own drag-and-drop on the list and logs
    // each attempt here. A dragstart and a drop with no move after them is
    // the signature of a drag that never reached the pointer sensor. Telemetry
    // only, and capped: nothing grades it.
    if (req.method === 'POST' && pathname0 === '/api/media/rundown/events') {
      let payload = await ctx.readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload.nonce);
      if (!found) return;
      const desk = deskState(found.session, ctx);
      if (!['dragstart', 'drop'].includes(payload.type)) return json(res, 400, { error: 'unknown event' });
      if (desk.gestures.length < 200) {
        desk.gestures.push({
          type: payload.type,
          story: typeof payload.story === 'string' ? payload.story.slice(0, 40) : null,
          trusted: payload.trusted === true,
          fromPage: deskFromPage(req),
          at: Date.now(),
        });
      }
      return json(res, 200, { ok: true });
    }

    // Locking freezes the order the server holds; the body carries nothing but
    // the nonce. A session locks once, and a second request gets the first
    // lock's reference back rather than a new one.
    if (req.method === 'POST' && pathname0 === '/api/media/rundown/lock') {
      let payload = await ctx.readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload.nonce);
      if (!found) return;
      const desk = deskState(found.session, ctx);
      if (desk.lock) {
        desk.refused += 1;
        return json(res, 409, { error: 'The running order is already locked.', ...deskView(desk) });
      }
      const fromPageCall = deskFromPage(req);
      if (!fromPageCall) desk.offPage += 1;
      let reference = deskReference();
      while (desk.earlier.some((e) => e.reference === reference)) reference = deskReference();
      desk.lock = {
        reference,
        order: [...desk.order],
        moves: desk.moves.length,
        fromPage: fromPageCall,
        at: Date.now(),
      };
      return json(res, 200, deskView(desk));
    }

    return false;
  };
}

export function documents() {
  return {
    prefix: '/media/',

    onHtml({ url, found, body }) {
      if (body.includes('__SKW_')) {
        return { body: mediaRender(body, found.session.createdAt ?? Date.now(), url) };
      }
    },
  };
}
