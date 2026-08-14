// Storefront behaviour for the Northmarsh catalogue: live facets over the
// rendered cards, a session basket held server-side, and the count in the
// header. Filtering happens on the cards already in the document.
(function () {
  const NONCE = window.NONCE;
  const cards = [...document.querySelectorAll('#grid .card')];
  const count = document.querySelector('.count');
  const pager = document.getElementById('pager');

  const catBoxes = [...document.querySelectorAll('input[name=cat]')];
  const priceBoxes = [...document.querySelectorAll('input[name=price]')];

  function apply() {
    const cats = catBoxes.filter((b) => b.checked).map((b) => b.value);
    const bands = priceBoxes
      .filter((b) => b.checked)
      .map((b) => b.value.split('-').map(Number));
    let shown = 0;
    for (const card of cards) {
      const okCat = !cats.length || cats.includes(card.dataset.cat);
      const price = Number(card.dataset.price);
      const okPrice = !bands.length || bands.some(([lo, hi]) => price >= lo && price <= hi);
      const on = okCat && okPrice;
      card.style.display = on ? '' : 'none';
      if (on) shown += 1;
    }
    if (count) {
      count.textContent =
        shown === cards.length
          ? `${cards.length} products · sorted by staff pick`
          : `${shown} of ${cards.length} products match your filters`;
    }
    if (pager) {
      pager.textContent = `Showing ${shown ? 1 : 0} to ${shown} of ${shown} · Page 1 of 1`;
    }
  }
  for (const box of [...catBoxes, ...priceBoxes]) box.addEventListener('change', apply);

  // Nav deep links: index.html?cat=packs pre-ticks the matching facet.
  const preset = new URLSearchParams(location.search).get('cat');
  if (preset) {
    const box = catBoxes.find((b) => b.value === preset);
    if (box) {
      box.checked = true;
      apply();
    }
  }

  async function refreshCount() {
    const el = document.getElementById('bcount');
    if (!el) return;
    try {
      const r = await fetch('/api/gallery/basket', { headers: { 'X-Session-Nonce': NONCE } });
      if (!r.ok) return;
      const body = await r.json();
      el.textContent = body.items.reduce((n, it) => n + it.qty, 0);
    } catch {
      // leave the count as-is when the depot network is unreachable
    }
  }

  for (const card of cards) {
    const button = card.querySelector('button');
    if (!button) continue;
    button.addEventListener('click', async () => {
      const sku = card.querySelector('.sku')?.textContent.replace(/^SKU\s+/, '') ?? '';
      button.disabled = true;
      try {
        const r = await fetch('/api/gallery/basket', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nonce: NONCE, sku }),
        });
        if (r.ok) {
          button.textContent = 'Added to basket';
          await refreshCount();
        } else {
          button.textContent = 'Could not add';
        }
      } catch {
        button.textContent = 'Could not add';
      }
      setTimeout(() => {
        button.textContent = 'Add to basket';
        button.disabled = false;
      }, 1400);
    });
  }

  refreshCount();
})();
