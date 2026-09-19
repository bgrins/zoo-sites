// pages/media/ - Skerrow Coastal Radio recording (media-transcript).
import { randomBytes } from 'node:crypto';

// pages/media/ — Skerrow Coastal Radio, the 0535 coastal forecast recording
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

const MEDIA_BULLETIN = {
  station: 'SKW',
  name: 'Skerrow Coastal Radio',
  title: 'Coastal forecast, 0535 UTC',
  issued: '0535 UTC, 26 July',
};

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
  { chapter: 1, start: 8, text: 'Supersedes __SUPERSEDES__ from 2335.' },
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
    .replace('__IDENTIFIER__', media.identifier)
    .replace('__REFERENCE__', media.reference);
}

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
  // Did this request come from the player page, or from a shell? Same idiom as
  // the console fixture's `offPageReads`: Sec-Fetch-Site is a forbidden header
  // name for fetch()/XHR and the media element sets it too, but `curl -H` sets it
  // freely, so this is a counter and a route label, never a gate.
  const mediaFromPage = fromPage('/media/');
  return async (req, res, url, pathname0) => {
    // pages/media/ — the Skerrow 0535 recording (media-transcript). The cue list
    // is the only place the bulletin text exists, and the chapter-3 line is not
    // in it: `text` is null for the locked cue, so reading this payload straight
    // out of the network cannot produce the graded reference.
    if (req.method === 'GET' && pathname0 === '/api/media/cues') {
      const found = requireSession(req, res);
      if (!found) return;
      const media = mediaState(found.session);
      media.cueReads += 1;
      return json(res, 200, {
        bulletin: MEDIA_BULLETIN,
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

    return false;
  };
}
