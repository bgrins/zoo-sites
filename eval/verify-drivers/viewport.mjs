// Golden-path driver for the responsive-layout task on pages/shop/voltro/.
// See probes.mjs for the contract.

import { addSession, bumpCode, findSession, snapText, uidOf, until } from './lib.mjs';

const SNAP_LINES = 500;
// The store's own mobile breakpoint; the driver asserts the layout really
// crossed it rather than trusting the width it asked for.
const BREAKPOINT = 600;
// Restored at the end: verify.mjs reuses one browser for every task, so a
// window left at phone width would silently reshape later drivers' snapshots.
const DESKTOP = { width: 1366, height: 768 };

const snap = (h) => snapText(h.mcp, { maxLines: SNAP_LINES });

export const DRIVERS = {
  // --- responsive layout: the only Deals link exists below 600 CSS px ---
  'narrow-viewport': {
    note: 'set_viewport_size 480, opens the collapsed menu, follows Deals of the Day',
    wrong: ["Today's deal code is DEAL-NARROW-49."],
    async run(h) {
      try {
        await h.goto('/shop/voltro/');
        await until(
          'voltro listing cards',
          () => h.evaluate(() => document.querySelectorAll('#grid .card').length),
          { gap: 200 }
        );
        // Precondition: at desktop width neither the toggle nor any link to the
        // deals page exists, so the task cannot be won without resizing.
        const desktop = await h.evaluate(() => ({
          toggle: !!document.getElementById('menubtn'),
          dealsLinks: [...document.querySelectorAll('a')].filter((a) =>
            /deals\.html/.test(a.getAttribute('href') ?? '')
          ).length,
        }));
        if (desktop.toggle || desktop.dealsLinks) {
          throw new Error(
            `mobile affordances leaked into the desktop layout: ${JSON.stringify(desktop)}`
          );
        }

        await h.mcp('set_viewport_size', { width: 480, height: 900 });
        // Headless Firefox clamps the window to a ~500px minimum width, so the
        // graded fact is the layout state, not the number we asked for.
        const width = await until(
          'the mobile layout to take effect',
          () =>
            h.evaluate(() =>
              window.matchMedia('(max-width: 600px)').matches ? window.innerWidth : false
            ),
          { gap: 200 }
        );
        if (width > BREAKPOINT) {
          throw new Error(`viewport reports ${width}px, wider than the ${BREAKPOINT}px breakpoint`);
        }

        const collapsed = await snap(h);
        const menuUid = uidOf(collapsed, 'button "Menu"');
        if (!menuUid) throw new Error('no collapsed menu toggle in the snapshot');
        await h.mcp('click_by_uid', { uid: menuUid });
        // The menu panel carries the `hidden` attribute until the toggle is
        // clicked and the walker omits hidden nodes, so the link only exists
        // after a real click.
        const dealsUid = await until(
          'the Deals of the Day link in the snapshot',
          async () => uidOf(await snap(h), 'a "Deals of the Day"'),
          { tries: 25, gap: 200 }
        );
        await h.mcp('click_by_uid', { uid: dealsUid });

        // The graded answer is read out of the SNAPSHOT, not out of evaluate():
        // snapshot legibility of the code is the surface property this task
        // leans on, so a deals page that outgrew the walker must fail here.
        const snapCode = await until(
          'the deal code in the snapshot',
          async () => (await snap(h)).match(/text="(DEAL-[0-9A-F]{6})"/)?.[1],
          { tries: 25, gap: 200 }
        );
        const deal = await until(
          'the deal code on the deals page',
          () =>
            h.evaluate(() => {
              const code = document.getElementById('code')?.textContent.trim();
              if (!code) return false;
              return { code, width: window.innerWidth, path: location.pathname };
            }),
          { gap: 200 }
        );
        if (!/\/deals\.html$/.test(deal.path)) {
          throw new Error(`ended up on ${deal.path} instead of the deals page`);
        }
        if (deal.code !== snapCode) {
          throw new Error(`snapshot read ${snapCode} but the page holds ${deal.code}`);
        }
        const fields = { dealCode: deal.code };
        this.wrongFields = [
          { dealCode: 'DEAL-0000' },
          { dealCode: bumpCode(deal.code) },
          { dealCode: `(${bumpCode(deal.code)})` },
          { dealCode: deal.code.slice(5) + '0' },
        ];
        this.alsoCorrectFields = [
          fields,
          { dealCode: deal.code.toLowerCase() },
          { dealCode: deal.code.replace('-', '\u2013') },
          { dealCode: `**${deal.code}**` },
          { dealCode: `${deal.code}.` },
          { dealCode: deal.code.replace('-', '-\u200b') },
        ];
        const minted = (state) => findSession(state, (s) => s.voltroDeal?.code === deal.code).session;
        this.wrongState = [
          {
            name: 'the reported code was minted without a narrow load the server saw',
            mutate: (state) => (minted(state).voltroDeal.issuedNarrow = false),
          },
        ];
        this.alsoCorrectState = [
          {
            name: 'a probe session met the deals page at desktop width first',
            mutate: (state) =>
              addSession(
                state,
                {
                  voltroDeal: {
                    ...structuredClone(minted(state).voltroDeal),
                    code: null,
                    issuedWidth: null,
                    issuedNarrow: false,
                    widths: [1366],
                    navBanner: { phone: 0, wide: 1 },
                  },
                },
                { first: true }
              ),
          },
        ];
        this.wrong = [
          this.wrong[0],
          `At ${width}px the menu revealed the deals page, but the code had rotated ` +
            `by the time I read it; the nearest I captured was ${bumpCode(deal.code)}.`,
          `The deals page rendered at ${width}px, but the deal code was cut off in my ` +
            `snapshot, so I cannot say what today's code is.`,
        ];
        this.alsoCorrect = [
          `Viewport: ${width}px (inside the mobile breakpoint)\nDeal code: ${deal.code}`,
          `The window settled at ${width}px, under the store's 600px breakpoint; the ` +
            `Menu button exposed a Deals of the Day link and today's deal code is ${deal.code}.`,
          `Today's deal code is ${deal.code.toLowerCase().replace('-', ' ')}.`,
        ];
        return {
          text:
            `I resized the browser to 480px wide (Firefox settled at ${width}px, still inside ` +
            `the store's mobile breakpoint), which collapsed the department bar into a Menu ` +
            `button. Opening that menu revealed a Deals of the Day link that is not present in ` +
            `the desktop layout. Today's deal code is ${deal.code}.`,
          fields,
        };
      } finally {
        await h.mcp('set_viewport_size', DESKTOP).catch(() => {});
      }
    },
  },
};
