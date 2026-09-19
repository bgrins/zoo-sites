// The basket count in the shop header, and the Add to basket buttons on product cards.
const basketCount = document.getElementById('basketCount');

function showCount(n) {
  if (basketCount) basketCount.textContent = n ? '(' + n + ')' : '';
}

fetch('/api/paylink/basket', { headers: { 'X-Session-Nonce': NONCE } })
  .then((res) => (res.ok ? res.json() : null))
  .then((b) => b && showCount(b.count))
  .catch(() => {});

for (const button of document.querySelectorAll('button.add[data-sku]')) {
  const note = button.parentElement.querySelector('.addnote');
  button.addEventListener('click', async () => {
    button.disabled = true;
    note.textContent = '';
    try {
      const res = await fetch('/api/paylink/basket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: NONCE, sku: button.dataset.sku, add: 1 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        note.textContent =
          res.status === 403 ? 'This page has been open too long. Reload it and try again.' : data.error || 'Not added (HTTP ' + res.status + ').';
      } else {
        note.textContent = 'Added. ';
        const view = document.createElement('a');
        view.href = 'basket.html';
        view.textContent = 'View basket';
        note.append(view);
        showCount(data.count);
      }
    } catch {
      note.textContent = 'The shop is not reachable. Try again.';
    }
    button.disabled = false;
  });
}
