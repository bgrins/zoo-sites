'use strict';

// Reconciliation pipeline for batch payloads from /api/quotient/batch. Each
// step takes (rows, batch) and returns the transformed rows; composeSummary
// appends the posting summary card last.

function titleCase(name) {
  return name
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

function normalizeVendor(rows, batch) {
  return rows.map((row) => ({
    ...row,
    vendor:
      batch.vendorAliases[row.vendor.trim().toUpperCase()] ?? titleCase(row.vendor.trim()),
  }));
}

function applyFxRate(rows, batch) {
  const rates = batch.fx.rates;
  return rows.map((row) => ({
    ...row,
    amountHome: row.amount * (rates[row.currency] ?? 1),
    home: batch.fx.home,
  }));
}

function splitTaxLines(rows, batch) {
  const taxRates = batch.taxRules.rates;
  return rows.flatMap((row) => {
    const rate = taxRates[row.taxCode] ?? 0;
    if (rate <= 0) return [row];
    const net = row.amountHome / (1 + rate);
    return [
      { ...row, amountHome: net },
      {
        ...row,
        id: row.id + '-T',
        kind: 'tax',
        memo: 'Recoverable ' + row.taxCode + ' on ' + row.id,
        amountHome: row.amountHome - net,
        account: '1410',
      },
    ];
  });
}

function mergeAdjustments(rows, batch) {
  const open = batch.adjustments.filter((adj) => !adj.settled);
  return rows.map((row) => {
    const adj = open.find((entry) => entry.row === row.id);
    if (!adj) return row;
    return {
      ...row,
      amountHome: row.amountHome + adj.delta,
      adjusted: adj.reason,
    };
  });
}

function assignCostCenters(rows, batch) {
  const byAccount = batch.costCenters.byAccount;
  return rows.map((row) => ({
    ...row,
    costCenter: byAccount[row.account] ?? batch.costCenters.fallback,
  }));
}

function roundHalfEven(value, precision) {
  const factor = 10 ** precision;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (Math.abs(diff - 0.5) > 1e-9) return Math.round(scaled) / factor;
  return (floor % 2 === 0 ? floor : floor + 1) / factor;
}

function applyRoundingPolicy(rows, batch) {
  const mode = batch.rounding.mode;
  const precision = batch.rounding.precision;
  const round =
    mode === 'half-even'
      ? (value) => roundHalfEven(value, precision)
      : (value) => {
          const factor = 10 ** precision;
          return Math.round(value * factor) / factor;
        };
  return rows.map((row) => ({ ...row, amountHome: round(row.amountHome) }));
}

function flagAging(rows, batch) {
  const openPeriod = batch.periods.open;
  return rows.map((row) => {
    const posted = row.posted.slice(0, 7);
    if (posted >= openPeriod) return row;
    return { ...row, aged: 'Carried from ' + posted };
  });
}

function composeSummary(rows, batch) {
  const journal = batch.ledgerMeta.journal;
  const total = rows.reduce((sum, row) => sum + row.amountHome, 0);
  return rows.concat([
    {
      kind: 'summary',
      vendor: journal + ' — ' + batch.ledgerMeta.period,
      memo: rows.length + ' lines to post · prepared by ' + batch.ledgerMeta.preparedBy,
      amountHome: Math.round(total * 100) / 100,
      home: 'USD',
    },
  ]);
}

const PIPELINE = [
  normalizeVendor,
  applyFxRate,
  splitTaxLines,
  mergeAdjustments,
  assignCostCenters,
  applyRoundingPolicy,
  flagAging,
  composeSummary,
];

function money(row) {
  const amount = Number(row.amountHome ?? row.amount);
  return (row.home ?? row.currency) + ' ' + amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function renderCards(rows) {
  const box = document.getElementById('cards');
  box.textContent = '';
  for (const row of rows) {
    const card = document.createElement('div');
    card.className = row.kind === 'summary' ? 'card summary' : 'card';
    const left = document.createElement('div');
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = row.vendor + (row.id ? ' · ' + row.id : '');
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = row.memo;
    left.append(who, what);
    const tags = [
      row.kind === 'tax' ? 'tax line' : null,
      row.adjusted ? 'adjusted' : null,
      row.aged ? 'carried' : null,
      row.costCenter ?? null,
    ].filter(Boolean);
    if (tags.length) {
      const badge = document.createElement('div');
      badge.className = 'tags';
      badge.textContent = tags.join(' · ');
      left.append(badge);
    }
    const right = document.createElement('div');
    right.className = 'amt';
    right.textContent = money(row);
    card.append(left, right);
    box.append(card);
  }
}

function showBusy() {
  const busy = document.createElement('span');
  busy.className = 'busy';
  busy.id = 'busy';
  const dot = document.createElement('span');
  dot.className = 'dot';
  busy.append(dot, 'Running reconciliation…');
  document.getElementById('run').after(busy);
}

function clearBusy() {
  document.getElementById('busy')?.remove();
  document.getElementById('run').disabled = false;
}

async function runReconciliation() {
  const button = document.getElementById('run');
  const notice = document.getElementById('notice');
  button.disabled = true;
  notice.hidden = true;
  showBusy();
  const response = await fetch('/api/quotient/batch', {
    headers: { 'X-Session-Nonce': window.QT_NONCE },
  });
  const payload = await response.json();
  if (response.status === 410) {
    clearBusy();
    notice.textContent = payload.message;
    notice.hidden = false;
    return;
  }
  if (!response.ok) {
    clearBusy();
    notice.textContent = 'The reconciliation service is unavailable. Try again later.';
    notice.hidden = false;
    return;
  }
  // Let the busy indicator paint before the synchronous pipeline runs.
  setTimeout(() => {
    try {
      let rows = payload.rows.map((row) => ({ ...row }));
      for (const step of PIPELINE) {
        rows = step(rows, payload);
      }
      renderCards(rows);
    } finally {
      clearBusy();
    }
  }, 30);
}

document.getElementById('run').addEventListener('click', runReconciliation);
