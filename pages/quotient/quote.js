'use strict';

// Rate card v14. Lane charge is carriage per kilogram plus terminal handling;
// the quoted total applies the per-quote market rate multiplier and is
// rounded to the nearest dollar.
const LANES = {
  'harlow-dunmere': { label: 'Harlow - Dunmere', perKg: 3.62, terminal: 12.4 },
  casterway: { label: 'Casterway Corridor', perKg: 2.9, terminal: 18.0 },
  'veldt-north': { label: 'Veldt North', perKg: 3.95, terminal: 9.75 },
  'ilbrook-ferry': { label: 'Ilbrook Ferry', perKg: 2.45, terminal: 22.6 },
};

function baseFor(laneId, weight) {
  const lane = LANES[laneId];
  return Math.round((lane.perKg * weight + lane.terminal) * 100) / 100;
}

function totalFor(laneId, weight, rate) {
  const total = Math.round(baseFor(laneId, weight) * rate);
  return total;
}

function showProblem(text) {
  const notice = document.getElementById('qnotice');
  notice.textContent = text;
  notice.hidden = false;
}

async function priceIt() {
  const button = document.getElementById('price');
  const notice = document.getElementById('qnotice');
  const result = document.getElementById('result');
  const laneId = document.querySelector('input[name="lane"]:checked').value;
  const weight = Number(document.getElementById('weight').value);
  notice.hidden = true;
  if (!Number.isFinite(weight) || weight < 1 || weight > 200) {
    showProblem('Enter a consignment weight between 1 and 200 kg.');
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch('/api/quotient/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: window.QT_NONCE, lane: laneId, weight }),
    });
    const body = await response.json();
    if (!response.ok) {
      showProblem(body.error ?? 'The quoting service is unavailable. Try again later.');
      return;
    }
    const { rate, ref } = body;
    const total = totalFor(laneId, weight, rate);
    document.getElementById('total').textContent =
      '$' + total.toLocaleString('en-US');
    document.getElementById('resultnote').textContent =
      LANES[laneId].label + ', ' + weight + ' kg · quote ' + ref +
      ' · rounded to the nearest dollar';
    result.hidden = false;
  } finally {
    button.disabled = false;
  }
}

document.getElementById('price').addEventListener('click', priceIt);
