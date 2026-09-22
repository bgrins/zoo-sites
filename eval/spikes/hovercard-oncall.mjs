// Probes a hovercard that exists only while the pointer or focus is on its
// link or on the card itself: whether each condition's hover opens it, what the
// hover reply says, whether filling the card's message box and clicking its
// Page button survive the pointer move off the link, and whether the profile
// page, the slower route, pages as well; measured on firefox-devtools-mcp
// 0.9.15 and 0.10.3 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0). One
// browser runs at a time.

import { findings, page, probeServer, sleep, surface } from './lib.mjs';

const HANDLES = ['vessa', 'orlin', 'teodric', 'mauve', 'quillon', 'brisk'];
const ON_CALL = 'teodric';
const status = (h) => (h === ON_CALL ? 'On call until 18:40' : 'Off call, back Thu');
const cardGets = [];
const pages = [];

// The card follows the usual hovercard shape: a 300ms intent timer on
// mouseenter or focus, the card fetched then, and a 400ms close once neither
// the pointer nor focus is on the link or the card, so the pointer can cross
// the gap into it.
const CARD = `
  const card = document.getElementById('card');
  let intent = null, closer = null, owner = null, overLink = false, overCard = false;
  const inside = () => overLink || overCard || card.contains(document.activeElement) ||
    (owner && owner === document.activeElement);
  const later = () => { clearTimeout(closer); closer = setTimeout(() => { if (!inside()) { card.hidden = true; owner = null; } }, 400); };
  async function open(a) {
    const h = a.dataset.h;
    const r = await fetch('/card?h=' + h);
    const d = await r.json();
    owner = a;
    card.innerHTML = '<p class="st"></p><p class="nm"></p><textarea aria-label="Page message"></textarea><button type="button">Page</button><p class="rc" role="status"></p>';
    card.querySelector('.st').textContent = d.status;
    card.querySelector('.nm').textContent = d.name;
    card.setAttribute('aria-label', 'Profile card for @' + h);
    card.querySelector('button').onclick = async () => {
      const message = card.querySelector('textarea').value;
      const res = await fetch('/page', { method: 'POST', body: JSON.stringify({ h, message }) });
      card.querySelector('.rc').textContent = 'Paged. Receipt ' + (await res.text());
    };
    const box = a.getBoundingClientRect();
    card.style.top = box.top + window.scrollY + 'px';
    card.style.left = box.right + 16 + 'px';
    card.hidden = false;
  }
  for (const a of document.querySelectorAll('a.h')) {
    const start = () => { clearTimeout(intent); intent = setTimeout(() => open(a), 300); };
    a.addEventListener('mouseenter', () => { overLink = true; start(); });
    a.addEventListener('focus', start);
    a.addEventListener('mouseleave', () => { overLink = false; clearTimeout(intent); later(); });
    a.addEventListener('blur', () => { clearTimeout(intent); later(); });
  }
  card.addEventListener('mouseenter', () => { overCard = true; clearTimeout(closer); });
  card.addEventListener('mouseleave', () => { overCard = false; later(); });
  card.addEventListener('focusout', later);
`;

const probe = await probeServer({
  '/service': page(
    'orchid-api',
    `<h1 id="title">orchid-api</h1><h2>Owners</h2>
     <ul>${HANDLES.map((h) => `<li><a class="h" data-h="${h}" href="/people/${h}">@${h}</a></li>`).join('')}</ul>
     <div id="card" role="dialog" hidden style="position:absolute;width:260px;padding:10px;border:1px solid #444;background:#fff"></div>
     <script>${CARD}</script>`
  ),
  '/people/teodric': page(
    'teodric',
    `<h1>Teodric Vaunce</h1><p id="st"></p><textarea aria-label="Page message"></textarea><button type="button" id="p">Page</button><p id="rc" role="status"></p>
     <script>
       fetch('/card?h=teodric').then((r) => r.json()).then((d) => { document.getElementById('st').textContent = d.status; });
       document.getElementById('p').onclick = async () => {
         const res = await fetch('/page', { method: 'POST', body: JSON.stringify({ h: 'teodric', message: document.querySelector('textarea').value }) });
         document.getElementById('rc').textContent = 'Paged. Receipt ' + (await res.text());
       };
     </script>`
  ),
  '/covered': page(
    'orchid-api',
    `<ul><li><a id="first" href="#vessa">@vessa</a></li><li><a id="second" href="#teodric">@teodric</a></li></ul>
     <div id="card" hidden style="position:absolute;left:0;width:300px;height:120px;background:#eee">vessa <button>Page</button></div>
     <script>
       window.linkEntered = 0;
       window.cardEntered = 0;
       const card = document.getElementById('card');
       const first = document.getElementById('first');
       first.addEventListener('mouseenter', () => setTimeout(() => {
         card.style.top = first.getBoundingClientRect().bottom + 4 + 'px';
         card.hidden = false;
       }, 300));
       document.getElementById('second').addEventListener('mouseenter', () => window.linkEntered++);
       card.addEventListener('mouseenter', () => window.cardEntered++);
     </script>`
  ),
  '/card': (req, res, body, url) => {
    const h = url.searchParams.get('h');
    cardGets.push(h);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: status(h), name: h === ON_CALL ? 'Teodric Vaunce' : `${h} (owner)` }));
  },
  '/page': (req, res, body) => {
    pages.push(JSON.parse(body));
    res.end('PG-4E1B7C');
  },
});
const log = findings('A hovercard with an action inside it, per condition');
const MESSAGE = 'orchid-api 5xx above 4% in eu-west';
const cardState = (s) =>
  s.evaluate(() => {
    const card = document.getElementById('card');
    return {
      open: !card.hidden,
      status: card.querySelector('.st')?.textContent ?? null,
      typed: card.querySelector('textarea')?.value ?? null,
      receipt: card.querySelector('.rc')?.textContent || null,
    };
  });

const EXPECTED = {
  devtools: {
    hover: { open: true, status: 'On call until 18:40', cardGets: ['orlin', 'teodric'], replyNamesCard: false },
    snapshot: 'On call until 18:40',
    fill: { open: true, typed: MESSAGE },
    click: { open: true, receipt: 'Paged. Receipt PG-4E1B7C', pages: [{ h: 'teodric', message: MESSAGE }] },
    leave: { opened: true, status: 'Off call, back Thu', closed: true },
    profile: [{ h: 'teodric', message: MESSAGE }],
    covered: { toolError: false, timedOut: false, linkEntered: 1, cardEntered: 1 },
  },
  playwright: {
    hover: { open: true, status: 'On call until 18:40', cardGets: ['orlin', 'teodric'], replyNamesCard: false },
    snapshot: 'On call until 18:40',
    fill: { open: true, typed: MESSAGE },
    click: { open: true, receipt: 'Paged. Receipt PG-4E1B7C', pages: [{ h: 'teodric', message: MESSAGE }] },
    leave: { opened: true, status: 'Off call, back Thu', closed: true },
    profile: [{ h: 'teodric', message: MESSAGE }],
    covered: { toolError: true, timedOut: true, linkEntered: 0, cardEntered: 0 },
  },
};
const replies = {};

for (const name of ['devtools', 'playwright']) {
  const s = await surface(name);
  const dt = name === 'devtools';
  const act = {
    hover: (uid, element) => (dt ? s.call('hover_by_uid', { uid }) : s.call('browser_hover', { element, target: uid })),
    fill: (uid, element, text) =>
      dt ? s.call('fill_by_uid', { uid, value: text }) : s.call('browser_type', { element, target: uid, text }),
    click: (uid, element) => (dt ? s.call('click_by_uid', { uid }) : s.call('browser_click', { element, target: uid })),
  };
  await s.navigate(probe.url + '/service');
  await log.header(s);

  // A card opened by hovering one owner closes once the pointer moves off
  // both the link and the card, before anything inside it has focus.
  await s.navigate(probe.url + '/service');
  let snap = await s.snapshot();
  await act.hover(s.target(snap, /"@vessa"/), '@vessa');
  await sleep(900);
  const opened = await cardState(s);
  snap = await s.snapshot();
  await act.hover(s.target(snap, /(?:heading|h1) "orchid-api"/), 'orchid-api heading');
  await sleep(900);
  log.record(`${name} hover off the link closes the card`, {
    opened: opened.open,
    status: opened.status,
    closed: !(await cardState(s)).open,
  }, EXPECTED[name].leave);

  // Owner to owner: the card beside the list covers no other link, so a hover
  // straight from one handle to the next swaps the card.
  snap = await s.snapshot();
  cardGets.splice(0);
  await act.hover(s.target(snap, /"@orlin"/), '@orlin');
  await sleep(900);
  snap = await s.snapshot();
  const reply = await act.hover(s.target(snap, /"@teodric"/), '@teodric');
  replies[name] = dt ? reply.split('\n')[0] : (reply.match(/await page\.[^\n]*/)?.[0] ?? reply.split('\n')[0]);
  await sleep(900);
  log.record(`${name} hover from one owner to the next swaps the card`, {
    ...(({ open, status: st }) => ({ open, status: st }))(await cardState(s)),
    cardGets: cardGets.splice(0),
    replyNamesCard: /On call|Off call/.test(reply),
  }, EXPECTED[name].hover);

  snap = await s.snapshot();
  log.record(`${name} card status in the next snapshot`, snap.match(/(?:On|Off) call[^"\n]*/)?.[0] ?? null, EXPECTED[name].snapshot);

  await act.fill(s.target(snap, /Page message/), 'Page message', MESSAGE);
  await sleep(800);
  log.record(`${name} fill in the card keeps it open`, (({ open, typed }) => ({ open, typed }))(await cardState(s)), EXPECTED[name].fill);

  snap = await s.snapshot();
  await act.click(s.target(snap, /button "Page"/), 'Page');
  await sleep(900);
  log.record(`${name} click on the card's Page button survives the pointer move`, {
    ...(({ open, receipt }) => ({ open, receipt }))(await cardState(s)),
    pages: pages.splice(0),
  }, EXPECTED[name].click);

  await s.navigate(probe.url + '/people/teodric');
  await sleep(300);
  snap = await s.snapshot();
  await act.fill(s.target(snap, /Page message/), 'Page message', MESSAGE);
  snap = await s.snapshot();
  await act.click(s.target(snap, /button "Page"/), 'Page');
  await sleep(500);
  log.record(`${name} pages from the profile page`, pages.splice(0), EXPECTED[name].profile);

  // Why the fixture's card opens beside the list: a card opened below a link
  // covers the next one, and a hover aimed at the covered link behaves
  // differently per condition.
  await s.navigate(probe.url + '/covered');
  snap = await s.snapshot();
  await act.hover(s.target(snap, /"@vessa"/), '@vessa');
  await sleep(700);
  snap = await s.snapshot();
  const covered = await act.hover(s.target(snap, /"@teodric"/), '@teodric');
  log.record(`${name} hover onto a link an open card covers`, {
    toolError: /^(ERROR|THROW)/.test(covered),
    timedOut: /Timeout 5000ms exceeded/.test(covered),
    ...(await s.evaluate(() => ({ linkEntered: window.linkEntered, cardEntered: window.cardEntered }))),
  }, EXPECTED[name].covered);

  await s.close();
}

console.log(`\nhover replies:\n  devtools: ${replies.devtools}\n  playwright: ${replies.playwright}`);
await probe.close();
log.done();
