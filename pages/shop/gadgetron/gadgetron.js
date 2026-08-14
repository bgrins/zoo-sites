// Gadgetron spec index: every SKU is one row of the comparison table. Prices
// live in the row's data-price attribute as well as the cell text. Facets and
// the row-order select run client-side over the built rows; rows are detached
// or reordered, never rebuilt, so the delegated order controls keep working.

const NATIVE = {
  '1080p': '1920x1080',
  '1440p': '2560x1440',
  '4K': '3840x2160',
};
const CLASS_LABEL = { '1080p': 'FHD', '1440p': 'QHD', '4K': 'UHD-4K' };

const OK_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<circle cx="8" cy="8" r="7" fill="#1d7a3c"/>' +
  '<path d="M4.5 8.4 l2.2 2.2 l4.8 -5.2" fill="none" stroke="#fff" stroke-width="1.8"/></svg>';
const NO_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<circle cx="8" cy="8" r="7" fill="#b3202c"/>' +
  '<path d="M5 5 l6 6 M11 5 l-6 6" fill="none" stroke="#fff" stroke-width="1.8"/></svg>';

const body = document.getElementById('rows');
const built = [];

for (const row of GADGETRON_ROWS) {
  const tr = document.createElement('tr');
  tr.dataset.sku = row.model;
  tr.dataset.stock = row.stock;
  tr.innerHTML =
    `<td><input type="checkbox" aria-label="Select row for comparison"></td>` +
    `<td class="model">${row.model}</td>` +
    `<td class="num">${row.diag}</td>` +
    `<td class="mono">${NATIVE[row.res]}</td>` +
    `<td>${CLASS_LABEL[row.res]}</td>` +
    `<td>IPS</td>` +
    `<td class="num">${row.res === '4K' ? '60' : '144'}</td>` +
    `<td class="num">${row.rating.toFixed(1)}</td>` +
    `<td class="num">${row.reviews.toLocaleString()}</td>` +
    `<td class="stock">${row.stock === 'y' ? OK_ICON : NO_ICON}` +
    `<span class="offscreen">${row.stock === 'y' ? 'In stock' : 'Sold out online'}</span></td>` +
    `<td class="price" data-price="${row.price.toFixed(2)}">${row.price.toFixed(2)}</td>` +
    `<td class="order">` +
    `<span class="stepper"><button type="button" aria-label="Decrease quantity">&minus;</button>` +
    `<input type="text" inputmode="numeric" value="1" aria-label="Quantity">` +
    `<button type="button" aria-label="Increase quantity">+</button></span>` +
    `<button type="button" class="buy"${row.stock === 'y' ? '' : ' disabled'}>` +
    `${row.stock === 'y' ? 'Buy it now' : 'Waitlist'}</button></td>`;
  body.appendChild(tr);
  built.push({ tr, row, hz: row.res === '4K' ? 60 : 144 });
}

function rowField(entry, field) {
  if (field === 'hz') return entry.hz;
  return entry.row[field];
}

for (const facet of document.querySelectorAll('[data-facet]')) {
  const [field, value] = facet.dataset.facet.split(':');
  const hits = built.filter((e) => String(rowField(e, field)) === value).length;
  facet.querySelector('.hits').textContent = '(' + hits + ')';
}

const orderSelect = document.querySelector('.statline select');

function applyIndex() {
  const active = [...document.querySelectorAll('[data-facet] input:checked')].map(
    (box) => box.closest('[data-facet]').dataset.facet.split(':')
  );
  const byField = {};
  for (const [field, value] of active) (byField[field] ??= []).push(value);
  const visible = built.filter((entry) =>
    Object.entries(byField).every(([field, values]) =>
      values.includes(String(rowField(entry, field)))
    )
  );
  const mode = orderSelect.value;
  if (mode === 'Part number') {
    visible.sort((a, b) => a.row.model.localeCompare(b.row.model));
  } else if (mode === 'Price, ascending') {
    visible.sort((a, b) => a.row.price - b.row.price);
  } else if (mode === 'Price, descending') {
    visible.sort((a, b) => b.row.price - a.row.price);
  } else if (mode === 'Rating') {
    visible.sort((a, b) => b.row.rating - a.row.rating);
  } else if (mode === 'Diagonal') {
    visible.sort((a, b) => a.row.diag - b.row.diag);
  } else {
    visible.sort((a, b) => built.indexOf(a) - built.indexOf(b));
  }
  body.replaceChildren(...visible.map((entry) => entry.tr));
  document.getElementById('matched').textContent = visible.length + ' SKUs matched';
  document.getElementById('rowsnote').textContent = visible.length
    ? 'Rows 1-' + visible.length + ' of ' + built.length +
      '. Prices are per unit in USD, excluding tax and recycling levy.'
    : 'No rows match the selected filters.';
}

for (const box of document.querySelectorAll('[data-facet] input')) {
  box.addEventListener('change', applyIndex);
}
orderSelect.addEventListener('change', applyIndex);
document.querySelector('.facets .reset').addEventListener('click', (event) => {
  event.preventDefault();
  for (const box of document.querySelectorAll('.facets input:checked')) box.checked = false;
  orderSelect.selectedIndex = 0;
  applyIndex();
});

document.getElementById('matched').textContent =
  GADGETRON_ROWS.length + ' SKUs matched';
document.getElementById('rowsnote').textContent =
  'Rows 1-' + GADGETRON_ROWS.length + ' of ' + GADGETRON_ROWS.length +
  '. Prices are per unit in USD, excluding tax and recycling levy.';

const orderCount = document.getElementById('order-count');
const compareNote = document.getElementById('compare-note');

function refreshCompare() {
  const chosen = [...body.querySelectorAll('td input[type="checkbox"]:checked')].map(
    (box) => box.closest('tr').dataset.sku
  );
  if (chosen.length < 2) {
    compareNote.innerHTML = chosen.length
      ? '1 row selected; select at least 2 to compare.'
      : '';
    return;
  }
  compareNote.innerHTML =
    chosen.length + ' rows selected: <a href="compare.html?models=' +
    encodeURIComponent(chosen.join('|')) + '">compare side by side</a>';
}

body.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox') {
    refreshCompare();
  }
});

body.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const stepper = target.closest('.stepper');
  if (stepper) {
    const field = stepper.querySelector('input');
    const next = Number(field.value) + (target.textContent === '+' ? 1 : -1);
    field.value = String(Math.max(1, Math.min(9, next)));
    return;
  }
  // Only the buying desk can commit a part number, so a row's buy control hands
  // the part and quantity to the order list instead of queueing anything here.
  if (target.classList.contains('buy')) {
    const row = target.closest('tr');
    const qty = row.querySelector('.stepper input').value;
    window.location.href =
      'order-list.html?part=' + encodeURIComponent(row.dataset.sku) +
      '&qty=' + encodeURIComponent(qty);
  }
});

async function showQueued() {
  try {
    const res = await fetch('/api/shop/cart?store=gadgetron', {
      headers: { 'X-Session-Nonce': window.GADGETRON_NONCE },
    });
    if (!res.ok) return;
    const desk = await res.json();
    orderCount.textContent = desk.count + ' queued';
  } catch {
    // the header count is cosmetic; the order list page is the source of truth
  }
}

showQueued();
