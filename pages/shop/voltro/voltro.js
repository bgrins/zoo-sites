// Voltro marketplace listing: a card grid built from VOLTRO.products, where
// each product is [name, sizeInches, resolution, price, rating, reviews, inStock].

document.title = 'Voltro — Computer Monitors';

const BRANDS = [...new Set(VOLTRO.products.map((p) => p[0].split(' ')[0]))].slice(0, 6);
const COOKIE_CHOICE = 'voltro.cookie-choice';

function cookieChoice() {
  try {
    return localStorage.getItem(COOKIE_CHOICE);
  } catch {
    return null;
  }
}

document.body.insertAdjacentHTML(
  'afterbegin',
  `
  <header>
    <a class="wordmark" href="index.html">Voltro</a>
    <form class="finder" action="search.html" method="get" role="search">
      <input name="q" placeholder="Search Voltro" aria-label="Search Voltro">
      <button type="submit">Search</button>
    </form>
    <a class="acct" href="signin.html">Sign in</a>
    <a class="acct" href="orders.html">Orders &amp; returns</a>
    <a id="cartlink" class="cartlink" href="cart.html">Cart (0)</a>
  </header>
  <nav class="depts" aria-label="Departments">
    <a href="index.html" aria-current="page">Monitors</a>
    <a href="search.html?q=4K">4K monitors</a>
    <a href="desk-setup.html">Desk Setup</a>
    <a href="sell.html">Sell on Voltro</a>
    <a href="help.html">Help</a>
  </nav>
  <div class="promo">${VOLTRO.promo}</div>
  <main class="listing">
    <aside id="facets" aria-label="Filters">
      <h2>Department</h2>
      <ul>
        <li><a href="index.html">Monitors</a></li>
        <li><a href="desk-setup.html">Desk Setup</a></li>
      </ul>
      <h2>Screen size</h2>
      <label><input type="checkbox" data-filter="size:24"> 24 inch</label>
      <label><input type="checkbox" data-filter="size:27"> 27 inch</label>
      <label><input type="checkbox" data-filter="size:32"> 32 inch</label>
      <h2>Resolution</h2>
      <label><input type="checkbox" data-filter="res:1080p"> 1080p (FHD)</label>
      <label><input type="checkbox" data-filter="res:1440p"> 1440p (QHD)</label>
      <label><input type="checkbox" data-filter="res:4K"> 4K (UHD)</label>
      <h2>Brand</h2>
      ${BRANDS.map(
        (b) => `<label><input type="checkbox" data-filter="brand:${b}"> ${b}</label>`
      ).join('')}
      <h2>Availability</h2>
      <label><input type="checkbox" id="incloos" checked> Include out of stock</label>
    </aside>
    <section style="flex:1">
      <div id="toolbar">
        <h1>Computer Monitors</h1>
        <button type="button" id="filtersbtn" aria-controls="facets" aria-expanded="false">Filters</button>
        <span id="tally">1–${VOLTRO.products.length} of ${VOLTRO.products.length} results</span>
        <label>Sort by:
          <select id="sortsel" aria-label="Sort by">
            <option>Featured</option>
            <option>Price: Low to High</option>
            <option>Price: High to Low</option>
            <option>Top rated</option>
          </select>
        </label>
      </div>
      <ul id="grid" role="list" aria-label="Search results"></ul>
    </section>
  </main>
  <footer>
    <ul>
      <li><a href="help.html">Help</a></li>
      <li><a href="orders.html">Orders &amp; returns</a></li>
      <li><a href="returns.html">Delivery &amp; returns</a></li>
      <li><a href="sell.html">Sell on Voltro</a></li>
      <li><a href="careers.html">Careers</a></li>
      <li><a href="conditions.html">Terms of Use</a></li>
      <li><a href="privacy.html">Privacy</a></li>
      <li><a href="privacy.html#ads">Ad choices</a></li>
    </ul>
    <p>&copy; 2026 Voltro Marketplace, Inc., 2200 Pellmore Road, Vessendale, CO 80000.
    Prices and availability are subject to change.</p>
  </footer>
  ${cookieChoice() ? '' : `
  <div id="cookie-banner" role="dialog" aria-label="Cookie consent">
    <span>Voltro uses a session cookie to keep your cart, and optional measurement cookies
      to improve the store. <a href="privacy.html#cookies">Read how we use cookies</a></span>
    <button type="button" data-choice="accepted">Accept all cookies</button>
    <button type="button" data-choice="declined">Decline non-essential</button>
  </div>`}
`
);

for (const button of document.querySelectorAll('#cookie-banner button')) {
  button.addEventListener('click', () => {
    try {
      localStorage.setItem(COOKIE_CHOICE, button.dataset.choice);
    } catch {
      // Private browsing can refuse storage; the banner still closes for this page.
    }
    document.getElementById('cookie-banner').remove();
  });
}

const filtersBtn = document.getElementById('filtersbtn');
filtersBtn.addEventListener('click', () => {
  const open = document.getElementById('facets').classList.toggle('open');
  filtersBtn.setAttribute('aria-expanded', String(open));
});

const RES_LABEL = {
  '1080p': 'FHD 1920x1080',
  '1440p': 'QHD 2560x1440',
  '4K': '4K UHD 3840x2160',
};

const grid = document.getElementById('grid');
const catalog = [];
VOLTRO.products.forEach(([name, size, res, price, rating, reviews, inStock], i) => {
  const card = document.createElement('li');
  card.className = 'card';
  const hue = (name.length * 37 + name.charCodeAt(0) * 11) % 360;
  const wasPrice = (price * 1.22 + 15).toFixed(2);
  card.innerHTML = `
    ${i === 2 || i === 9 ? '<span class="sponsored">Promoted</span>' : ''}
    <svg viewBox="0 0 160 90" class="thumb" role="img" aria-label="${name} product photo">
      <rect width="160" height="90" fill="hsl(${hue},18%,90%)"/>
      <rect x="22" y="8" width="116" height="62" rx="3" fill="#1b1f27"/>
      <rect x="72" y="72" width="16" height="8" fill="#444"/>
      <rect x="56" y="80" width="48" height="4" fill="#666"/>
    </svg>
    <div class="name"><a href="product.html?name=${encodeURIComponent(name)}">${name}</a></div>
    <div class="attrs">${size}" ${RES_LABEL[res]} · IPS · ${res === '4K' ? '60Hz' : '144Hz'} · HDMI/DP</div>
    <div class="rating">
      <span aria-hidden="true">${'★'.repeat(Math.round(rating))}${'☆'.repeat(5 - Math.round(rating))}</span>
      <span style="color:#56625d">${rating} out of 5 (${reviews.toLocaleString()} ratings)</span></div>
    <div class="price">$${price.toFixed(2)}
      ${i % 4 !== 3 ? `<s>$${wasPrice}</s> <span class="save">Save ${Math.round((1 - price / wasPrice) * 100)}%</span>` : ''}
    </div>
    <div class="permo">or $${(price / 12).toFixed(2)}/mo for 12 mo</div>
    <div class="fulfill">${i % 3 ? `FREE shipping — get it ${document.body.dataset.arrives}` : 'Pickup today at the Downtown counter'}</div>
    <div class="${inStock ? 'stock-in' : 'stock-out'}">${
      inStock
        ? 'In stock — ships within 24 hours.'
        : 'Temporarily out of stock. No restock date available.'
    }</div>
    ${inStock ? '<button type="button">Add to Cart</button>' : '<button type="button" disabled>Currently unavailable</button>'}
  `;
  grid.appendChild(card);
  catalog.push({ el: card, i, name, size, res, price, rating, brand: name.split(' ')[0], inStock });
});

// Facets and sorting run over the already rendered cards: card elements are
// reordered or detached, never rebuilt, so add-to-cart handlers survive.
function checkedFilterValues(field) {
  return [...document.querySelectorAll(`[data-filter^="${field}:"]:checked`)].map(
    (box) => box.dataset.filter.split(':')[1]
  );
}

function applyListing() {
  const sizes = checkedFilterValues('size');
  const reses = checkedFilterValues('res');
  const brands = checkedFilterValues('brand');
  const includeOos = document.getElementById('incloos').checked;
  const visible = catalog.filter(
    (c) =>
      (!sizes.length || sizes.includes(String(c.size))) &&
      (!reses.length || reses.includes(c.res)) &&
      (!brands.length || brands.includes(c.brand)) &&
      (c.inStock || includeOos)
  );
  const mode = document.getElementById('sortsel').value;
  if (mode === 'Price: Low to High') visible.sort((a, b) => a.price - b.price);
  else if (mode === 'Price: High to Low') visible.sort((a, b) => b.price - a.price);
  else if (mode === 'Top rated') visible.sort((a, b) => b.rating - a.rating);
  else visible.sort((a, b) => a.i - b.i);
  grid.replaceChildren(...visible.map((c) => c.el));
  document.getElementById('tally').textContent = visible.length
    ? `1–${visible.length} of ${catalog.length} results`
    : 'No results match your filters.';
}

for (const box of document.querySelectorAll('aside input[type="checkbox"]')) {
  box.addEventListener('change', applyListing);
}
document.getElementById('sortsel').addEventListener('change', applyListing);
