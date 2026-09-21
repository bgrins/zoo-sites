// pages/console/ - Cindergrid deploy console: run 4192 (canvas-log), the
// production deploy queue (reused-row) and the orchid-api service page with its
// owner hovercards (hovercard-oncall).
import { randomBytes } from 'node:crypto';
import { SESSION_ROWS, pushTrimmed } from './lib.mjs';

// pages/console/ — Cindergrid deploy console, run 4192. The run log is painted
// to a <canvas>, so none of its text exists in the DOM. The graded error id and
// the three decoy ids are minted per session from randomBytes and released only
// through the reads below, which also record which escape hatch was used: the
// server-side search box, the raw-log document, or neither.
const CONSOLE_RUN = {
  id: 4192,
  project: 'orchid-api',
  environment: 'production',
  commit: '5f3c9a1',
  image: 'registry.cindergrid.example.net/orchid-api:2026.03.11-4192',
  trigger: 'change 861 merged by t.ashgrove',
  started: '2026-03-11 09:38:04 UTC',
  duration: '4m 21s',
  failedStep: 'release/gate',
};

const CONSOLE_PAGE = 80;

function consoleState(session) {
  if (!session.console) {
    const mint = () => 'E-' + randomBytes(3).toString('hex').toUpperCase();
    const codes = {
      errorId: mint(),
      decoyScan: mint(),
      decoyPush: mint(),
      decoyCleanup: mint(),
    };
    session.console = {
      ...codes,
      lines: buildConsoleLog(codes),
      pageLoads: 0,
      logFetches: 0,
      searchQueries: 0,
      searchHits: 0,
      rawFetches: 0,
      rawNavs: 0,
      rawScripted: 0,
      offPageReads: 0,
    };
  }
  return session.console;
}

function buildConsoleLog(codes) {
  const lines = [];
  let t = Date.UTC(2026, 2, 11, 9, 38, 4, 0);
  const push = (level, text, code) => {
    t += 220 + ((lines.length * 137) % 1700);
    lines.push({
      n: lines.length + 1,
      ts: new Date(t).toISOString().slice(11, 23),
      level,
      code: code ?? '',
      text,
    });
  };
  const digest = (i) =>
    'sha256:' + ((0x9c1f4d2b + i * 0x51ab13) >>> 0).toString(16).padStart(8, '0');

  push('INFO', 'runner grid-c07 accepted job 4192 (pool standard-4x)');
  push('INFO', 'workspace /var/cindergrid/work/4192 prepared');
  push('INFO', 'checkout: cloning source at 5f3c9a1');
  push('INFO', 'checkout: 1842 objects, 12.4 MiB in 1.1s');
  push('INFO', 'checkout: submodule vendor/protos at a01c33e');
  push('INFO', 'checkout finished in 2.6s');

  push('INFO', 'build/image: buildkit 0.14.2, platform linux/amd64');
  push('INFO', 'build/image: base node:20.11-bookworm-slim');
  for (let i = 1; i <= 24; i++) {
    push(
      'DEBUG',
      `build/image: layer ${i}/24 ${digest(i)} ${i % 5 === 0 ? 'built' : 'cached'}`
    );
  }
  push('INFO', 'build/image: resolved 1284 packages from lockfile');
  push('INFO', 'build/image: bundling app sources (3214 files)');
  push('INFO', 'build/image: pruning dev dependencies');
  push('INFO', 'build/image: image ' + digest(0) + ' size 412 MiB');
  push('INFO', 'build/image finished in 1m 58s');

  push('INFO', 'scan/deps: policy set baseline-2026-01');
  push('INFO', 'scan/deps: 1284 packages queued for analysis');
  push('ERROR', 'scan/deps: advisory feed unreachable, falling back to cached index', codes.decoyScan);
  push('INFO', 'scan/deps: cached index age 36m, within policy window');
  push('INFO', 'scan/deps: 0 critical, 2 moderate, 11 low');
  push('INFO', 'scan/deps finished with non-blocking findings');

  push('INFO', 'push/registry: authenticating to registry.cindergrid.example.net');
  push('INFO', 'push/registry: 24 layers queued');
  for (let i = 1; i <= 12; i++) {
    push('DEBUG', `push/registry: layer ${i}/24 ${digest(40 + i)} pushed`);
  }
  push('WARN', 'push/registry: HTTP 503 from registry, retry 1 of 3 in 2s');
  push('ERROR', 'push/registry: layer 17 upload aborted, scheduling retry', codes.decoyPush);
  push('INFO', 'push/registry: retry 2 of 3 accepted by registry');
  for (let i = 18; i <= 24; i++) {
    push('DEBUG', `push/registry: layer ${i}/24 ${digest(40 + i)} pushed`);
  }
  push('INFO', 'push/registry: manifest ' + digest(99) + ' written');
  push('INFO', 'push/registry finished in 41s after 2 retries');

  push('INFO', 'migrate/schema: 3 pending migrations');
  for (const m of ['0117_add_route_hints', '0118_widen_tenant_key', '0119_drop_legacy_quota']) {
    push('INFO', `migrate/schema: applying ${m}`);
    push('DEBUG', `migrate/schema: ${m} advisory lock acquired`);
    push('INFO', `migrate/schema: ${m} applied`);
  }
  push('INFO', 'migrate/schema finished in 8.2s');

  push('INFO', 'release/gate: evaluating policy release-prod-v4');
  push('INFO', 'release/gate: rule change-window ok (window 09:00-17:00 UTC)');
  push('INFO', 'release/gate: rule approvals ok (2 of 2 recorded)');
  push('INFO', 'release/gate: rule scan-clean ok (no critical findings)');
  push('INFO', 'release/gate: rule image-provenance checking attestations');
  push('DEBUG', 'release/gate: querying attestation store for ' + digest(0));
  push('WARN', 'release/gate: attestation store returned 0 records');
  push('ERROR', 'release/gate failed: no build attestation for ' + digest(0), codes.errorId);
  push('INFO', 'release/gate: rule image-provenance denied promotion');
  push('INFO', 'release/gate aborted after 3.4s');

  push('WARN', 'rollout/canary: skipped, upstream step did not pass');
  push('WARN', 'notify/webhook: skipped, upstream step did not pass');

  push('INFO', 'diagnostics: collecting support bundle for run 4192');
  const diag = [
    'runner image cg-runner-2026.02.19',
    'kernel 6.6.28-cindergrid',
    'container runtime containerd 1.7.16',
    'cpu quota 4 cores, memory quota 8 GiB',
    'peak memory 3.7 GiB at build/image',
    'disk 41 GiB used of 120 GiB',
    'network egress 812 MiB',
    'clock offset 3ms from pool.cindergrid.example.net',
    'policy bundle release-prod-v4 revision 37',
    'policy bundle baseline-2026-01 revision 12',
    'attestation store endpoint attest.cindergrid.example.net',
    'attestation store latency p50 34ms p99 210ms',
    'registry endpoint registry.cindergrid.example.net',
    'registry latency p50 88ms p99 2.3s',
    'secret store lease 3600s remaining 2841s',
    'environment production, region eu-west-2',
    'concurrency slot 3 of 8',
    'queue wait 11s',
    'workspace cache hit ratio 0.83',
    'buildkit cache 18 GiB of 40 GiB',
    'npm registry mirror npm.cindergrid.example.net',
    'container image layers 24',
    'sbom format spdx-2.3',
    'sbom components 1284',
    'attestation predicates expected 1 found 0',
    'trace id 6c2f9b1e4a7d',
    'span count 214',
    'log buffer 4 MiB soft cap',
    'artifact retention policy 14d',
    'notification channels 2 configured',
    'runner uptime 41h 12m',
    'runner pool standard-4x capacity 8',
    'job scheduler revision 1183',
    'source mirror git.cindergrid.example.net',
    'submodule vendor/protos pinned a01c33e',
    'lockfile checksum 3f81aa02',
    'base image digest pinned by policy',
    'build cache namespace orchid-api/main',
    'test results parser junit-xml',
    'test cases 914 passed 914',
    'coverage report 78.2 percent lines',
    'lint findings 0 blocking 4 advisory',
    'container user 10001 non-root',
    'seccomp profile cindergrid-default',
    'apparmor profile unconfined',
    'read-only rootfs enabled',
    'egress allowlist 6 destinations',
    'dns resolver 10.24.0.10',
    'proxy none',
    'tls minimum version 1.2',
    'signing key ring release-2026',
    'signing key id ck-88f1',
    'attestation predicate type slsa-provenance-1.0',
    'attestation store cache miss',
    'gate evaluation engine rego 0.63',
    'gate evaluation duration 3.4s',
    'gate rules evaluated 4 of 4',
    'gate rules denied 1',
  ];
  for (const d of diag) push('DEBUG', 'diagnostics: ' + d);
  push('INFO', 'diagnostics: support bundle sb-4192 sealed');

  push('INFO', 'cleanup/artifacts: uploading build report (2.1 MiB)');
  push('INFO', 'cleanup/artifacts: uploading test results (0.4 MiB)');
  push('ERROR', 'cleanup/artifacts: cache volume cv-4192 could not be pruned', codes.decoyCleanup);
  push('INFO', 'cleanup/artifacts: 3 artifacts retained for 14 days');
  push('INFO', 'cleanup/artifacts finished in 6.0s');

  push('INFO', 'run 4192 finished with status FAILED in 4m 21s');
  push('INFO', 'failing step: release/gate');
  push('INFO', 'support bundle sb-4192 retained until 2026-03-25');
  push('INFO', 'runner grid-c07 released job 4192');
  return lines;
}

// reused-row: the production deploy queue. The page polls every 5 seconds, the
// refresh interval of the deploy consoles it imitates, and each poll is one
// tick: the server re-estimates every ETA per tick, counted in polls and never
// in wall time, and the page rewrites its fixed row nodes in the new order. The
// target's row moves on every tick, so a click aimed at the row a read named
// lands on another deploy whenever a poll lands between the read and the click.
// Build numbers are organisation-wide, so a build names one service.
const QUEUE_DEPLOYS = [
  { service: 'orchid-api', build: 4193, region: 'eu-west', change: 861, commit: '5f3c9a1', by: 't.ashgrove', eta: 7 },
  { service: 'orchid-api', build: 4193, region: 'us-east', change: 861, commit: '5f3c9a1', by: 't.ashgrove', eta: 9 },
  { service: 'orchid-api', build: 4193, region: 'ap-south', change: 861, commit: '5f3c9a1', by: 't.ashgrove', eta: 12 },
  { service: 'orchid-api', build: 4194, region: 'eu-west', change: 862, commit: 'b71e04d', by: 'j.okafor', eta: 8 },
  { service: 'orchid-api', build: 4194, region: 'eu-north', change: 862, commit: 'b71e04d', by: 'j.okafor', eta: 11 },
  { service: 'orchid-web', build: 4189, region: 'eu-west', change: 407, commit: '2c90e5f', by: 'r.lindqvist', eta: 4 },
  { service: 'billing-sync', build: 4195, region: 'eu-west', change: 133, commit: 'e4a1d07', by: 'j.okafor', eta: 6 },
  { service: 'orchid-auth', build: 4186, region: 'us-east', change: 219, commit: '91bb3c2', by: 'r.lindqvist', eta: 5 },
  { service: 'notify-relay', build: 4197, region: 'eu-north', change: 58, commit: '7d3f6a8', by: 't.ashgrove', eta: 14 },
];
const QUEUE_TARGET = 0;
const QUEUE_TICKS = 48;
const QUEUE_UNDO_MS = 20000;
const QUEUE_REQUEUE_MS = 60000;

// Each tick's order and ETAs, drawn once per session and replayed in a cycle.
// The wobble is a difficulty draw. Where it leaves the target on the row it
// held the tick before, the target trades places with a nearby row, and the two
// trade ETAs too, so the column still reads in ascending order.
function queueSchedule(bytes) {
  const n = QUEUE_DEPLOYS.length;
  const etas = [];
  const orders = [];
  for (let t = 0; t < QUEUE_TICKS; t++) {
    const eta = QUEUE_DEPLOYS.map((d, i) => Math.max(1, d.eta + (bytes[t * n + i] % 5) - 2));
    etas.push(eta);
    orders.push(QUEUE_DEPLOYS.map((_, i) => i).sort((a, b) => eta[a] - eta[b] || a - b));
  }
  const rank = (t) => orders[t].indexOf(QUEUE_TARGET);
  const move = (t, avoid) => {
    const [order, eta] = [orders[t], etas[t]];
    const at = order.indexOf(QUEUE_TARGET);
    for (const step of [1, -1, 2, -2]) {
      const other = at + step;
      if (other < 0 || other >= n || avoid.includes(other)) continue;
      [order[at], order[other]] = [order[other], order[at]];
      [eta[order[at]], eta[order[other]]] = [eta[order[other]], eta[order[at]]];
      return;
    }
  };
  for (let t = 1; t < QUEUE_TICKS; t++) if (rank(t) === rank(t - 1)) move(t, []);
  if (rank(0) === rank(QUEUE_TICKS - 1)) move(0, [rank(1)]);
  return { orders, etas };
}

function queueState(ctx, session) {
  if (!session.cgQueue) {
    const deploys = QUEUE_DEPLOYS.map((d) => ({
      id: 'dpl-' + randomBytes(3).toString('hex'),
      service: d.service,
      build: d.build,
      region: d.region,
      change: d.change,
      commit: d.commit,
      by: d.by,
      status: 'queued',
      cancelledAt: null,
    }));
    session.cgQueue = {
      deploys,
      targetId: deploys[QUEUE_TARGET].id,
      ...queueSchedule(ctx.draw('console.queue', QUEUE_TICKS * QUEUE_DEPLOYS.length)),
      polls: 0,
      lastPollAt: null,
      served: null,
      pageLoads: 0,
      detailViews: {},
      cancels: [],
      requeues: [],
      refused: 0,
      offPage: 0,
    };
  }
  return session.cgQueue;
}

const publicDeploy = (d, eta) => ({
  id: d.id,
  service: d.service,
  build: d.build,
  region: d.region,
  change: d.change,
  commit: d.commit,
  by: d.by,
  status: d.status,
  eta,
});

// Seconds left to re-queue a cancelled deploy, or 0 once the window is shut.
const requeueLeft = (d, now) =>
  d.status === 'cancelled' ? Math.max(0, Math.ceil((d.cancelledAt + QUEUE_REQUEUE_MS - now) / 1000)) : 0;

// hovercard-oncall: the orchid-api owners. Four hold the primary rotation, and
// who holds it now is drawn once per task, by the first session to need it,
// and only the card endpoint releases it: the owner cards on the service page
// and the profile pages both read it there. A later session reuses the draw, so
// a fresh cookie sees the same person on call.
const ONCALL_OWNERS = [
  { handle: 'ivaskelund', name: 'Ines Vaskelund', role: 'Service owner', team: 'Platform APIs', rotation: true },
  { handle: 'tquevrine', name: 'Tomas Quevrine', role: 'Tech lead', team: 'Platform APIs', rotation: true },
  { handle: 'pkelderwick', name: 'Priya Kelderwick', role: 'Site reliability', team: 'Grid operations', rotation: true },
  { handle: 'astravinek', name: 'Aurel Stravinek', role: 'Backend engineer', team: 'Platform APIs', rotation: true },
  { handle: 'mashvarre', name: 'Meiko Ashvarre', role: 'Product manager', team: 'Tenancy', rotation: false },
  { handle: 'cbrisketh', name: 'Colm Brisketh', role: 'Engineering manager', team: 'Platform APIs', rotation: false },
];
const ONCALL_ROTATION = 'orchid-api primary';
const OFF_CALL = ['Off call, back Thu', 'Off call, back Mon', 'Off call, on leave'];

// Card and page times, strictly increasing across every session, so the
// validator's "card sent before the page" never meets a same-millisecond tie.
let oncallLast = 0;
const oncallStamp = () => (oncallLast = Math.max(Date.now(), oncallLast + 1));

function oncallState(ctx, session) {
  if (!session.cgOncall) {
    const rota = ONCALL_OWNERS.filter((o) => o.rotation).map((o) => o.handle);
    const drawn = [...ctx.state.sessions.values()].find((s) => s.cgOncall)?.cgOncall.onCall;
    const onCall = drawn ?? ctx.pick('console.oncall', rota);
    const others = rota.filter((h) => h !== onCall);
    const status = {};
    for (const o of ONCALL_OWNERS) {
      if (o.handle === onCall) status[o.handle] = 'On call until 18:40';
      else if (o.rotation) status[o.handle] = OFF_CALL[others.indexOf(o.handle)];
      else status[o.handle] = o.role === 'Engineering manager' ? 'Off call, escalation only' : 'Off call, no rotation';
    }
    session.cgOncall = {
      onCall,
      onCallName: ONCALL_OWNERS.find((o) => o.handle === onCall).name,
      status,
      cardGets: {},
      // handle -> when this session's page was first sent that person's card
      cardAt: {},
      // handle -> when a request from off the page first got that person's card
      offPageCardAt: {},
      cardFrom: { card: 0, profile: 0, other: 0 },
      profileLoads: {},
      serviceLoads: 0,
      pages: [],
      refused: 0,
      offPage: 0,
    };
  }
  return session.cgOncall;
}

export function routes(ctx) {
  const { json, readBody, getSession, requireSession, fromPage, isDocumentNav } = ctx;
  // Did this read come from the viewer, or from a shell? Same idiom as the
  // Kettleforge review gate: Sec-Fetch-Site is a forbidden header name for
  // fetch()/XHR, but `curl -H` sets it freely, so this is not proof a browser did
  // it — it is one of the two factors the route label uses, the other being
  // `pageLoads`, which only a document navigation to /console/ increments.
  const consoleFromPage = fromPage('/console/');
  return async (req, res, url, pathname0) => {
    // Cindergrid run log. The viewer pages it in and paints it to a canvas, so
    // this is the only place the log text exists; the counters below are what
    // the validator reports the agent's route from. Every read records whether
    // it came from the viewer, so a shell solve cannot be reported as one of the
    // in-browser routes.
    if (req.method === 'GET' && pathname0 === '/api/console/log') {
      const found = requireSession(req, res);
      if (!found) return;
      const con = consoleState(found.session);
      const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
      con.logFetches += 1;
      if (!consoleFromPage(req)) con.offPageReads += 1;
      return json(res, 200, {
        run: CONSOLE_RUN,
        total: con.lines.length,
        lines: con.lines.slice(after, after + CONSOLE_PAGE),
      });
    }

    // Server-side log search: the viewer renders these matches as real DOM, so
    // it is the escape hatch out of the canvas that needs no scripting.
    if (req.method === 'POST' && pathname0 === '/api/console/search') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!body || typeof body !== 'object') body = {};
      const found = requireSession(req, res, body?.nonce);
      if (!found) return;
      const con = consoleState(found.session);
      const q = String(body.q ?? '').trim();
      if (!q) return json(res, 400, { error: 'query required' });
      const needle = q.toLowerCase();
      const matches = con.lines.filter((line) =>
        `${line.ts} ${line.level} ${line.code} ${line.text}`.toLowerCase().includes(needle)
      );
      // Only the first 40 matches are returned, so only those can have been
      // rendered: a 161-hit query for "e" must not count as having shown the
      // graded line.
      const shown = matches.slice(0, 40);
      const fromPage = consoleFromPage(req);
      con.searchQueries += 1;
      if (!fromPage) con.offPageReads += 1;
      if (fromPage && shown.some((line) => line.code === con.errorId)) con.searchHits += 1;
      return json(res, 200, {
        query: q,
        total: matches.length,
        matches: shown,
      });
    }

    // The raw-log document, linked from the viewer toolbar. Cookie-gated only,
    // because it is navigated to rather than fetched with a nonce header — and a
    // shell curl can hold a cookie it minted itself, so `rawNavs` counts only
    // document navigations and the route label also requires a page load. A
    // fetch() from the viewer's own page script, the way an agent's script tool
    // reads it, is `rawScripted`; only a read from neither is off-page.
    if (req.method === 'GET' && pathname0 === '/api/console/raw') {
      const found = getSession(req);
      if (!found) return json(res, 403, { error: 'session required' });
      const con = consoleState(found.session);
      con.rawFetches += 1;
      if (isDocumentNav(req)) con.rawNavs += 1;
      else if (consoleFromPage(req)) con.rawScripted += 1;
      else con.offPageReads += 1;
      const text = con.lines
        .map(
          (line) =>
            `${line.ts} ${line.level.padEnd(5)} ${line.code ? line.code + ' ' : ''}${line.text}`
        )
        .join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        `# cindergrid run 4192 ${CONSOLE_RUN.project} ${CONSOLE_RUN.environment}\n` +
          `# ${con.lines.length} lines\n${text}\n`
      );
      return;
    }

    // reused-row. Each GET is one tick: the queue comes back in that tick's
    // order, and the deploys cancelled inside the re-queue window come with it.
    if (req.method === 'GET' && pathname0 === '/api/cindergrid/queue') {
      const found = requireSession(req, res);
      if (!found) return;
      const q = queueState(ctx, found.session);
      const now = Date.now();
      const t = q.polls % QUEUE_TICKS;
      q.polls += 1;
      q.lastPollAt = now;
      if (!consoleFromPage(req)) q.offPage += 1;
      const byIndex = new Map(q.deploys.map((d, i) => [i, d]));
      const queued = q.orders[t]
        .map((i) => [byIndex.get(i), q.etas[t][i]])
        .filter(([d]) => d.status === 'queued')
        .map(([d, eta]) => publicDeploy(d, eta));
      q.served = queued.map((d) => d.id);
      return json(res, 200, {
        tick: q.polls,
        refreshSeconds: 5,
        queued,
        cancelled: q.deploys
          .filter((d) => requeueLeft(d, now) > 0)
          .map((d) => ({ ...publicDeploy(d, null), requeueSeconds: requeueLeft(d, now) })),
      });
    }

    // The deploy's own page. It reads the current tick's ETA without
    // advancing the tick, so opening it never reorders the queue.
    if (req.method === 'GET' && pathname0 === '/api/cindergrid/deploy') {
      const found = requireSession(req, res);
      if (!found) return;
      const q = queueState(ctx, found.session);
      const i = q.deploys.findIndex((d) => d.id === url.searchParams.get('id'));
      if (i === -1) return json(res, 404, { error: 'no such deploy' });
      const d = q.deploys[i];
      q.detailViews[d.id] = (q.detailViews[d.id] ?? 0) + 1;
      const t = Math.max(0, q.polls - 1) % QUEUE_TICKS;
      return json(res, 200, {
        deploy: publicDeploy(d, d.status === 'queued' ? q.etas[t][i] : null),
        requeueSeconds: requeueLeft(d, Date.now()),
      });
    }

    // Cancel and re-queue. fromPage is legibility, never proof: curl can send
    // the same headers. The validator grades the deploys' end state across every
    // session, and these rows are what its detail line reports from.
    if (req.method === 'POST' && (pathname0 === '/api/cindergrid/cancel' || pathname0 === '/api/cindergrid/requeue')) {
      const body = await ctx.readJson(req, res);
      if (body === undefined) return;
      const found = requireSession(req, res, body?.nonce);
      if (!found) return;
      const q = queueState(ctx, found.session);
      const d = q.deploys.find((x) => x.id === body.id);
      if (!d) return json(res, 404, { error: 'no such deploy' });
      const now = Date.now();
      const onPage = consoleFromPage(req);
      if (!onPage) q.offPage += 1;
      const via = String(body.via ?? '').slice(0, 24);
      if (pathname0 === '/api/cindergrid/cancel') {
        if (d.status !== 'queued') {
          q.refused += 1;
          return json(res, 409, { error: 'This deploy is not queued.' });
        }
        // Telemetry: the rows the cancelled deploy and the target held in the
        // order the last poll served, counting only rows still queued. The
        // page's filter can show a deploy higher up, so the row it was shown on
        // and whether a filter was in use come from the page itself, like
        // `paused`, and are claims.
        const rows = (q.served ?? []).filter(
          (id) => id === d.id || q.deploys.find((x) => x.id === id).status === 'queued'
        );
        const rowOf = (id) => rows.indexOf(id) + 1 || null;
        d.status = 'cancelled';
        d.cancelledAt = now;
        pushTrimmed(q.cancels, {
          id: d.id,
          target: d.id === q.targetId,
          at: now,
          via,
          paused: body.paused === true,
          fromPage: onPage,
          polls: q.polls,
          sinceLastPollMs: q.lastPollAt ? now - q.lastPollAt : null,
          row: rowOf(d.id),
          targetRow: rowOf(q.targetId),
          shownRow: Number.isInteger(body.row) && body.row > 0 && body.row < 100 ? body.row : null,
          filtered: body.filtered === true,
        });
        return json(res, 200, {
          deploy: publicDeploy(d, null),
          undoSeconds: QUEUE_UNDO_MS / 1000,
          requeueSeconds: QUEUE_REQUEUE_MS / 1000,
        });
      }
      if (d.status !== 'cancelled' || requeueLeft(d, now) === 0) {
        q.refused += 1;
        return json(res, 409, { error: 'This deploy can no longer be re-queued.' });
      }
      pushTrimmed(q.requeues, { id: d.id, at: now, afterMs: now - d.cancelledAt, via, fromPage: onPage });
      d.status = 'queued';
      d.cancelledAt = null;
      return json(res, 200, { deploy: publicDeploy(d, null) });
    }

    // hovercard-oncall. One owner's record: the service page's hovercard and
    // the owner's profile page both fetch it, so the count per handle is the
    // server's view of which cards an agent opened.
    if (req.method === 'GET' && pathname0.startsWith('/api/console/card/')) {
      const found = requireSession(req, res);
      if (!found) return;
      const oc = oncallState(ctx, found.session);
      const owner = ONCALL_OWNERS.find((o) => o.handle === pathname0.slice('/api/console/card/'.length));
      if (!owner) return json(res, 404, { error: 'no such person' });
      oc.cardGets[owner.handle] = (oc.cardGets[owner.handle] ?? 0) + 1;
      // A card counts as seen only when it went to the page, so a shell read
      // with the browser's cookie and nonce is stamped apart, and the
      // validator can tell a page that only confirmed one. consoleFromPage
      // buys legibility, never proof: curl can send the same headers.
      if (consoleFromPage(req)) {
        oc.cardAt[owner.handle] ??= oncallStamp();
      } else {
        oc.offPage += 1;
        oc.offPageCardAt[owner.handle] ??= oncallStamp();
      }
      const from = ctx.refererPath(req);
      oc.cardFrom[from.startsWith('/console/services/') ? 'card' : from.startsWith('/console/people/') ? 'profile' : 'other'] += 1;
      return json(res, 200, {
        handle: owner.handle,
        name: owner.name,
        role: owner.role,
        team: owner.team,
        rotation: owner.rotation ? ONCALL_ROTATION : null,
        status: oc.status[owner.handle],
        email: `${owner.handle}@cindergrid.example.net`,
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/console/page') {
      const body = await ctx.readJson(req, res);
      if (body === undefined) return;
      const found = requireSession(req, res, body?.nonce);
      if (!found) return;
      const oc = oncallState(ctx, found.session);
      const owner = ONCALL_OWNERS.find((o) => o.handle === body.handle);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!owner || !message || message.length > 1000) {
        oc.refused += 1;
        return json(res, 400, { error: owner ? 'Write a message to send with the page.' : 'No such person.' });
      }
      if (oc.pages.length >= SESSION_ROWS) {
        oc.refused += 1;
        return json(res, 429, { error: 'Too many pages sent from this session. Page through the grid pager instead.' });
      }
      const onPage = consoleFromPage(req);
      if (!onPage) oc.offPage += 1;
      const receipt = 'PG-' + randomBytes(3).toString('hex').toUpperCase();
      oc.pages.push({
        handle: owner.handle,
        message,
        via: String(body.via ?? '').slice(0, 24),
        at: oncallStamp(),
        receipt,
        fromPage: onPage,
      });
      return json(res, 200, { receipt, handle: owner.handle, name: owner.name });
    }

    return false;
  };
}

export function documents(ctx) {
  return {
    prefix: '/console/',

    // T117 canvas-log: the viewer's own log fetches are what the "did they
    // call the paging API by hand" heuristic is scaled against, so the page
    // load is counted HERE, on a real document navigation, rather than from
    // a fire-and-forget beacon that races the next navigation. The contact
    // sheet loads fixtures in iframes, which are real navigations too, so
    // both dests count.
    onHtml({ pathname, found, nav }) {
      if (pathname === '/console/index.html' && (nav.document || nav.framed)) {
        consoleState(found.session).pageLoads += 1;
      }
      // Route telemetry for reused-row and hovercard-oncall, never graded.
      if (!nav.document) return;
      if (pathname === '/console/queue.html') queueState(ctx, found.session).pageLoads += 1;
      if (pathname === '/console/services/orchid-api.html') oncallState(ctx, found.session).serviceLoads += 1;
      const person = /^\/console\/people\/([a-z]+)\.html$/.exec(pathname)?.[1];
      if (person) {
        const oc = oncallState(ctx, found.session);
        oc.profileLoads[person] = (oc.profileLoads[person] ?? 0) + 1;
      }
    },
  };
}
