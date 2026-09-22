// Marrowgate big-box catalog: one horizontal result row per SKU, revealed in
// batches of PAGE_SIZE by the "Load more results" control. The refine bar
// filters and sorts the feed client-side and restarts the batching.

const PAGE_SIZE = 15;
const RESOLUTION = {
  '1080p': 'Full HD 1920 x 1080',
  '1440p': 'Quad HD 2560 x 1440',
  '4K': '4K Ultra HD 3840 x 2160',
};

const results = document.getElementById('results');
const moreWrap = document.querySelector('.more');
const moreButton = document.getElementById('more-results');
const moreNote = document.getElementById('more-note');
const tally = document.getElementById('tally');
const compareSelected = new Set();
let list = MARROWGATE_FEED.slice();
let shown = 0;

function priceMarkup(price) {
  const [whole, frac] = price.toFixed(2).split('.');
  return (
    `<span class="cur">$</span><span class="whole">${whole}</span>` +
    `<span class="frac">${frac}</span>`
  );
}

function productHref(item) {
  return item.sku === '6428193' ? 'cs27-4k.html' : `product.html?sku=${item.sku}`;
}

function rowMarkup(item) {
  const ready = item.availability === 'ships';
  const hue = (item.title.length * 29 + item.title.charCodeAt(0) * 7) % 360;
  return (
    `<div class="shot">
      <svg viewBox="0 0 132 74" role="img" aria-label="Product image, ${item.title}">
        <rect width="132" height="74" fill="hsl(${hue},22%,93%)"/>
        <rect x="14" y="6" width="104" height="54" rx="2" fill="#20242c"/>
        <rect x="58" y="60" width="16" height="6" fill="#8a8f99"/>
        <rect x="44" y="66" width="44" height="4" fill="#b3b8c2"/>
      </svg>
    </div>
    <div class="info">
      <h2 class="title"><a href="${productHref(item)}">${item.title}</a></h2>
      <p class="attrs">SKU ${item.sku} &middot; ${item.screen}" diagonal &middot; ${
        RESOLUTION[item.res]
      } &middot; IPS &middot; ${item.res === '4K' ? '60 Hz' : '165 Hz'}</p>
      <p class="stars"><span class="score">${item.rating} out of 5</span> (${item.reviews.toLocaleString()} customer reviews)</p>
      <p class="fulfil${ready ? '' : ' none'}">${
        ready
          ? 'Ships free to your address &middot; Store pickup: check nearby stores'
          : 'Not eligible for shipping or pickup'
      }</p>
    </div>
    <div class="buybox">
      <div class="pricetag">${priceMarkup(item.price)}</div>
      <span class="sr">Price $${item.price.toFixed(2)} each</span>
      <p class="avail ${ready ? 'ready' : 'gone'}">${ready ? 'Available to ship' : 'Sold out'}</p>
      ${
        ready
          ? `<a class="basket" data-add="${item.sku}" href="basket.html">Add to basket</a>`
          : `<a class="basket off" href="notify.html?sku=${item.sku}">Notify me when available</a>`
      }
      <a class="compare-link" data-compare="${item.sku}" href="compare.html">${
        compareSelected.has(item.sku) ? 'Remove from compare' : 'Add to compare'
      }</a>
    </div>`
  );
}

function renderBatch() {
  const slice = list.slice(shown, shown + PAGE_SIZE);
  for (const item of slice) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.sku = item.sku;
    li.innerHTML = rowMarkup(item);
    results.appendChild(li);
  }
  shown += slice.length;
  const left = list.length - shown;
  tally.textContent = list.length
    ? `Showing ${shown} of ${list.length} items in Monitors. ` +
      `Pickup store: ${window.marrowgateStore().name}.`
    : 'No items match the current refinements.';
  if (left > 0) {
    if (!moreButton.isConnected) moreWrap.insertBefore(moreButton, moreNote);
    moreButton.textContent = 'Load more results';
    moreNote.textContent = `${left} more item${left === 1 ? '' : 's'} not yet loaded.`;
  } else {
    moreButton.remove();
    moreNote.textContent = list.length ? 'End of results for Monitors.' : '';
  }
}

const REFINE = [
  ['f-size', 'Any size'],
  ['f-res', 'Any resolution'],
  ['f-avail', 'Show everything'],
  ['f-sort', 'Best match'],
];

function matchesSize(item, choice) {
  if (choice === '23 - 24 in') return item.screen <= 24;
  if (choice === '25 - 27 in') return item.screen >= 25 && item.screen <= 27;
  if (choice === '28 - 32 in') return item.screen >= 28;
  return true;
}

function refreshChips() {
  const chips = document.getElementById('chips');
  chips.innerHTML = '';
  for (const [id, neutral] of REFINE) {
    const sel = document.getElementById(id);
    if (sel.value === neutral) continue;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = sel.value + ' ×';
    chip.setAttribute('aria-label', `Remove refinement ${sel.value}`);
    chip.addEventListener('click', () => {
      sel.value = neutral;
      applyRefine();
    });
    chips.appendChild(chip);
  }
}

function applyRefine() {
  const size = document.getElementById('f-size').value;
  const res = document.getElementById('f-res').value;
  const avail = document.getElementById('f-avail').value;
  const sort = document.getElementById('f-sort').value;
  const resKey = { 'Full HD': '1080p', 'Quad HD': '1440p', '4K Ultra HD': '4K' }[res];
  list = MARROWGATE_FEED.filter(
    (item) =>
      matchesSize(item, size) &&
      (!resKey || item.res === resKey) &&
      (avail !== 'Available to ship' || item.availability === 'ships')
  );
  if (sort === 'Price low to high') list.sort((a, b) => a.price - b.price);
  else if (sort === 'Price high to low') list.sort((a, b) => b.price - a.price);
  else if (sort === 'Customer rating') list.sort((a, b) => b.rating - a.rating);
  refreshChips();
  results.innerHTML = '';
  shown = 0;
  renderBatch();
}

for (const [id] of REFINE) {
  document.getElementById(id).addEventListener('change', applyRefine);
}

function refreshCompareBar() {
  const bar = document.getElementById('comparebar');
  if (!compareSelected.size) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  bar.hidden = false;
  if (compareSelected.size === 1) {
    bar.textContent = '1 item selected. Add one more to compare side by side.';
    return;
  }
  const skus = [...compareSelected].join(',');
  bar.innerHTML =
    `${compareSelected.size} items selected. ` +
    `<a href="compare.html?skus=${skus}">Compare side by side</a>`;
}

async function refreshBasketCount() {
  const link = document.getElementById('basketlink');
  try {
    const res = await fetch('/api/shop/cart?store=marrowgate', {
      headers: { 'X-Session-Nonce': window.MARROWGATE_NONCE },
    });
    if (!res.ok) return;
    const body = await res.json();
    link.textContent = 'Basket · ' + body.count + ' item' + (body.count === 1 ? '' : 's');
  } catch {
    // header count is cosmetic; the basket page is the source of truth
  }
}

results.addEventListener('click', async (event) => {
  const compare = event.target.closest('a.compare-link');
  if (compare) {
    event.preventDefault();
    const sku = compare.dataset.compare;
    if (compareSelected.has(sku)) {
      compareSelected.delete(sku);
      compare.textContent = 'Add to compare';
    } else {
      compareSelected.add(sku);
      compare.textContent = 'Remove from compare';
    }
    refreshCompareBar();
    return;
  }
  const add = event.target.closest('a.basket[data-add]');
  if (!add) return;
  event.preventDefault();
  const sku = add.dataset.add;
  add.textContent = 'Adding…';
  try {
    const res = await fetch('/api/shop/cart/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: window.MARROWGATE_NONCE, store: 'marrowgate', sku, qty: 1 }),
    });
    if (res.ok) {
      add.textContent = 'In basket – view';
      add.removeAttribute('data-add');
      await refreshBasketCount();
    } else {
      const body = await res.json();
      add.textContent = body.error ?? 'Could not add – retry';
    }
  } catch {
    add.textContent = 'Could not add – retry';
  }
});

moreButton.addEventListener('click', renderBatch);
renderBatch();
refreshBasketCount();
