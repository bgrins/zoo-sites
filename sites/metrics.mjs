// pages/metrics/ - Halbeck Active seats trend (chart-escape).
import { randomBytes } from 'node:crypto';

// pages/metrics/ — the Halbeck console's Active seats trend (chart-escape). The
// 18-month series is minted per session from randomBytes and released only
// through the gated reads below, so no figure the validator grades exists under
// pages/; the canvas is drawn client-side from the fetched JSON and no figure
// reaches an attribute, a title or the fallback text. The mint keeps the
// steepest month-over-month fall unique BOTH in seats and as a percentage (so
// either reading of "steepest" names the same month) while holding the
// runner-up fall within 1.8% of the plot height of it, so the two are
// indistinguishable on the canvas and only the table view, the CSV export or
// the JSON settles which is which.
const METRICS_MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const METRICS_POINTS = 18;

const METRICS_LAST = { year: 2026, monthIndex: 5 };

function metricsLabels() {
  const out = [];
  let { year, monthIndex } = METRICS_LAST;
  for (let i = 0; i < METRICS_POINTS; i++) {
    out.unshift(`${METRICS_MONTH_NAMES[monthIndex]} ${year}`);
    if (--monthIndex < 0) {
      monthIndex = 11;
      year -= 1;
    }
  }
  return out;
}

function metricsMint(draw = (_scope, n) => randomBytes(n)) {
  const labels = metricsLabels();
  let seed = draw('metrics', 4).readUInt32BE(0);
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const pick = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  for (let attempt = 0; attempt < 8000; attempt++) {
    // Both falls sit away from the ends: the final point feeds the console's
    // "latest" and "change on last month" tiles, which are real markup.
    const deepAt = pick(2, 15);
    const nearAt = pick(2, 15);
    if (Math.abs(deepAt - nearAt) < 4) continue;
    const riseAt = pick(1, 17);
    if (riseAt === deepAt || riseAt === nearAt) continue;
    const deep = pick(2600, 3900);
    const near = deep - pick(20, 90);
    const deltas = [];
    for (let i = 1; i < METRICS_POINTS; i++) deltas.push(Math.round((rand() - 0.35) * 2300));
    deltas[deepAt - 1] = -deep;
    deltas[nearAt - 1] = -near;
    deltas[riseAt - 1] = pick(2200, 3400);
    const values = [pick(33000, 39000)];
    for (const d of deltas) values.push(values[values.length - 1] + d);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo;
    if (lo < 22000 || hi > 64000) continue;
    if (span < 8000 || span > 22000) continue;
    if ((deep - near) / span > 0.018) continue;
    if (values[deepAt] % 10 === 0 || values[nearAt] % 10 === 0) continue;
    const sorted = [...values].sort((x, y) => x - y);
    if (sorted.some((v, i) => i > 0 && v - sorted[i - 1] < 30)) continue;
    const falls = deltas.map((d, i) => ({ at: i + 1, drop: -d, pct: -d / values[i] }));
    const byDrop = [...falls].sort((x, y) => y.drop - x.drop);
    if (byDrop[0].at !== deepAt || byDrop[1].at !== nearAt) continue;
    if (byDrop[2].drop > near - 800) continue;
    const byPct = [...falls].sort((x, y) => y.pct - x.pct);
    if (byPct[0].at !== deepAt || byPct[1].at !== nearAt) continue;
    return {
      points: labels.map((label, i) => ({ label, value: values[i] })),
      target: {
        index: deepAt,
        label: labels[deepAt],
        value: values[deepAt],
        from: values[deepAt - 1],
        drop: deep,
      },
      runnerUp: {
        index: nearAt,
        label: labels[nearAt],
        value: values[nearAt],
        from: values[nearAt - 1],
        drop: near,
      },
    };
  }
  return null;
}

function metricsState(session, draw = (_scope, n) => randomBytes(n)) {
  if (!session.metrics) {
    // metricsMint only returns null if no draw in 8000 met the shape
    // constraints; measured acceptance is about one draw in a hundred and
    // twenty, so this has never been observed. A fresh seed is the only fallback.
    let minted = metricsMint(draw);
    while (!minted) minted = metricsMint(draw);
    session.metrics = {
      points: minted.points,
      target: minted.target,
      runnerUp: minted.runnerUp,
      seriesReads: 0,
      directReads: 0,
      tableViews: 0,
      csvReads: 0,
    };
  }
  return session.metrics;
}

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage, draw } = ctx;
  return async (req, res, url, pathname0) => {
    // pages/metrics/ — the Halbeck console (chart-escape). The minted series is
    // the graded ground truth, so every representation of it comes from here:
    // the JSON the canvas is drawn from, the CSV export, and the table view the
    // page renders from the same JSON. Each read is counted on the session so
    // the validator can REPORT which route the agent took; the counts are
    // deliberately not part of the pass decision, since a page nonce is enough
    // to forge any of them.
    if (req.method === 'GET' && pathname0 === '/api/metrics/series') {
      const found = requireSession(req, res);
      if (!found) return;
      const metrics = metricsState(found.session, draw);
      metrics.seriesReads += 1;
      // The console tags the read it makes to paint the canvas, so a read the
      // AGENT made is separable from the page's own. Route telemetry only.
      if (url.searchParams.get('src') !== 'chart') metrics.directReads += 1;
      return json(res, 200, {
        workspace: 'Northgate Media',
        metric: 'Active seats',
        grain: 'month',
        window: `${metrics.points[0].label} to ${metrics.points[METRICS_POINTS - 1].label}`,
        points: metrics.points,
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/metrics/view') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const metrics = metricsState(found.session, draw);
      if (payload?.view === 'table') metrics.tableViews += 1;
      return json(res, 200, { ok: true });
    }

    // The export link carries the session nonce in `k` because an anchor cannot
    // set X-Session-Nonce; a header-authenticated fetch of the same URL works too.
    if (req.method === 'GET' && pathname0 === '/api/metrics/export.csv') {
      const found = requireSession(req, res, url.searchParams.get('k'));
      if (!found) return;
      const metrics = metricsState(found.session, draw);
      metrics.csvReads += 1;
      const rows = ['month,active_seats'];
      for (const point of metrics.points) rows.push(`${point.label},${point.value}`);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="northgate-active-seats.csv"',
      });
      return res.end(rows.join('\n') + '\n');
    }

    return false;
  };
}
