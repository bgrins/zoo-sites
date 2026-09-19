// Golden paths for the Marlowe Depot Systems fixture (pages/depot/): the
// devtools-surface tasks shard-forensics, body-only-ref and partial-import
// (T120/T122/T123). All three solve honestly through
// the MCP tool surface: the network log for the two failure-forensics tasks,
// the console log for the silent partial import. No driver ever reads a
// response body out of a network tool (ours never returns one).

import { bumpCode, until, uidOf, textOf } from './lib.mjs';

const TRACE = /^DT-[0-9A-F]{8}$/i;
const REF = /^MR-[0-9A-F]{8}$/i;

async function readJson(mcp, name, args) {
  return JSON.parse(textOf(await mcp(name, args)));
}

export const DRIVERS = {
  'shard-forensics': {
    note:
      'signs in through the page and lets it navigate, then reads the 502 out of the CUMULATIVE ' +
      'network log (list_network_requests statusMin 500 -> get_network_request for the ' +
      'X-Depot-Trace header). The trace exists only in that header, so this also proves the ' +
      'header survives into the tool output.',
    wrong: 'The sign-in request /api/depot/signin failed with status 502, trace id DT-00000000.',
    async run({ mcp, goto, snapshot }) {
      await goto('/depot/');
      const btn = uidOf(await snapshot(), 'button "Sign in"');
      if (!btn) throw new Error('no Sign in button in the snapshot');
      await mcp('click_by_uid', { uid: btn });

      // The page signs in, meets the 502, falls back to the cached roster and
      // navigates; the dashboard shows yesterday's date and nothing else.
      const snap = await until('the dashboard to render the cached (Sun 27 Jul) roster', async () => {
        const s = await snapshot();
        return /Sun 27 Jul/.test(s) ? s : null;
      });
      if (/DT-[0-9A-F]{8}/i.test(snap)) throw new Error('the trace id leaked into the DOM');

      // The failure happened on the PREVIOUS document; only a cumulative log
      // still has it. Filter server errors, then pin the roster request.
      const hit = await until('a 502 on /api/depot/roster in the network log', async () => {
        const list = await readJson(mcp, 'list_network_requests', {
          statusMin: 500,
          format: 'json',
        });
        return (list.requests ?? []).find(
          (r) => r.url.includes('/api/depot/roster') && r.status === 502
        ) ?? null;
      }, { tries: 20 });

      const det = await readJson(mcp, 'get_network_request', { id: hit.id, format: 'json' });
      const trace = Object.entries(det.responseHeaders ?? {}).find(
        ([k]) => k.toLowerCase() === 'x-depot-trace'
      )?.[1];
      if (!trace || !TRACE.test(trace)) {
        throw new Error(`X-Depot-Trace missing or malformed on the 502: ${trace}`);
      }

      const path = new URL(hit.url).pathname + new URL(hit.url).search;
      const shard = Number(new URL(hit.url).searchParams.get('shard'));
      const healthyShard = [1, 2, 3, 4].find((n) => n !== shard);
      const fields = { failedRequest: path, statusCode: 502, traceId: trace };
      this.wrongFields = [
        // Misattributed to the sign-in POST that succeeded.
        { failedRequest: '/api/depot/signin', statusCode: 502, traceId: trace },
        // Misattributed to the cached-roster fallback file (a 200), which also
        // contains the word "roster", by path and in prose.
        { failedRequest: '/depot/data/roster-cache.json', statusCode: 502, traceId: trace },
        { failedRequest: 'the cached roster file', statusCode: 502, traceId: trace },
        { failedRequest: 'the cached-roster fallback', statusCode: 502, traceId: trace },
        { failedRequest: 'the request for the cached roster', statusCode: 502, traceId: trace },
        { failedRequest: 'the roster served from the cache', statusCode: 502, traceId: trace },
        // The fallback named first, the live endpoint only as context.
        {
          failedRequest: '/depot/data/roster-cache.json (fallback after /api/depot/roster failed)',
          statusCode: 502,
          traceId: trace,
        },
        // A shard the page never requested (it would have answered 200).
        { failedRequest: `/api/depot/roster?shard=${healthyShard}`, statusCode: 502, traceId: trace },
        // Right request, wrong status.
        { failedRequest: path, statusCode: 404, traceId: trace },
        // Fabricated trace.
        { failedRequest: path, statusCode: 502, traceId: 'DT-00000000' },
      ];
      this.alsoCorrectFields = [
        fields,
        { failedRequest: `GET /api/depot/roster (shard ${det.url.match(/shard=(\d)/)?.[1] ?? '?'})`, statusCode: 502, traceId: trace.toLowerCase() },
        { failedRequest: 'the roster request', statusCode: 502, traceId: trace },
        // Prose that sets the live request against the cache.
        { failedRequest: 'the non-cached roster request', statusCode: 502, traceId: trace },
        { failedRequest: 'the roster request, not the cached fallback', statusCode: 502, traceId: trace },
        {
          failedRequest: 'the roster fetch that should have replaced the cached roster',
          statusCode: 502,
          traceId: trace,
        },
        // The live endpoint named alongside the fallback it triggered.
        {
          failedRequest: `GET ${path} (the page then fell back to roster-cache.json)`,
          statusCode: 502,
          traceId: trace,
        },
      ];
      this.alsoCorrect = [
        `The sign-in POST itself returned 200; what failed was the follow-up roster fetch ` +
          `${path}, which came back 502 Bad Gateway with trace id ${trace}. The dashboard ` +
          `silently fell back to the cached Sun 27 Jul roster.`,
        `Failed request: GET ${path}\nStatus: 502\nTrace id: ${trace}`,
        `The roster fetch is the failure - 502 Bad Gateway, trace id ${trace.toLowerCase()}; ` +
          `sign-in itself succeeded and the page quietly showed the cached roster.`,
      ];
      this.wrong = [
        this.wrong,
        `The request ${path} failed with status 502. Trace ids seen this session: none.`,
        `The cached roster file /depot/data/roster-cache.json failed with a 502; the server ` +
          `returned trace id ${trace} with it.`,
        `The sign-in POST /api/depot/signin failed with status 502; its X-Depot-Trace ` +
          `header read ${trace}.`,
      ];
      return {
        text:
          `Sign-in succeeded, but the dashboard's roster fetch failed: GET ${path} ` +
          `returned 502 Bad Gateway. The server sent the trace id ${trace} in the ` +
          `X-Depot-Trace response header, and the page silently fell back to the cached ` +
          `roster from Sun 27 Jul.`,
        fields,
      };
    },
  },

  'body-only-ref': {
    note:
      'diagnoses the failure from the network log alone (507 on /api/depot/manifests), then takes ' +
      'the legitimate alternate path for the body-only ref: an in-page fetch via evaluate_script. ' +
      'The 507 is deliberately stable and NOT one-shot, so the re-trigger returns the same ' +
      'session-stable ref; the server counts it in manifestHits as the measured price of not ' +
      'having response-body capture. get_network_request is still called to prove the ref is ' +
      'absent from everything it returns.',
    wrong: 'The manifests request failed with status 502 and support reference MR-00000000.',
    async run({ mcp, goto, evaluate, snapshot }) {
      await goto('/depot/manifests.html');
      // "No manifests for this shift." is 28 chars, so the snapshot's 27-char
      // text cap clips it to "No manifests for this shi...": match the prefix.
      const snap = await until('the manifests table to show the empty state', async () => {
        const s = await snapshot();
        return /No manifests for this/.test(s) ? s : null;
      });
      if (/MR-[0-9A-F]{8}/i.test(snap)) throw new Error('the support ref leaked into the DOM');

      const hit = await until('a 507 on /api/depot/manifests in the network log', async () => {
        const list = await readJson(mcp, 'list_network_requests', {
          urlContains: '/api/depot/manifests',
          format: 'json',
        });
        return (list.requests ?? []).find((r) => r.status === 507) ?? null;
      }, { tries: 20 });

      const det = await readJson(mcp, 'get_network_request', { id: hit.id, format: 'json' });
      if (det.status !== 507) throw new Error(`expected 507, got ${det.status}`);
      // The ref must not be recoverable from anything our network surface
      // returns: that unavailability is the capability gap this task measures.
      if (/MR-[0-9A-F]{8}/i.test(JSON.stringify(det))) {
        throw new Error('the support ref leaked into get_network_request output');
      }

      const out = await evaluate(
        `async () => {
          const r = await fetch('/api/depot/manifests');
          const j = await r.json();
          return { status: r.status, ref: j.ref, error: j.error };
        }`
      );
      if (out?.status !== 507 || !REF.test(out?.ref ?? '')) {
        throw new Error(`in-page refetch did not return the ref: ${JSON.stringify(out)}`);
      }

      const fields = { failedRequest: '/api/depot/manifests', statusCode: 507, supportRef: out.ref };
      this.wrongFields = [
        // Right request, wrong status.
        { failedRequest: '/api/depot/manifests', statusCode: 502, supportRef: out.ref },
        // Right request, the modal guess for a broken API - the status must be
        // read out of the log, not assumed.
        { failedRequest: '/api/depot/manifests', statusCode: 500, supportRef: out.ref },
        // A healthy request named as the failure (correct status claimed).
        { failedRequest: '/api/depot/kpis', statusCode: 507, supportRef: out.ref },
        // A stylesheet (a 200) named as the failing request.
        { failedRequest: '/depot/depot.css', statusCode: 507, supportRef: null },
        // The page document misattribution: normalises to contain "manifests"
        // but the document loaded fine (a 200), by path and in prose.
        { failedRequest: '/depot/manifests.html', statusCode: 507, supportRef: null },
        { failedRequest: 'the manifests page itself (the document)', statusCode: 507, supportRef: null },
        { failedRequest: 'the manifests document request', statusCode: 507, supportRef: null },
        // The document named first, the endpoint only as context.
        {
          failedRequest: '/depot/manifests.html (its /api/depot/manifests call is fine)',
          statusCode: 507,
          supportRef: null,
        },
        // The intake page's manifest data file, a 200 this page never fetches.
        { failedRequest: '/depot/data/manifest-dm2116.txt', statusCode: 507, supportRef: null },
        // Right diagnosis, but a stated ref that is not the minted one:
        // fabricated, one character off, the body's error code, and a
        // fabricated one behind a placeholder word.
        { failedRequest: '/api/depot/manifests', statusCode: 507, supportRef: 'MR-00000000' },
        { failedRequest: '/api/depot/manifests', statusCode: 507, supportRef: bumpCode(out.ref) },
        { failedRequest: '/api/depot/manifests', statusCode: 507, supportRef: 'manifest_store_locked' },
        { failedRequest: '/api/depot/manifests', statusCode: 507, supportRef: 'unknown, possibly MR-00000000' },
      ];
      this.alsoCorrectFields = [
        fields,
        // The ref is optional (it is the capability probe): a correct
        // diagnosis with no recovered ref must pass.
        { failedRequest: 'GET /api/depot/manifests', statusCode: 507, supportRef: null },
        // A placeholder for the unrecovered ref states none.
        { failedRequest: 'GET /api/depot/manifests', statusCode: 507, supportRef: 'not available' },
        { failedRequest: 'GET /api/depot/manifests', statusCode: 507, supportRef: 'N/A' },
        {
          failedRequest: 'GET /api/depot/manifests',
          statusCode: 507,
          supportRef: 'not recoverable (response body not exposed)',
        },
        // The endpoint named alongside the document that fetched it.
        {
          failedRequest: 'GET /api/depot/manifests (fetched by manifests.html on load)',
          statusCode: 507,
          supportRef: null,
        },
        { failedRequest: 'the manifests request the page document issues', statusCode: 507, supportRef: null },
        { failedRequest: 'the manifests XHR, not the document', statusCode: 507, supportRef: null },
        { failedRequest: 'the manifests API request', statusCode: 507, supportRef: out.ref.toLowerCase() },
        // Singular prose naming is a legitimate answer shape.
        { failedRequest: 'the manifest request', statusCode: 507, supportRef: out.ref },
      ];
      this.alsoCorrect = [
        `The page is empty because GET /api/depot/manifests returns 507 (manifest_store_locked). ` +
          `My tools do not expose response bodies, so I could not recover the support reference ` +
          `the server sent with the failure.`,
        `Failed request: GET /api/depot/manifests\nStatus: 507\nSupport reference: ${out.ref}`,
        `The manifests API request fails with a 507 on every load; re-issuing the fetch ` +
          `in-page returned the same failure body with support reference ${out.ref.toLowerCase()}.`,
      ];
      this.wrong = [
        this.wrong,
        `The manifests page failed to load its stylesheet /depot/depot.css with a 507.`,
        `The document /depot/manifests.html failed with a 507; the support reference the ` +
          `server sent is ${out.ref}.`,
      ];
      return {
        text:
          `The table is empty because GET /api/depot/manifests fails: it returns HTTP 507 ` +
          `with error "manifest_store_locked" on every load and refresh. The support ` +
          `reference the server sends in the failure body is ${out.ref}.`,
        fields,
      };
    },
  },

  'partial-import': {
    note:
      'loads and posts the manifest through the page, then reads the three server-chosen ' +
      'rejects and the diag code out of list_console_messages (the page status line lies about ' +
      'full success; the warns are the only client-side trace).',
    wrong:
      'All 40 lines were accepted; nothing was dropped, so there are no rejected keys and no ' +
      'diagnostic code.',
    async run({ mcp, goto, snapshot, evaluate }) {
      await goto('/depot/intake.html');
      const load = uidOf(await snapshot(), 'button "Load manifest DM-2116"');
      if (!load) throw new Error('no Load manifest button in the snapshot');
      await mcp('click_by_uid', { uid: load });

      const loadedSnap = await until('the manifest to load into the textarea', async () => {
        const s = await snapshot();
        return /Manifest DM-2116 loaded/.test(s) ? s : null;
      });

      const post = uidOf(loadedSnap, 'button "Post to intake"');
      if (!post) throw new Error('no Post to intake button in the snapshot');
      await mcp('click_by_uid', { uid: post });

      const doneSnap = await until('the page to report the intake as complete', async () => {
        const s = await snapshot();
        return /Intake complete/.test(s) ? s : null;
      });
      if (/DG-[0-9A-F]{6}/i.test(doneSnap)) throw new Error('the diag code leaked into the DOM');

      const rejects = await until('three intake reject warnings in the console log', async () => {
        const out = await readJson(mcp, 'list_console_messages', {
          textContains: 'intake reject',
          format: 'json',
        });
        const found = (out.messages ?? [])
          .map((m) => m.text.match(/intake reject (LN-\d{4}) (DG-[0-9A-F]{6})/i))
          .filter(Boolean);
        return found.length >= 3 ? found : null;
      }, { tries: 20 });
      if (rejects.length !== 3) {
        throw new Error(`expected 3 intake reject warnings, saw ${rejects.length}`);
      }
      const keys = rejects.map((m) => m[1]);
      const diags = [...new Set(rejects.map((m) => m[2]))];
      if (diags.length !== 1) throw new Error(`expected one diag code, saw ${diags.join(',')}`);
      const diag = diags[0];

      const manifestKeys = await evaluate(() => [
        ...new Set((document.getElementById('lines')?.value ?? '').match(/LN-\d{4}/g) ?? []),
      ]);
      const healthy = (Array.isArray(manifestKeys) ? manifestKeys : []).find(
        (k) => !keys.includes(k)
      );
      if (!healthy) {
        throw new Error(
          `no unrejected manifest line to over-claim (read ${
            Array.isArray(manifestKeys) ? manifestKeys.length : 0
          } keys, rejects ${keys.join(',')})`
        );
      }

      const fields = { acceptedCount: 37, rejectedKeys: keys, diagCode: diag };
      this.wrongFields = [
        // Believing the page: all 40 accepted.
        { acceptedCount: 40, rejectedKeys: [], diagCode: null },
        // Read the rejects off the console but still believed the page's 40.
        { acceptedCount: 40, rejectedKeys: keys, diagCode: diag },
        // One reject missed.
        { acceptedCount: 37, rejectedKeys: keys.slice(0, 2), diagCode: diag },
        // Over-claiming a healthy line as rejected. The line is derived from the
        // posted manifest minus this draw's rejects rather than hard-coded: a
        // draw that rejects both manifest lines 1 and 2 leaves a fixed candidate
        // `undefined` and ships a schema-invalid assertion on a golden path that
        // worked.
        {
          acceptedCount: 37,
          rejectedKeys: [...keys, healthy],
          diagCode: diag,
        },
        // Fabricated diag code.
        { acceptedCount: 37, rejectedKeys: keys, diagCode: 'DG-000000' },
      ];
      this.alsoCorrectFields = [
        fields,
        {
          acceptedCount: 37,
          rejectedKeys: [...keys].reverse().map((k) => k.toLowerCase()),
          diagCode: diag.toLowerCase(),
        },
      ];
      this.alsoCorrect = [
        `The page's own report is wrong: the server accepted 37 of the 40 lines. It rejected ` +
          `${keys[0]}, ${keys[1]} and ${keys[2]}, each with diagnostic code ${diag}.`,
        `Accepted: 37 of 40\nRejected keys: ${keys.join(', ')}\nDiagnostic code: ${diag}`,
        `The status line claims full success, but the console warnings show three rejects - ` +
          `${keys.map((k) => k.toLowerCase()).join(', ')} - all with diag code ` +
          `${diag.toLowerCase()}, so only 37 lines actually landed.`,
      ];
      this.wrong = [
        this.wrong,
        `37 lines were accepted. The rejected keys were ${keys[0]}, ${keys[1]} and LN-9999, ` +
          `diagnostic code ${diag}.`,
        `All 40 lines posted successfully. The console did log ${keys[0]} with ${diag}, ` +
          `but nothing was actually dropped.`,
      ];
      return {
        text:
          `The page claims all 40 lines posted, but that is not what happened: the server ` +
          `accepted 37 lines and rejected 3. The rejected line keys are ${keys.join(', ')}, ` +
          `each carrying the diagnostic code ${diag}.`,
        fields,
      };
    },
  },
};
