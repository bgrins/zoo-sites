// pages/console/ - Cindergrid deploy console run 4192 (canvas-log).
import { randomBytes } from 'node:crypto';

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

export function consoleState(session) {
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
      offPageReads: 0,
    };
  }
  return session.console;
}

// Did this read come from the viewer, or from a shell? Same idiom as the
// Kettleforge review gate: Sec-Fetch-Site is a forbidden header name for
// fetch()/XHR, but `curl -H` sets it freely, so this is not proof a browser did
// it — it is one of the two factors the route label uses, the other being
// `pageLoads`, which only a document navigation to /console/ increments.
function consoleFromPage(req) {
  return (
    req.headers['sec-fetch-site'] === 'same-origin' ||
    /\/console\//.test(req.headers.referer ?? '')
  );
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

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage, isDocumentNav } = ctx;
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
    // document navigations and the route label also requires a page load.
    if (req.method === 'GET' && pathname0 === '/api/console/raw') {
      const found = getSession(req);
      if (!found) return json(res, 403, { error: 'session required' });
      const con = consoleState(found.session);
      con.rawFetches += 1;
      if (isDocumentNav(req)) con.rawNavs += 1;
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

    return false;
  };
}
