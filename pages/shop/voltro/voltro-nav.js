// Below the mobile breakpoint the department bar is replaced by a menu button;
// the panel is built on demand, so the desktop markup is left alone.
const MOBILE_NAV = window.matchMedia('(max-width: 600px)');
const MOBILE_LINKS = [
  ['All Departments', 'index.html'],
  ['Deals of the Day', 'deals.html'],
  ['Desk Setup', 'desk-setup.html'],
  ['Your Basket', null],
  ['Customer Service', 'help.html'],
];

// The department pages and the desk-setup pages keep separate baskets, so a
// hardcoded target sent a phone user to whichever one the page they were on does
// not fill. Mirror the cart the page's own header points at instead.
function basketHref() {
  const own = document.querySelector('#cartlink, a[href="basket.html"], a[href="cart.html"]');
  return own ? own.getAttribute('href') : 'basket.html';
}

function applyMobileNav() {
  const header = document.querySelector('header');
  const button = document.getElementById('menubtn');
  if (!MOBILE_NAV.matches) {
    if (button) button.remove();
    const panel = document.getElementById('mobilemenu');
    if (panel) panel.remove();
    return;
  }
  if (button) return;
  const toggle = document.createElement('button');
  toggle.id = 'menubtn';
  toggle.type = 'button';
  toggle.textContent = 'Menu';
  toggle.setAttribute('aria-expanded', 'false');
  header.prepend(toggle);
  const panel = document.createElement('nav');
  panel.id = 'mobilemenu';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Departments');
  panel.innerHTML = MOBILE_LINKS.map(
    ([label, href]) => `<a href="${href ?? basketHref()}">${label}</a>`
  ).join('');
  header.insertAdjacentElement('afterend', panel);
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
}

applyMobileNav();
MOBILE_NAV.addEventListener('change', applyMobileNav);
window.addEventListener('resize', applyMobileNav);
