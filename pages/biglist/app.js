const NONCE = window.NONCE;
const TOTAL = 5000;
const CHUNK = 250;
const ROW_H = 40;
const OVERSCAN = 4;
const MAX_FILTER_HITS = 50;
const AVATAR_TINTS = [
  ['#f3e3f7', '#634074'],
  ['#e2ecf9', '#2f5580'],
  ['#e6f2e8', '#3a6b48'],
  ['#fbeada', '#8a5320'],
  ['#f7e6e6', '#8c3f42'],
  ['#e9e8f6', '#484490'],
];

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const statusEl = document.getElementById('status');
const filterInput = document.getElementById('filter');
const filterResults = document.getElementById('filter-results');

const chunks = new Map();
const inflight = new Map();

spacer.style.height = TOTAL * ROW_H + 'px';

function loadedCount() {
  let n = 0;
  for (const rows of chunks.values()) {
    n += rows.length;
  }
  return n;
}

function updateStatus() {
  statusEl.textContent =
    loadedCount().toLocaleString() + ' / ' + TOTAL.toLocaleString() + ' streamed';
}

function fetchChunk(c) {
  if (chunks.has(c)) {
    return Promise.resolve(chunks.get(c));
  }
  if (inflight.has(c)) {
    return inflight.get(c);
  }
  const p = fetch('/api/biglist/rows?offset=' + c * CHUNK + '&limit=' + CHUNK, {
    headers: { 'X-Session-Nonce': NONCE },
  })
    .then((res) => {
      if (!res.ok) {
        throw new Error('directory service error ' + res.status);
      }
      return res.json();
    })
    .then((body) => {
      inflight.delete(c);
      chunks.set(c, body.rows);
      updateStatus();
      render();
      if (filterInput.value.trim()) {
        runFilter();
      }
      return body.rows;
    })
    .catch((err) => {
      inflight.delete(c);
      statusEl.textContent = 'Failed to load rows — scroll to retry.';
      throw err;
    });
  inflight.set(c, p);
  return p;
}

function rowAt(i) {
  const c = Math.floor(i / CHUNK);
  const rows = chunks.get(c);
  if (!rows) {
    fetchChunk(c).catch(() => {});
    return null;
  }
  return rows[i - c * CHUNK];
}

function makeCell(cls, text) {
  const span = document.createElement('span');
  if (cls) {
    span.className = cls;
  }
  span.textContent = text;
  return span;
}

function initials(name) {
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0] ?? '').charAt(0) + (parts.at(-1) ?? '').charAt(0)).toUpperCase();
}

// The avatar chip is drawn by CSS from these attributes, so a row still holds
// exactly four child cells in the virtualized list.
function dressAvatar(div, name) {
  let sum = 0;
  for (let i = 0; i < name.length; i++) {
    sum = (sum + name.charCodeAt(i) * (i + 1)) % 4093;
  }
  const [bg, fg] = AVATAR_TINTS[sum % AVATAR_TINTS.length];
  div.dataset.initials = initials(name);
  div.style.setProperty('--av-bg', bg);
  div.style.setProperty('--av-fg', fg);
}

function render() {
  const top = viewport.scrollTop;
  const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const last = Math.min(
    TOTAL - 1,
    Math.ceil((top + viewport.clientHeight) / ROW_H) + OVERSCAN
  );
  rowsEl.textContent = '';
  for (let i = first; i <= last; i++) {
    const div = document.createElement('div');
    div.className = 'row';
    div.style.top = i * ROW_H + 'px';
    const r = rowAt(i);
    if (r) {
      dressAvatar(div, r.name);
      div.append(
        makeCell('name', r.name),
        makeCell('badge', r.badge),
        makeCell('dept', r.dept),
        makeCell('floor', String(r.floor))
      );
    } else {
      div.classList.add('pending');
      div.textContent = 'Streaming batch ' + (Math.floor(i / CHUNK) + 1) + '…';
    }
    rowsEl.appendChild(div);
  }
}

function runFilter() {
  const q = filterInput.value.trim().toLowerCase();
  if (!q) {
    filterResults.hidden = true;
    filterResults.textContent = '';
    return;
  }
  const hits = [];
  const sorted = [...chunks.keys()].sort((a, b) => a - b);
  outer: for (const c of sorted) {
    for (const r of chunks.get(c)) {
      const hay = (r.badge + ' ' + r.name + ' ' + r.dept).toLowerCase();
      if (hay.includes(q)) {
        hits.push(r);
        if (hits.length >= MAX_FILTER_HITS) {
          break outer;
        }
      }
    }
  }
  filterResults.textContent = '';
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.textContent =
    'Matches in the ' + loadedCount().toLocaleString() + ' rows streamed so far';
  filterResults.appendChild(cap);
  if (!hits.length) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent =
      'No matches among the ' +
      loadedCount().toLocaleString() +
      ' streamed rows. Rows not yet streamed are not searched.';
    filterResults.appendChild(none);
  }
  for (const r of hits) {
    const div = document.createElement('div');
    div.className = 'hit';
    div.textContent = r.badge + ' — ' + r.name + ' — ' + r.dept + ' — Floor ' + r.floor;
    filterResults.appendChild(div);
  }
  filterResults.hidden = false;
}

viewport.addEventListener('scroll', render);
filterInput.addEventListener('input', runFilter);

updateStatus();
render();
