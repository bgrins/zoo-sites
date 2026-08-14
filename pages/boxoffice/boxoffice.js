let plan = null;
let picks = [];
let holdId = null;
const seatEls = new Map();

const money = (n) => Number(n).toFixed(2);

function seatPrice(id) {
  const row = plan.rows.find((r) => r.row === id[0]);
  return row ? row.price : 0;
}

function setLabel(el, seat) {
  const picked = picks.includes(seat.id);
  el.setAttribute(
    'aria-label',
    `${seat.id} ${money(seat.price)} ${picked ? 'selected' : seat.state === 'held' ? 'selected' : seat.state}`
  );
  el.classList.toggle('picked', picked);
}

function registerSeat(el, seat) {
  seatEls.set(seat.id, { el, seat });
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  setLabel(el, seat);
  const act = () => toggleSeat(seat.id);
  el.addEventListener('click', act);
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      act();
    }
  });
}

function toggleSeat(id) {
  const index = picks.indexOf(id);
  if (index === -1) {
    if (picks.length >= 2) picks.shift();
    picks.push(id);
  } else {
    picks.splice(index, 1);
  }
  for (const { el, seat } of seatEls.values()) setLabel(el, seat);
  renderSelection();
}

function renderBrief() {
  document.getElementById('briefPatron').textContent = plan.brief.patron;
  document.getElementById('briefRef').textContent = plan.brief.reference;
  const terms = document.getElementById('briefTerms');
  terms.textContent = '';
  for (const line of plan.brief.terms) {
    const li = document.createElement('li');
    li.textContent = line;
    terms.appendChild(li);
  }
  document.getElementById('briefNote').textContent = plan.brief.note;
}

function renderSelection() {
  const list = document.getElementById('pickList');
  list.textContent = '';
  for (const id of picks) {
    const li = document.createElement('li');
    li.textContent = `${id} - ${money(seatPrice(id))}`;
    list.appendChild(li);
  }
  const total = picks.reduce((sum, id) => sum + seatPrice(id), 0);
  document.getElementById('pickTotal').textContent = picks.length
    ? `Total ${money(total)}`
    : 'No seats chosen';
  document.getElementById('holdBtn').disabled = picks.length === 0;
}

function renderStanding() {
  const confirmPanel = document.getElementById('confirmPanel');
  const donePanel = document.getElementById('donePanel');
  if (plan.order) {
    holdId = null;
    confirmPanel.hidden = true;
    donePanel.hidden = false;
    document.getElementById('confCode').textContent = plan.order.code;
    document.getElementById('confSeats').textContent =
      `${plan.order.seats.join(' ')} - ${money(plan.order.total)}`;
    return;
  }
  donePanel.hidden = true;
  if (plan.hold) {
    holdId = plan.hold.id;
    if (!picks.length) picks = [...plan.hold.seats];
    confirmPanel.hidden = false;
    document.getElementById('heldLine').textContent =
      `${plan.hold.seats.join(' ')} - total ${money(plan.hold.total)}`;
  } else {
    holdId = null;
    confirmPanel.hidden = true;
  }
}

async function loadPlan() {
  const res = await fetch(`/api/boxoffice/seats?view=${PAGE_VIEW}`, {
    headers: { 'X-Session-Nonce': NONCE },
  });
  if (!res.ok) {
    document.getElementById('planStatus').textContent =
      'The seating plan is unavailable at this counter.';
    return;
  }
  plan = await res.json();
  document.getElementById('planStatus').textContent = '';
  seatEls.clear();
  renderBrief();
  renderPlan(plan);
  renderStanding();
  renderSelection();
  for (const { el, seat } of seatEls.values()) setLabel(el, seat);
}

function showOutcome(message, detail, bad) {
  const outcome = document.getElementById('holdOutcome');
  outcome.textContent = message ?? '';
  outcome.className = bad ? 'outcome bad' : 'outcome';
  document.getElementById('holdDetail').textContent = detail ?? '';
}

document.getElementById('holdBtn').addEventListener('click', async () => {
  showOutcome('Asking the counter', '');
  const res = await fetch('/api/boxoffice/hold', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: NONCE, seats: picks }),
  });
  if (!res.ok) {
    showOutcome('The counter did not answer.', '', true);
    return;
  }
  const body = await res.json();
  showOutcome(body.message, body.detail, !body.held);
  if (body.held) {
    holdId = body.holdId;
    plan.hold = { id: body.holdId, seats: body.seats, total: body.total };
    renderStanding();
  }
});

document.getElementById('confirmBtn').addEventListener('click', async () => {
  const res = await fetch('/api/boxoffice/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: NONCE, holdId }),
  });
  if (!res.ok) {
    showOutcome('The counter did not answer.', '', true);
    return;
  }
  const body = await res.json();
  if (body.ok) {
    picks = [];
    await loadPlan();
    showOutcome(body.message, body.detail);
  } else {
    showOutcome(body.message, body.detail, true);
  }
});

loadPlan();
