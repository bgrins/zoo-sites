// Golden-path driver for pages/shop/gadgetron-mirror/ (T043). See probes.mjs
// for the contract.

import { ANSWERS } from '../answers.mjs';
import { addSession, findSession, straySession, textOf, uidOf, until } from './lib.mjs';

const SNAP_LINES = 300;

const snapshot = async (h) => textOf(await h.mcp('take_snapshot', { maxLines: SNAP_LINES }));

function uid(snap, pattern, label) {
  const m = uidOf(snap, pattern);
  if (!m) throw new Error(`no snapshot node for ${label}`);
  return m;
}

// The mirror paints its price from a session-gated fetch, so poll the snapshot
// instead of sleeping: a fixed wait is a coin flip on a cold browser.
const waitForSnapshot = (h, re, label) =>
  until(
    label,
    async () => {
      const snap = await snapshot(h);
      return re.test(snap) ? snap : null;
    },
    { gap: 200 }
  );

export const DRIVERS = {
  // --- partial outage: the primary store is masked, the price lives on the mirror ---
  'mirror-reroute': {
    note: 'clicks splash -> mirror -> department -> dock; asserts serverModes armed the outage',
    wrong:
      'The Kessvar DK-100 dock is $129.00, listed on the main Gadgetron store ' +
      'at /shop/gadgetron/.',
    async run(h, ctx) {
      // The outage is armed by the harness (run.mjs and verify.mjs both apply
      // the task's serverModes after state.reset()), NOT by this driver: that
      // plumbing is new, so the golden path has to exercise it rather than
      // paper over a break in it.
      if (!ctx.pages.state.modes?.gadgetronDown) {
        throw new Error('serverModes did not arm gadgetronDown: is the T043 plumbing applied?');
      }
      // Precondition: the outage is an outage to a client that reads statuses.
      // The primary answers 503 with a Retry-After, pages and assets alike, and
      // its catalog, order-list and quote APIs answer 503 to a session holding
      // a mirror page's nonce, while another store's catalog still answers.
      for (const path of ['/shop/gadgetron/', '/shop/gadgetron/gadgetron.css']) {
        const res = await fetch(h.base + path);
        if (res.status !== 503 || !res.headers.get('retry-after')) {
          throw new Error(`${path} answered ${res.status} (Retry-After ${res.headers.get('retry-after')}) during the outage`);
        }
      }
      const stray = await straySession(h.base, '/shop/gadgetron-mirror/docks.html', { reply: 'response' });
      const calls = [
        ['catalog', stray.get('/api/shop/catalog?store=gadgetron')],
        ['cart add', stray.post('/api/shop/cart/add', { store: 'gadgetron', sku: 'BP-27U', qty: 1 })],
        ['order list', stray.get('/api/shop/cart?store=gadgetron')],
        ['bulk quote', stray.post('/api/gadgetron/bulk-quote', { email: 'buyer@example.com', lines: ['BP-27U x 20'] })],
      ];
      for (const [label, call] of calls) {
        const { status } = await call;
        if (status !== 503) throw new Error(`the gadgetron ${label} API answered ${status} during the outage`);
      }
      if ((await stray.get('/api/shop/catalog?store=marrowgate')).status !== 200) {
        throw new Error("the outage took Marrowgate's catalog down with Gadgetron's");
      }

      await h.goto('/shop/gadgetron/');
      const splash = await waitForSnapshot(
        h,
        /Store maintenance in progress/,
        'the maintenance splash on the primary store'
      );
      const storeUrl = await h.evaluate(() => location.href);
      // Every path under the primary store answers with this splash, so a footer
      // link back into the store only reloads it.
      const loops = await h.evaluate(
        `() => [...document.querySelectorAll('footer a')].map((a) => a.href)
          .filter((href) => href.startsWith(${JSON.stringify(storeUrl)}))`
      );
      if (loops.length) throw new Error(`splash footer links lead back to the splash: ${loops.join(', ')}`);
      // The route out is a link whose TEXT is the mirror path: a snapshot href is
      // absolutized and truncated at 27 chars, so it can never be read back.
      const route = uid(splash, 'a "the read-only mirror node"', 'mirror route link');
      await h.mcp('click_by_uid', { uid: route });

      const depts = await waitForSnapshot(h, /Docks, hubs and power/, 'the mirror department list');
      await h.mcp('click_by_uid', {
        uid: uid(depts, 'a "Docks, hubs and power"', 'docks department link'),
      });

      // The department listing is a <table>, which the snapshot walker drops
      // whole; only the links inside it bubble up, so the spec sheet is the one
      // reachable route to the price through this surface.
      const rows = await waitForSnapshot(h, /Kessvar DK-100/, 'the docks department listing');
      // Precondition: the sheet is the snapshot of the primary store's docks
      // department it claims to be, both GadgetDock hubs included, and the sync
      // log counts the rows it lists.
      const skus = await h.evaluate(() => [...document.querySelectorAll('#rows tr')].map((tr) => tr.dataset.sku));
      if (!['GDX-HUB', 'GDX-HUB2', ANSWERS.mirrorReroute.dockSku].every((sku) => skus.includes(sku))) {
        throw new Error(`the mirror docks sheet lists ${skus.join(', ')}`);
      }
      const log = await (await fetch(h.base + '/shop/gadgetron-mirror/sync-log.html')).text();
      const synced = /Docks, hubs and power<\/td><td>Synced, (\d+) rows/.exec(log)?.[1];
      if (Number(synced) !== skus.length) {
        throw new Error(`the sync log counts ${synced} dock rows, the sheet lists ${skus.length}`);
      }
      await h.mcp('click_by_uid', {
        uid: uid(rows, 'a "Kessvar DK-100(?: dock)?"', 'Kessvar spec sheet link'),
      });

      const sheet = await waitForSnapshot(
        h,
        /uid=\S+ p text="\$\d+\.\d\d"/,
        'the mirror price on the Kessvar spec sheet'
      );
      const price = sheet.match(/uid=\S+ p text="\$(\d+\.\d\d)"/)[1];
      // Read off the page, so under --origins the answer names the mirror's own
      // origin, the URL an agent there actually reads.
      const url = await h.evaluate(() => location.href);
      const dock = Number(String(price).replace(/[$,]/g, ''));
      const fields = { price: dock, sourceUrl: url };
      const at = new URL(url);
      this.wrongFields = [
        { price: dock + 10, sourceUrl: url },
        { price: dock, sourceUrl: 'http://example.invalid/shop/gadgetron/' },
        { price: dock, sourceUrl: new URL('docks.html', storeUrl).href },
        { price: Number(ANSWERS.mirrorReroute.decoyDocks['KB-DK9']), sourceUrl: url },
        // The GadgetDock DX2 Hub, the sheet's other 12-port 100 W dock, whose
        // fixed price sits inside the mint's dollar range.
        { price: 88.5, sourceUrl: url },
        // Under --origins the mirror sits at the root of its own port, so the
        // port alone identifies it: one more digit is another origin. Under
        // --vhosts the host identifies it, so the same path on the primary
        // store's host is the other origin.
        ...(at.port && !/mirror/.test(at.pathname)
          ? [
              {
                price: dock,
                sourceUrl: at.hostname.endsWith('.localhost')
                  ? `${at.protocol}//${new URL(storeUrl).host}${at.pathname}`
                  : `${at.protocol}//${at.hostname}:${at.port}0${at.pathname}`,
              },
            ]
          : []),
      ];
      this.alsoCorrectFields = [
        fields,
        { price: dock, sourceUrl: '/api/mirror/catalog?sku=KV-DK100' },
        { price: dock, sourceUrl: 'mirror node, kessvar-dk-100.html' },
        { price: dock, sourceUrl: 'the mirror catalog entry for KV-DK100' },
      ];
      // A different mint for a probe session, so the price alone tells the
      // two sessions apart.
      const otherPrice = `${79 + ((Math.trunc(dock) - 79 + 1) % 40)}.${price.split('.')[1]}`;
      const probe = (reads) => ({
        mirror: { dockPrice: otherPrice, navs: 1, dataReads: reads, pages: ['/shop/gadgetron-mirror/'] },
      });
      this.alsoCorrectState = [
        {
          name: 'a probe session loads the mirror first and reads nothing',
          mutate: (state) => addSession(state, probe(0), { first: true }),
        },
        {
          name: 'a probe session reads the sheet first at its own minted price',
          mutate: (state) => addSession(state, probe(1), { first: true }),
        },
      ];
      this.wrongState = [
        {
          name: 'the session holding the reported price never read the price sheet',
          mutate(state) {
            findSession(state, (s) => s.mirror?.dockPrice === price).session.mirror.dataReads = 0;
          },
        },
        {
          name: 'only a probe session read the sheet, at its own price',
          mutate(state) {
            findSession(state, (s) => s.mirror?.dockPrice === price).session.mirror.dataReads = 0;
            addSession(state, probe(1), { first: true });
          },
        },
      ];
      this.wrong = [
        `The Kessvar DK-100 dock is $129.00, listed on the main Gadgetron store ` +
          `at /shop/gadgetron/.`,
        `Reading the mirror's docks department, the DK-100 lists at $148.00; ` +
          `source: ${url}.`,
        `The Kessvar DK-100 dock is $${price}, read from ` +
          `${new URL('docks.html', storeUrl).href} on the main store.`,
      ];
      this.alsoCorrect = [
        `The main store only serves a maintenance splash, which routes to the ` +
          `read-only mirror; the mirror's spec sheet prices the Kessvar DK-100 ` +
          `at $${price}. Source: ${url}.`,
        `Price: $${price}\nSource URL: ${url}`,
        `Found it through the mirror catalog API (api/mirror/catalog) — the entry ` +
          `for SKU KV-DK100 gives $${price}.`,
      ];
      return {
        text:
          `Gadgetron's main store is down for scheduled maintenance (incident MB-3-1174), ` +
          `and the splash points at the read-only mirror node. The Kessvar DK-100 dock ` +
          `(part no. KV-DK100) is $${price} there, per unit excluding tax. I read it from ` +
          `${url}, which is the mirror's spec sheet for that part; the mirror accepts no orders.`,
        fields,
      };
    },
  },
};
