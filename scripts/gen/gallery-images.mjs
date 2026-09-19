// Renders the Northmarsh product photos from SVG studio illustrations into the
// PNG paths the catalogue already uses. The three deliberately missing files
// (tw-6035, gb-5310, fg-5528) are never written: dead-images counts them.
// Run: node scripts/gen/gallery-images.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefox } from 'playwright';

const OUT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pages', 'gallery', 'img');
const W = 800;
const H = 600;

const studio = (inner, floorY = 500, floorRx = 250) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f6f7f5"/><stop offset="0.72" stop-color="#eceeea"/><stop offset="1" stop-color="#e2e5e0"/>
    </linearGradient>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="blur4"><feGaussianBlur stdDeviation="4"/></filter>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#000" stop-opacity="0.18"/><stop offset="0.35" stop-color="#fff" stop-opacity="0.10"/>
      <stop offset="0.6" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.22"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <ellipse cx="400" cy="${floorY}" rx="${floorRx}" ry="26" fill="#000" opacity="0.2" filter="url(#soft)"/>
  ${inner}
</svg>`;

const PHOTOS = {
  'hr-4182': studio(`
  <g transform="translate(400 300) rotate(-4)">
    <rect x="-150" y="-205" width="300" height="400" rx="70" fill="#56693a"/>
    <rect x="-150" y="-205" width="300" height="400" rx="70" fill="url(#sheen)"/>
    <path d="M-150 -120 q150 -40 300 0 v-30 q-150 -60 -300 0z" fill="#4a5c31"/>
    <rect x="-162" y="-250" width="324" height="120" rx="52" fill="#4b5d32"/>
    <rect x="-162" y="-250" width="324" height="120" rx="52" fill="url(#sheen)"/>
    <path d="M-140 -150 h280" stroke="#34401f" stroke-width="6" stroke-dasharray="2 10" stroke-linecap="round"/>
    <rect x="-100" y="-20" width="200" height="170" rx="40" fill="#63783f"/>
    <rect x="-100" y="-20" width="200" height="170" rx="40" fill="url(#sheen)"/>
    <path d="M-100 20 h200" stroke="#3a4623" stroke-width="5"/>
    <rect x="-196" y="-40" width="56" height="190" rx="24" fill="#46572d"/>
    <rect x="140" y="-40" width="56" height="190" rx="24" fill="#3f4f28"/>
    <rect x="-66" y="-290" width="22" height="200" rx="8" fill="#262c1b"/>
    <rect x="44" y="-290" width="22" height="200" rx="8" fill="#262c1b"/>
    <rect x="-72" y="-120" width="34" height="22" rx="4" fill="#15180f"/>
    <rect x="38" y="-120" width="34" height="22" rx="4" fill="#15180f"/>
    <rect x="-20" y="-262" width="40" height="18" rx="4" fill="#c8201e"/>
    <path d="M-150 150 q-50 10 -70 40 M150 150 q50 10 70 40" stroke="#262c1b" stroke-width="20" fill="none" stroke-linecap="round"/>
  </g>`),
  'cp-2290': studio(`
  <defs>
    <linearGradient id="can" x1="0" x2="1"><stop offset="0" stop-color="#2d3a48"/><stop offset="0.4" stop-color="#4e6275"/><stop offset="1" stop-color="#1f2933"/></linearGradient>
    <linearGradient id="steel" x1="0" x2="1"><stop offset="0" stop-color="#8d9398"/><stop offset="0.45" stop-color="#e4e7e9"/><stop offset="1" stop-color="#7c8287"/></linearGradient>
  </defs>
  <ellipse cx="400" cy="470" rx="150" ry="38" fill="#1b232b"/>
  <rect x="250" y="330" width="300" height="140" fill="url(#can)"/>
  <ellipse cx="400" cy="330" rx="150" ry="38" fill="#56697c"/>
  <rect x="250" y="370" width="300" height="46" fill="#d9772b" opacity="0.9"/>
  <path d="M250 370 h300 M250 416 h300" stroke="#b25d1d" stroke-width="3"/>
  <rect x="372" y="250" width="56" height="84" fill="url(#steel)"/>
  <path d="M428 290 q80 -10 90 30" stroke="#b9bec2" stroke-width="7" fill="none" stroke-linecap="round"/>
  <circle cx="520" cy="322" r="14" fill="#c8201e"/>
  <ellipse cx="400" cy="246" rx="70" ry="18" fill="url(#steel)"/>
  <ellipse cx="400" cy="240" rx="52" ry="11" fill="#3b4148"/>
  <g stroke="#d9772b" stroke-width="12" stroke-linecap="round" fill="none">
    <path d="M400 238 L250 214 L236 186"/>
    <path d="M400 238 L548 214 L562 186"/>
    <path d="M400 238 L400 196 L400 170"/>
  </g>
  <g fill="#b25d1d"><circle cx="236" cy="186" r="7"/><circle cx="562" cy="186" r="7"/><circle cx="400" cy="170" r="7"/></g>`),
  'ml-1174': studio(`
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff3c4"/><stop offset="0.45" stop-color="#ffc861"/><stop offset="1" stop-color="#f08a24"/></radialGradient>
    <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffcc66" stop-opacity="0.55"/><stop offset="1" stop-color="#ffcc66" stop-opacity="0"/></radialGradient>
  </defs>
  <circle cx="400" cy="300" r="230" fill="url(#halo)"/>
  <path d="M340 150 q60 -90 120 0" stroke="#2b3036" stroke-width="12" fill="none" stroke-linecap="round"/>
  <rect x="318" y="150" width="164" height="44" rx="14" fill="#2f353b"/>
  <rect x="318" y="150" width="164" height="44" rx="14" fill="url(#sheen)"/>
  <rect x="330" y="194" width="140" height="190" rx="46" fill="url(#glow)"/>
  <path d="M345 214 v150 M455 214 v150" stroke="#fff" stroke-opacity="0.35" stroke-width="6"/>
  <rect x="304" y="384" width="192" height="96" rx="22" fill="#2f353b"/>
  <rect x="304" y="384" width="192" height="96" rx="22" fill="url(#sheen)"/>
  <circle cx="400" cy="432" r="18" fill="#454c53"/><circle cx="400" cy="432" r="7" fill="#ffc861"/>`),
  'sm-5417': studio(`
  <defs><linearGradient id="rub" x1="0" x2="1"><stop offset="0" stop-color="#2f382c"/><stop offset="0.5" stop-color="#4a5745"/><stop offset="1" stop-color="#2a3228"/></linearGradient></defs>
  <path d="M300 90 h150 q10 0 10 12 v240 q0 30 30 44 l120 52 q40 18 40 56 v14 h-380 q-14 0 -14 -16 v-392 q0 -10 14 -10z" fill="url(#rub)"/>
  <rect x="286" y="88" width="178" height="30" rx="8" fill="#252c23"/>
  <path d="M300 150 h160" stroke="#252c23" stroke-width="16"/>
  <rect x="440" y="140" width="40" height="22" rx="4" fill="#15180f"/>
  <path d="M286 470 h394 v26 q0 12 -12 12 h-370 q-12 0 -12 -12z" fill="#1b1f19"/>
  <g fill="#1b1f19"><rect x="300" y="500" width="40" height="16" rx="3"/><rect x="360" y="500" width="40" height="16" rx="3"/><rect x="480" y="500" width="40" height="16" rx="3"/><rect x="540" y="500" width="40" height="16" rx="3"/><rect x="600" y="500" width="40" height="16" rx="3"/></g>
  <path d="M320 110 v330" stroke="#fff" stroke-opacity="0.12" stroke-width="18" stroke-linecap="round"/>
  <path d="M470 398 l120 52" stroke="#fff" stroke-opacity="0.10" stroke-width="10" stroke-linecap="round"/>`, 520, 240),
  'rg-7726': studio(`
  <defs><linearGradient id="fly" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7d8d62"/><stop offset="1" stop-color="#4f5c3c"/></linearGradient></defs>
  <g fill="#b9b4a7" opacity="0.9">${Array.from({ length: 160 }, (_, i) => `<circle cx="${(i * 97) % 800}" cy="${470 + ((i * 53) % 130)}" r="${2 + (i % 4)}"/>`).join('')}</g>
  <path d="M130 470 Q400 70 670 470z" fill="url(#fly)"/>
  <path d="M130 470 Q400 70 670 470" stroke="#39432b" stroke-width="6" fill="none"/>
  <path d="M190 470 Q360 150 610 300" stroke="#e7e2cf" stroke-width="5" fill="none" opacity="0.8"/>
  <path d="M210 330 Q430 150 640 440" stroke="#e7e2cf" stroke-width="5" fill="none" opacity="0.8"/>
  <path d="M320 470 Q400 250 480 470z" fill="#3a452c"/>
  <path d="M400 290 v180" stroke="#c8201e" stroke-width="4"/>
  <path d="M130 470 L60 520 M670 470 L740 520 M250 300 L110 470 M560 300 L700 470" stroke="#d8d2bd" stroke-width="2"/>`, 520, 330),
  'pt-3049': studio(`
  <defs>
    <linearGradient id="down" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9aa9bb"/><stop offset="1" stop-color="#6d7d91"/></linearGradient>
    <linearGradient id="roll" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5f6f84"/><stop offset="0.45" stop-color="#a7b5c6"/><stop offset="1" stop-color="#55647a"/></linearGradient>
  </defs>
  <path d="M250 380 L700 330 Q730 400 690 470 L250 490z" fill="url(#down)"/>
  <g stroke="#56657a" stroke-width="4" fill="none" opacity="0.7">
    <path d="M330 372 Q350 430 330 482"/><path d="M420 362 Q440 420 420 478"/><path d="M510 352 Q530 410 510 474"/><path d="M600 342 Q620 400 600 470"/>
  </g>
  <rect x="120" y="360" width="190" height="150" rx="75" fill="url(#roll)"/>
  <ellipse cx="200" cy="435" rx="48" ry="74" fill="#7e8da2"/>
  <path d="M200 380 a36 55 0 1 0 1 0" stroke="#4d5b6f" stroke-width="5" fill="none"/>
  <path d="M170 360 v150 M240 360 v150" stroke="#2c333d" stroke-width="10"/>
  <circle cx="690" cy="400" r="8" fill="#c8201e"/>`, 510, 300),
  'qs-5761': studio(`
  <defs><linearGradient id="cart" x1="0" x2="1"><stop offset="0" stop-color="#c9ced3"/><stop offset="0.5" stop-color="#ffffff"/><stop offset="1" stop-color="#b3b9bf"/></linearGradient></defs>
  <path d="M470 300 C620 300 660 440 520 460 C380 480 300 420 250 470" stroke="#8fc3de" stroke-width="18" fill="none" opacity="0.85" stroke-linecap="round"/>
  <path d="M470 300 C620 300 660 440 520 460 C380 480 300 420 250 470" stroke="#fff" stroke-width="5" fill="none" opacity="0.6" stroke-linecap="round"/>
  <rect x="300" y="170" width="170" height="250" rx="34" fill="url(#cart)"/>
  <rect x="300" y="250" width="170" height="70" fill="#2b77a6"/>
  <text x="385" y="296" font-family="sans-serif" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">0.1</text>
  <rect x="345" y="130" width="80" height="44" rx="10" fill="#2b77a6"/>
  <rect x="345" y="416" width="80" height="44" rx="10" fill="#2b77a6"/>
  <rect x="560" y="170" width="46" height="170" rx="10" fill="#e9ecee" stroke="#aab1b7" stroke-width="3"/>
  <rect x="576" y="120" width="14" height="60" fill="#aab1b7"/>
  <rect x="562" y="112" width="42" height="12" rx="4" fill="#2b77a6"/>`),
  'ag-2673': studio(`
  <defs><linearGradient id="alu" x1="0" x2="1"><stop offset="0" stop-color="#5d666f"/><stop offset="0.5" stop-color="#c9d0d6"/><stop offset="1" stop-color="#4d555d"/></linearGradient></defs>
  ${[[-8, 330], [8, 450]].map(([rot, x]) => `
  <g transform="translate(${x} 262) rotate(${rot})">
    <rect x="-14" y="-40" width="28" height="300" fill="url(#alu)"/>
    <rect x="-3" y="260" width="6" height="40" fill="#2b3036"/>
    <ellipse cx="0" cy="250" rx="36" ry="9" fill="#2b3036"/>
    <rect x="-20" y="60" width="40" height="20" rx="4" fill="#c8201e"/>
    <rect x="-20" y="150" width="40" height="20" rx="4" fill="#c8201e"/>
    <rect x="-22" y="-210" width="44" height="170" rx="20" fill="#b48755"/>
    <path d="M-22 -150 h44 M-22 -110 h44" stroke="#8d6538" stroke-width="3"/>
    <rect x="-24" y="-230" width="48" height="30" rx="10" fill="#2b3036"/>
    <path d="M-18 -225 q-50 40 -20 110" stroke="#2b3036" stroke-width="8" fill="none"/>
  </g>`).join('')}`, 520, 180),
  'wn-1806': studio(`
  <defs><linearGradient id="bag" x1="0" x2="1"><stop offset="0" stop-color="#1f5673"/><stop offset="0.45" stop-color="#3a89b0"/><stop offset="1" stop-color="#1b4a63"/></linearGradient></defs>
  <path d="M290 200 h220 q20 90 30 180 q6 70 -40 90 h-200 q-46 -20 -40 -90 q10 -90 30 -180z" fill="url(#bag)"/>
  <rect x="270" y="130" width="260" height="80" rx="30" fill="#1b4a63"/>
  <path d="M280 150 h240 M280 172 h240 M280 194 h240" stroke="#113447" stroke-width="4"/>
  <rect x="370" y="110" width="60" height="36" rx="8" fill="#15181b"/>
  <path d="M300 146 q100 -70 200 0" stroke="#15181b" stroke-width="10" fill="none"/>
  <circle cx="400" cy="330" r="30" fill="#e9ecee"/><circle cx="400" cy="330" r="14" fill="#9aa3ab"/>
  <path d="M310 250 q-12 120 -2 200" stroke="#fff" stroke-opacity="0.25" stroke-width="14" fill="none" stroke-linecap="round"/>`),
};

const BADGE = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <circle cx="24" cy="24" r="23" fill="#17191b"/>
  <circle cx="24" cy="24" r="19" fill="none" stroke="#c8201e" stroke-width="3"/>
  <path d="M11 32 20 17l5 8 4-5 8 12z" fill="#fff"/>
</svg>`;

const browser = await firefox.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
for (const [name, svg] of Object.entries(PHOTOS)) {
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await page.locator('svg').screenshot({ path: join(OUT, name + '.png') });
  console.log('wrote', name);
}
await page.setViewportSize({ width: 48, height: 48 });
await page.setContent(`<html><body style="margin:0;background:#f2f3f1">${BADGE}</body></html>`);
await page.locator('svg').screenshot({ path: join(OUT, 'badge-trailrated.png') });
await browser.close();
