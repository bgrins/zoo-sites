(() => {
  const table = document.getElementById('scans');
  const tbody = document.getElementById('scanRows');
  const menu = document.getElementById('ctxMenu');
  const moreBtn = document.getElementById('moreBtn');
  const selectAll = document.getElementById('selectAll');
  const dialog = document.getElementById('labelDialog');
  const labelPick = document.getElementById('labelPick');
  const labelApply = document.getElementById('labelApply');
  const labelErr = document.getElementById('labelErr');

  let files = [];
  let jobs = [];
  let order = [];
  const rowOf = new Map();
  const selected = new Set();
  let anchor = null;
  let cursor = null;
  let sort = { key: 'name', dir: 1 };
  let query = '';
  let menuVia = null;
  let menuFrom = null;
  let dialogVia = null;
  // How the current selection was built and which menu opened the action, sent
  // with each label job so the workspace can report which entry points get used.
  // A menu names itself only while it is open, and the label dialog keeps the
  // menu that opened it only until it closes.
  let gestures = freshGestures();

  function freshGestures() {
    return { click: 0, shift: 0, toggle: 0, box: 0, keys: 0, all: 0 };
  }

  const fileOf = (id) => files.find((f) => f.id === id);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  const UNITS = { KB: 1, MB: 1024 };
  const SORTERS = {
    name: (f) => f.name.toLowerCase(),
    batch: (f) => f.batch,
    pages: (f) => f.pages,
    size: (f) => {
      const m = /([\d.]+)\s*(KB|MB)/.exec(f.size);
      return m ? Number(m[1]) * UNITS[m[2]] : 0;
    },
    scanned: (f) => f.seq,
    label: (f) => f.label ?? '\uffff',
  };

  function compare(a, b) {
    const key = SORTERS[sort.key] ?? SORTERS.name;
    const x = key(a);
    const y = key(b);
    if (x < y) return -sort.dir;
    if (x > y) return sort.dir;
    return a.seq - b.seq;
  }

  function loadFailed(message) {
    const loading = document.getElementById('loading');
    loading.className = 'loaderr';
    loading.textContent = message + ' ';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'rowbtn';
    retry.textContent = 'Retry';
    retry.addEventListener('click', load);
    loading.appendChild(retry);
    loading.style.display = 'block';
    table.style.display = 'none';
    document.getElementById('count').textContent = 'Scans unavailable';
  }

  async function load() {
    const loading = document.getElementById('loading');
    loading.className = '';
    loading.textContent = 'Loading scans…';
    loading.style.display = 'block';
    let res;
    try {
      res = await fetch('/api/filemgr/scans', { headers: { 'X-Session-Nonce': NONCE } });
    } catch {
      loadFailed('Could not reach the workspace server. Check your connection.');
      return;
    }
    if (res.status === 401 || res.status === 403) {
      loadFailed('Could not load Scans: your session has expired. Reload the page to sign in again.');
      return;
    }
    if (!res.ok) {
      loadFailed('Could not load Scans (server error ' + res.status + ').');
      return;
    }
    let body;
    try {
      body = await res.json();
    } catch {
      loadFailed('The workspace server sent an unreadable file list.');
      return;
    }
    files = (body.files ?? []).map((f, seq) => ({ ...f, seq }));
    jobs = body.jobs ?? [];
    loading.style.display = 'none';
    render();
    renderHistory();
  }

  function tagFor(label) {
    const tag = document.createElement('span');
    tag.className = label ? 'rlabel' : 'rlabel none';
    tag.textContent = label ?? '—';
    return tag;
  }

  function render() {
    const shown = files.filter((f) => !query || f.name.toLowerCase().includes(query)).sort(compare);
    order = shown.map((f) => f.id);
    for (const id of [...selected]) if (!order.includes(id)) selected.delete(id);
    if (!order.includes(anchor)) anchor = null;
    if (!order.includes(cursor)) cursor = order[0] ?? null;
    tbody.textContent = '';
    rowOf.clear();
    for (const f of shown) {
      const tr = document.createElement('tr');
      tr.dataset.id = f.id;
      tr.tabIndex = -1;
      const check = document.createElement('td');
      check.className = 'check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.tabIndex = -1;
      box.setAttribute('aria-label', 'Select ' + f.name);
      check.appendChild(box);
      tr.appendChild(check);
      for (const [cls, text] of [
        ['name', f.name],
        ['batch', f.batch],
        ['pages', String(f.pages)],
        ['size', f.size],
        ['mod', f.scanned],
      ]) {
        const td = document.createElement('td');
        td.className = cls;
        td.textContent = text;
        tr.appendChild(td);
      }
      const labelCell = document.createElement('td');
      labelCell.className = 'label';
      labelCell.appendChild(tagFor(f.label));
      tr.appendChild(labelCell);
      tbody.appendChild(tr);
      rowOf.set(f.id, tr);
    }
    table.style.display = shown.length ? 'table' : 'none';
    document.getElementById('empty').style.display = shown.length ? 'none' : 'block';
    for (const th of table.querySelectorAll('th[data-key]')) {
      if (th.dataset.key === sort.key) th.setAttribute('aria-sort', sort.dir === 1 ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    }
    paint();
  }

  // Selection changes repaint the existing rows in place, so a row keeps its
  // element (and whatever holds a reference to it) until the list itself changes.
  function paint() {
    for (const [id, tr] of rowOf) {
      const on = selected.has(id);
      tr.classList.toggle('selected', on);
      tr.setAttribute('aria-selected', String(on));
      tr.tabIndex = id === cursor ? 0 : -1;
      tr.querySelector('input').checked = on;
    }
    const n = selected.size;
    selectAll.checked = n > 0 && n === order.length;
    selectAll.indeterminate = n > 0 && n < order.length;
    const sel = document.getElementById('selCount');
    sel.textContent = n ? plural(n, 'file', 'files') + ' selected' : 'No files selected';
    sel.classList.toggle('some', n > 0);
    let status = plural(files.length, 'scan', 'scans');
    if (query) status += ' · ' + order.length + ' match';
    if (n) status += ' · ' + n + ' selected';
    document.getElementById('count').textContent = status;
  }

  function only(id) {
    selected.clear();
    selected.add(id);
    anchor = id;
  }

  function toggle(id) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    anchor = id;
  }

  // Shift extends from the anchor, the last row clicked or toggled without
  // Shift, and replaces the selection unless Ctrl, Cmd or a checkbox keeps it.
  function extend(id, keep) {
    const to = order.indexOf(id);
    const from = anchor === null ? to : order.indexOf(anchor);
    if (!keep) selected.clear();
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) selected.add(order[i]);
    if (anchor === null) anchor = id;
  }

  function selectEvery() {
    for (const id of order) selected.add(id);
  }

  tbody.addEventListener('click', (event) => {
    const tr = event.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    const box = Boolean(event.target.closest('input[type="checkbox"]'));
    const mod = event.ctrlKey || event.metaKey;
    if (event.shiftKey) {
      extend(id, box || mod);
      gestures.shift += 1;
    } else if (box) {
      toggle(id);
      gestures.box += 1;
    } else if (mod) {
      toggle(id);
      gestures.toggle += 1;
    } else {
      only(id);
      gestures.click += 1;
    }
    cursor = id;
    paint();
    if (!box) tr.focus({ preventScroll: true });
  });

  tbody.addEventListener('focusin', (event) => {
    const tr = event.target.closest('tr[data-id]');
    if (!tr || tr.dataset.id === cursor) return;
    cursor = tr.dataset.id;
    for (const [id, row] of rowOf) row.tabIndex = id === cursor ? 0 : -1;
  });

  selectAll.addEventListener('click', () => {
    if (selected.size === order.length) selected.clear();
    else selectEvery();
    gestures.all += 1;
    paint();
  });

  for (const th of table.querySelectorAll('th[data-key]')) {
    th.tabIndex = 0;
    th.classList.add('sortable');
    th.title = 'Sort by ' + th.textContent.trim().toLowerCase();
    const activate = () => {
      sort = { key: th.dataset.key, dir: sort.key === th.dataset.key ? -sort.dir : 1 };
      render();
    };
    th.addEventListener('click', activate);
    th.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
  }

  table.addEventListener('keydown', (event) => {
    if (event.target.closest('thead') && event.target !== selectAll) return;
    const key = event.key;
    const mod = event.ctrlKey || event.metaKey;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
      if (!order.length) return;
      event.preventDefault();
      const at = order.indexOf(cursor);
      let next;
      if (key === 'Home') next = 0;
      else if (key === 'End') next = order.length - 1;
      else if (at === -1) next = 0;
      else next = at + (key === 'ArrowDown' ? 1 : -1);
      const id = order[Math.max(0, Math.min(order.length - 1, next))];
      if (event.shiftKey) extend(id, mod);
      else if (!mod) only(id);
      cursor = id;
      gestures.keys += 1;
      paint();
      const tr = rowOf.get(id);
      tr.focus({ preventScroll: true });
      tr.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (key === ' ' && !event.target.matches('input')) {
      event.preventDefault();
      if (!cursor) return;
      toggle(cursor);
      gestures.keys += 1;
      paint();
      return;
    }
    if (mod && key.toLowerCase() === 'a') {
      event.preventDefault();
      selectEvery();
      gestures.all += 1;
      paint();
      return;
    }
    if ((key === 'F10' && event.shiftKey) || key === 'ContextMenu') {
      event.preventDefault();
      const tr = rowOf.get(cursor);
      if (!tr) return;
      if (!selected.size) {
        only(cursor);
        paint();
      }
      tr.scrollIntoView({ block: 'nearest' });
      const box = tr.getBoundingClientRect();
      openMenu('keyboard', box.left + 64, box.bottom, box.top, tr);
      return;
    }
    if (key === 'Escape' && selected.size) {
      selected.clear();
      paint();
    }
  });

  // Right-click acts on the selection when the row is part of it, and on that
  // row alone when it is not, as desktop file managers do.
  tbody.addEventListener('contextmenu', (event) => {
    const tr = event.target.closest('tr[data-id]');
    if (!tr) return;
    event.preventDefault();
    const id = tr.dataset.id;
    if (!selected.has(id)) {
      only(id);
      gestures.click += 1;
    }
    cursor = id;
    paint();
    const box = tr.getBoundingClientRect();
    if (event.clientX === 0 && event.clientY === 0) openMenu('context', box.left + 64, box.bottom, box.top, tr);
    else openMenu('context', event.clientX, event.clientY, event.clientY, tr);
  });

  const menuOpen = () => menu.matches(':popover-open');

  function menuItems(via) {
    const n = selected.size;
    const labelled = [...selected].some((id) => fileOf(id)?.label);
    const none = n ? null : 'Select one or more files first';
    const items = [
      { label: 'Apply label…', run: openDialog, off: none },
      {
        label: 'Remove label',
        run: removeLabel,
        off: none ?? (labelled ? null : 'None of the selected files has a label'),
      },
      { rule: true },
    ];
    if (via === 'toolbar') {
      items.push(
        {
          label: 'Select all',
          keys: 'Ctrl A',
          run: () => {
            selectEvery();
            gestures.all += 1;
            paint();
          },
        },
        {
          label: 'Clear selection',
          off: n ? null : 'Nothing is selected',
          run: () => {
            selected.clear();
            paint();
          },
        }
      );
    } else {
      items.push(
        { label: 'Download', off: 'Downloads are turned off for the Scans folder' },
        { label: 'Move to…', off: 'Your workspace role cannot move items here' },
        { label: 'Move to Trash', off: 'Your workspace role cannot remove items here' }
      );
    }
    return items;
  }

  function focusItem(index) {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    if (!items.length) return;
    const at = (index + items.length) % items.length;
    items.forEach((b, i) => (b.tabIndex = i === at ? 0 : -1));
    items[at].focus();
  }

  // The menu opens below `below`, or ends at `above` when there is no room
  // underneath, so it never covers the row it was opened for.
  function openMenu(via, x, below, above, from) {
    menu.textContent = '';
    const head = document.createElement('div');
    head.className = 'mhead';
    head.textContent = selected.size ? plural(selected.size, 'file', 'files') + ' selected' : 'Nothing selected';
    menu.appendChild(head);
    for (const item of menuItems(via)) {
      if (item.rule) {
        menu.appendChild(document.createElement('hr'));
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      b.textContent = item.label;
      if (item.keys) {
        const k = document.createElement('kbd');
        k.textContent = item.keys;
        b.appendChild(k);
      }
      if (item.off) {
        b.setAttribute('aria-disabled', 'true');
        b.title = item.off;
      }
      b.addEventListener('click', () => {
        if (item.off) return;
        const from = menuVia;
        closeMenu(false);
        item.run(from);
      });
      menu.appendChild(b);
    }
    menuVia = via;
    menuFrom = from;
    if (!menuOpen()) menu.showPopover();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    const room = window.innerHeight - 8;
    const top = below + h <= room ? below : above - h >= 8 ? above - h : Math.max(8, room - h);
    menu.style.top = top + 'px';
    moreBtn.setAttribute('aria-expanded', String(via === 'toolbar'));
    focusItem(0);
  }

  function closeMenu(returnFocus) {
    if (menuOpen()) menu.hidePopover();
    menuVia = null;
    moreBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus && menuFrom) menuFrom.focus({ preventScroll: true });
  }

  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem(at + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusItem(event.key === 'Home' ? 0 : items.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === 'Tab') {
      closeMenu(false);
    }
  });

  document.addEventListener(
    'pointerdown',
    (event) => {
      if (menuOpen() && !menu.contains(event.target) && !moreBtn.contains(event.target)) closeMenu(false);
    },
    true
  );
  window.addEventListener('resize', () => closeMenu(false));

  moreBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menuOpen() && menuVia === 'toolbar') {
      closeMenu(false);
      return;
    }
    const box = moreBtn.getBoundingClientRect();
    openMenu('toolbar', box.left, box.bottom + 3, box.top - 3, moreBtn);
  });

  function openDialog(via) {
    if (!selected.size) return;
    dialogVia = via;
    document.getElementById('labelCount').textContent =
      'Applies to ' + plural(selected.size, 'selected file', 'selected files') + '.';
    labelPick.value = '';
    labelErr.textContent = '';
    labelApply.disabled = false;
    dialog.showModal();
    labelPick.focus();
  }

  document.getElementById('labelCancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    dialogVia = null;
    const tr = rowOf.get(cursor);
    if (tr) tr.focus({ preventScroll: true });
  });

  async function send(path, body, via) {
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: NONCE, ...body, via: { menu: via, gestures } }),
      });
    } catch {
      return { ok: false, error: 'Could not reach the workspace server. Nothing was changed.' };
    }
    let reply = {};
    try {
      reply = await res.json();
    } catch {}
    if (!res.ok || !reply.ok) {
      return { ok: false, error: reply.error ?? 'The workspace server declined the change (' + res.status + ').' };
    }
    return reply;
  }

  function selectedIds() {
    return order.filter((id) => selected.has(id));
  }

  labelApply.addEventListener('click', async () => {
    const label = labelPick.value;
    if (!label) {
      labelErr.textContent = 'Choose a label to apply.';
      return;
    }
    labelApply.disabled = true;
    const reply = await send('/api/filemgr/label', { ids: selectedIds(), label }, dialogVia);
    labelApply.disabled = false;
    if (!reply.ok) {
      labelErr.textContent = reply.error;
      return;
    }
    dialog.close();
    finished(reply, label + ' applied to ' + plural(reply.count, 'file', 'files') + '.');
  });

  async function removeLabel(via) {
    const reply = await send('/api/filemgr/label/remove', { ids: selectedIds() }, via);
    if (!reply.ok) {
      note(reply.error, null, true);
      return;
    }
    finished(reply, 'Label removed from ' + plural(reply.count, 'file', 'files') + '.');
  }

  function finished(reply, message) {
    const labels = new Map(reply.files.map((f) => [f.id, f.label]));
    for (const f of files) {
      if (!labels.has(f.id)) continue;
      f.label = labels.get(f.id);
      const cell = rowOf.get(f.id)?.querySelector('td.label');
      if (cell) cell.replaceChildren(tagFor(f.label));
    }
    jobs = reply.jobs ?? jobs;
    gestures = freshGestures();
    note(message, reply.receipt, false);
    renderHistory();
  }

  function note(message, receipt, error) {
    const box = document.getElementById('jobNote');
    document.getElementById('jobMsg').textContent = message;
    const ref = document.getElementById('jobRef');
    ref.textContent = '';
    if (receipt) {
      ref.append('Receipt ');
      const b = document.createElement('b');
      b.className = 'receipt';
      b.textContent = receipt;
      ref.appendChild(b);
    }
    box.classList.toggle('err', error);
    box.classList.add('show');
  }

  document.getElementById('jobClose').addEventListener('click', () => {
    document.getElementById('jobNote').classList.remove('show');
  });

  function renderHistory() {
    const section = document.getElementById('history');
    const list = document.getElementById('historyList');
    list.textContent = '';
    for (const job of [...jobs].reverse()) {
      const li = document.createElement('li');
      const ref = document.createElement('span');
      ref.className = 'receipt';
      ref.textContent = job.receipt;
      li.appendChild(ref);
      li.append(
        job.action === 'remove'
          ? 'Label removed from ' + plural(job.count, 'file', 'files')
          : job.label + ' applied to ' + plural(job.count, 'file', 'files')
      );
      list.appendChild(li);
    }
    section.hidden = jobs.length === 0;
  }

  document.getElementById('search').addEventListener('input', (event) => {
    query = event.target.value.trim().toLowerCase();
    render();
  });

  load();
})();
