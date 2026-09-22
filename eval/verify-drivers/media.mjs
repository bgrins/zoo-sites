// Golden path for the Skerrow Coastal Radio bulletin recording
// (pages/media/, task media-transcript). See probes.mjs for the contract.
import { clickToPath, esc, until } from './lib.mjs';

const REF = /Log reference (SKW-[0-9A-F]{6})/;
// The rail's playhead, "mm:ss / 00:48", is the only place a snapshot can see
// that the recording is actually decoding and running.
const PLAYHEAD = /(\d\d):(\d\d) \/ 00:48/;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const SLOT = 6 * 3600000;
const hhmm = (t) => new Date(t).toISOString().slice(11, 16).replace(':', '');
const month = (t) => MONTH_NAMES[new Date(t).getUTCMonth()];
const dayMonth = (t) => `${new Date(t).getUTCDate()} ${month(t)}`;
const short = (t) => `${new Date(t).getUTCDate()} ${month(t).slice(0, 3)}`;
const iso = (t) => new Date(t).toISOString().slice(0, 16);

// The held recording is the last transmission before the session opened
// (sites/media.mjs), so on whatever day the gate runs it is inside its six-hour
// window. The list prints no year: the held time is read as the latest such
// time up to now, and every other row and page is checked against it.
async function heldRecording(evaluate) {
  const shown = await evaluate(() => ({
    html: document.documentElement.outerHTML,
    rows: [...document.querySelectorAll('.listing li')].map((li) => ({
      when: li.querySelector('.when')?.textContent.trim(),
      label: li.querySelector('a')?.textContent.trim(),
      href: li.querySelector('a')?.getAttribute('href'),
      state: li.querySelector('.state')?.textContent.trim(),
    })),
  }));
  if (/__SKW_/.test(shown.html)) throw new Error('unrendered recording tokens on the bulletin list');
  const now = Date.now();
  const first = /^(\d{1,2}) ([A-Z][a-z]+), (\d\d)(\d\d) UTC$/.exec(shown.rows[0]?.when ?? '');
  if (!first) throw new Error(`the first listed recording is dated "${shown.rows[0]?.when}"`);
  const year = new Date(now).getUTCFullYear();
  const held = [year, year - 1]
    .map((y) => Date.UTC(y, MONTH_NAMES.indexOf(first[2]), +first[1], +first[3], +first[4]))
    .find((t) => t <= now);
  // The session opened moments before this read, so the slack only covers a
  // session minted just before the next transmission.
  if (!(now - held < SLOT + 10 * 60000)) {
    throw new Error(`the held recording went out at ${iso(held)}, outside its six hours at ${iso(now)}`);
  }
  const want = Array.from({ length: 5 }, (_, k) => {
    const at = held - k * SLOT;
    return {
      when: `${dayMonth(at)}, ${hhmm(at)} UTC`,
      label: `${short(at)} ${hhmm(at)} recording`,
      href: k ? `expired.html?t=${hhmm(at)}` : 'bulletin.html',
      state: k ? 'Purged' : 'Held',
    };
  });
  if (JSON.stringify(shown.rows) !== JSON.stringify(want)) {
    throw new Error(`the bulletin list reads ${JSON.stringify(shown.rows)}, not six-hourly back from ${iso(held)}`);
  }
  const previous = held - SLOT;
  const purged = await evaluate(
    `async () => (await (await fetch(${JSON.stringify(want[1].href)})).text()).match(/id="purged">([^<]*)</)?.[1]`
  );
  const names = `The ${short(previous)} ${hhmm(previous).slice(0, 2)}:${hhmm(previous).slice(2)} transmission`;
  if (!purged?.startsWith(names)) throw new Error(`the purged page for ${want[1].href} reads "${purged}"`);
  return {
    label: want[0].label,
    issued: `${hhmm(held)} UTC, ${dayMonth(held)}`,
    valid: `${hhmm(held + 2 * SLOT)} UTC, ${dayMonth(held + 2 * SLOT)}`,
    previous: hhmm(previous),
  };
}

export const DRIVERS = {
  'media-transcript': {
    note:
      'plays the recording through its chapter-1 "Supersedes" cue (proves decode + timeupdate, ' +
      'and puts that decoy on the transcript), then jumps to chapter 3 and reads the transcript ' +
      'from the snapshot, so the decoy pin never touches ctx.pages.state; the chapter-4 ' +
      'identifier decoy sits past the playhead and stays unreachable, which is why it has no live pin',
    wrong: ['The log reference read out in the third chapter is SKW-4B19C2.'],
    async run({ goto, mcp, snapshot, evaluate }) {
      await goto('/media/');
      const held = await heldRecording(evaluate);
      // The five recordings differ only by their link text, so resolve the held
      // one by name rather than by position. clickToPath proves the document
      // moved: a click that reports success without navigating otherwise
      // leaves the next poll waiting a full minute on the list page.
      await clickToPath(
        mcp,
        evaluate,
        async () => (await snapshot()).match(new RegExp(`uid=(\\S+) a "${esc(held.label)}"`))?.[1] ?? null,
        '/bulletin.html',
        `the held ${held.label}`
      );
      const facts = await evaluate(() =>
        [...document.querySelectorAll('.facts p')].map((p) => p.textContent.replace(/\s+/g, ' ').trim())
      );
      if (!facts.includes(`Issued${held.issued}`) || !facts.includes(`Valid until${held.valid}`)) {
        throw new Error(`the bulletin page reads ${JSON.stringify(facts)}, not issued ${held.issued}`);
      }
      let snap = '';

      // The chapter rail is drawn from /api/media/cues and the transport only
      // enables once the recording has loaded, so poll for both rather than
      // sleeping a fixed time.
      await until('chapter 3 to appear on the loaded bulletin page', async () => {
        snap = await snapshot();
        return (
          /text="Ready, 00:48"/.test(snap) && /uid=(\S+) span text="03 Station reports"/.test(snap)
        );
      });

      // Play a couple of seconds before taking the shortcut: the chapter jump
      // alone would still pass if the WAV never decoded or `timeupdate` never
      // fired, and playback is the capability this fixture exists to measure.
      // Play is idempotent, so a click that did not land is simply re-issued on
      // a fresh uid rather than waited on for the whole poll budget.
      let played = false;
      for (let attempt = 0; attempt < 4 && !played; attempt++) {
        const play = snap.match(/uid=(\S+) button "Play"/);
        if (!play) throw new Error('the Play control never enabled');
        await mcp('click_by_uid', { uid: play[1] });
        played = await until('the playhead to advance past 00:02 while playing', async () => {
          snap = await snapshot();
          const at = snap.match(PLAYHEAD);
          return Boolean(at) && Number(at[1]) * 60 + Number(at[2]) >= 2;
        }, { tries: 60 }).catch(() => false);
      }
      if (!played) throw new Error('the playhead never advanced after 4 Play clicks');
      // Keep listening to the chapter-1 decoy at 00:08, which a jump does not
      // reliably write out: the transcript records only the chapter it lands in.
      const supersedes = await until('the chapter 1 Supersedes decoy to render', async () => {
        snap = await snapshot();
        return snap.match(/Supersedes (SKW-[0-9A-F]{6})/)?.[1] ?? null;
      });
      const transcript = await evaluate(() => document.getElementById('transcript').innerText);
      if (!String(transcript).includes(`Supersedes ${supersedes} from ${held.previous}.`)) {
        throw new Error(`the chapter 1 line does not supersede the ${held.previous} bulletin`);
      }
      const pause = snap.match(/uid=(\S+) button "Pause"/);
      if (pause) await mcp('click_by_uid', { uid: pause[1] });

      // The button's text lives in child spans, so the snapshot offers the span
      // rather than the button; clicking it is what an agent has to do too.
      snap = await snapshot();
      const chapter = snap.match(/uid=(\S+) span text="03 Station reports"/);
      if (!chapter) throw new Error('the chapter rail vanished after playback started');
      await mcp('click_by_uid', { uid: chapter[1] });

      const found = await until('the chapter 3 log reference to reach the transcript', async () => {
        snap = await snapshot();
        return snap.match(REF);
      });

      const fields = { logReference: found[1] };
      this.wrongFields = [
        { logReference: found[1] + 'F' },
        { logReference: 'SKW-000000' },
        // The chapter-1 decoy: a real minted code, announced in the recording.
        { logReference: supersedes },
      ];
      this.alsoCorrectFields = [fields, { logReference: found[1].toLowerCase() }];
      this.wrong = [
        this.wrong[0],
        `The recording announces log reference ${supersedes}; the third chapter ` +
          `confirms the station reports are filed under it.`,
      ];
      this.alsoCorrect = [
        `Recording: ${held.label.replace(/ recording$/, '')}\nChapter 3: Station reports\nLog reference: ${found[1]}`,
        `The reference announced in Station reports is ` +
          `${found[1].toLowerCase().replace('-', ' ')}.`,
        `Chapter 1 notes the bulletin supersedes ${supersedes} from the ${held.previous} issue; ` +
          `the log reference announced in chapter 3 is ${found[1]}.`,
      ];
      return {
        text:
          `I opened the ${held.label} and skipped to chapter 3, Station reports. ` +
          `The log reference read out there is ${found[1]}.`,
        fields,
      };
    },
  },
};
