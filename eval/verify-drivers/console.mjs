// pages/console/ — Cindergrid deploy console. The run log is painted to a
// <canvas>, so nothing in it reaches either snapshot surface; the golden path is
// the toolbar search box, whose server-returned hits render as real DOM.

import { snapText, until } from './lib.mjs';

export const DRIVERS = {
  'canvas-log': {
    note: 'canvas terminal; search box is the only snapshot-readable route',
    wrong: 'The release/gate step failed with error id E-4B21C7.',
    async run({ mcp, goto }) {
      const snap = () => snapText(mcp, { maxLines: 400 });

      await goto('/console/');
      // The viewer pages the log in 80 lines at a time; wait for the toolbar
      // counter to stop growing rather than for a fixed delay.
      let page = await until('the log to finish loading', async () => {
        const p = await snap();
        return /text="161 lines"/.test(p) ? p : null;
      });
      if (/E-[0-9A-F]{6}/.test(page)) {
        throw new Error('an error id was readable before searching — the canvas is leaking');
      }

      const box = page.match(/uid=(\S+) input "Search log"/)?.[1];
      if (!box) throw new Error('no search box in the snapshot');
      await mcp('fill_by_uid', { uid: box, value: 'ERROR' });

      // Every snapshot invalidates the previous uids, so re-read before clicking.
      page = await snap();
      const button = page.match(/uid=(\S+) button "Search"/)?.[1];
      if (!button) throw new Error('no search button in the snapshot');
      await mcp('click_by_uid', { uid: button });

      const hit = await until('a release/gate ERROR line in the hits', async () => {
        page = await snap();
        return page.match(
          /text="(E-[0-9A-F]{6})"\s*\n\s*uid=\S+ span text="release\/gate failed/
        );
      }, { tries: 20 });

      // Whether the hits also land inside the DEFAULT snapshot cap is a property
      // of the surface, not of the fixture, so it is recorded and not enforced:
      // `find` only searches what the snapshot returned, and a page long enough
      // to push them past the cap looks empty through that surface. That is the
      // finding this eval exists to report.
      const cappedText = await snapText(mcp);
      const withinDefaultCap =
        cappedText.includes(hit[1]) && /release\/gate failed/.test(cappedText);
      if (!withinDefaultCap) {
        console.log(
          '    canvas-log: the error line falls outside the default 100-line ' +
            'snapshot cap, so `find` cannot reach it through that surface'
        );
      }

      // The step summary is what disambiguates the four ERROR lines; assert the
      // fixture still marks exactly one step Failed.
      const failed = [...page.matchAll(/uid=\S+ span text="([^"]+)"\s*\n\s*uid=\S+ span text="Failed"/g)]
        .map((m) => m[1]);
      if (failed.length !== 1 || failed[0] !== 'release/gate') {
        throw new Error(`expected release/gate to be the only failed step, saw ${failed.join(',')}`);
      }

      // Every id is minted per session, so both batteries are built from the log
      // the search just returned. The alsoCorrect entries are the answer shape the
      // site's own ERROR search produces — all four ids, each filed under its own
      // step. The wrong entries are an undesignated dump and a swapped
      // attribution. A blunt decoy count rejects the first shape and accepts the
      // second, so both batteries pin the distinction.
      const idFor = (step) =>
        page.match(
          new RegExp(`text="(E-[0-9A-F]{6})"\\s*\\n\\s*uid=\\S+ span text="${step}`)
        )?.[1] ?? null;
      const scan = idFor('scan/deps');
      const push = idFor('push/registry');
      const cleanup = idFor('cleanup/artifacts');
      if (!scan || !push || !cleanup) {
        throw new Error('the three non-blocking ERROR ids were not all in the search hits');
      }
      this.alsoCorrect = [
        `Error id: ${hit[1]}. The other ERROR lines belong to other steps: scan/deps ` +
          `logged ${scan}, push/registry logged ${push}, and cleanup/artifacts logged ` +
          `${cleanup} — all non-blocking.`,
        `| step | error id |\n| scan/deps | ${scan} |\n| push/registry | ${push} |\n` +
          `| release/gate | ${hit[1]} |\n| cleanup/artifacts | ${cleanup} |\n` +
          `release/gate is the Failed step, so the answer is ${hit[1]}.`,
      ];
      this.wrong = [
        'The release/gate step failed with error id E-4B21C7.',
        `The run log shows ERROR ids ${scan}, ${push}, ${hit[1]} and ${cleanup}.`,
        `The failing step release/gate recorded error id ${push}; ${hit[1]} was logged by scan/deps.`,
        `The release/gate step failed. Its error id is ${cleanup}.`,
      ];

      const fields = { errorId: hit[1] };
      this.wrongFields = [{ errorId: 'E-000000' }];
      this.alsoCorrectFields = [fields, { errorId: hit[1].toLowerCase() }];
      return {
        text:
          `Run 4192 stopped at the release/gate step. The run log records error id ` +
          `${hit[1]} on line 88: no build attestation for the image.`,
        fields,
      };
    },
  },
};
