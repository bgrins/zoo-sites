(() => {
  let openMenu = null;
  let openedBy = null;

  function closeMenu() {
    if (openMenu) openMenu.remove();
    if (openedBy) openedBy.setAttribute('aria-expanded', 'false');
    openMenu = null;
    openedBy = null;
  }

  function popnote(anchor, message) {
    const note = document.createElement('div');
    note.className = 'popnote';
    note.setAttribute('role', 'status');
    note.textContent = message;
    document.body.appendChild(note);
    const rect = anchor.getBoundingClientRect();
    note.style.top = rect.bottom + window.scrollY + 6 + 'px';
    note.style.left = Math.max(8, rect.left + window.scrollX) + 'px';
    setTimeout(() => note.remove(), 4000);
  }

  function copyPageLink(anchor) {
    const link = location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(link)
        .then(() => popnote(anchor, 'Link copied: ' + link))
        .catch(() => popnote(anchor, 'Copy by hand: ' + link));
    } else {
      popnote(anchor, 'Copy by hand: ' + link);
    }
  }

  function clearSearch(anchor) {
    const box = document.getElementById('search');
    if (!box) return;
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    if (anchor) popnote(anchor, 'Search cleared.');
  }

  const hasSearch = Boolean(document.getElementById('search'));

  const MENUS = {
    File: [
      { label: 'New folder', reason: 'Your workspace role cannot create folders here' },
      { label: 'Upload files', reason: 'Your workspace role cannot upload here' },
      { rule: true },
      { label: 'Manage storage', href: 'storage.html' },
    ],
    Edit: [
      { label: 'Copy link to this page', run: copyPageLink },
      hasSearch
        ? { label: 'Clear search', run: clearSearch }
        : { label: 'Clear search', reason: 'There is no search box on this page' },
    ],
    View: [
      { label: 'List', reason: 'Already in list view' },
      { label: 'Grid', reason: 'Grid view is unavailable on shared drives' },
    ],
    Go: [
      { label: 'Working files', href: './' },
      { label: 'Brand assets', href: 'brand-assets.html' },
      { label: 'Campaign 26', href: 'campaign-26.html' },
      { label: 'Archive folder', href: 'archive.html' },
      { rule: true },
      { label: 'My files', href: 'my-files.html' },
      { label: 'Recent', href: 'recent.html' },
      { label: 'Trash', href: 'trash.html' },
    ],
    Share: [
      { label: 'Copy share link', run: copyPageLink },
      { label: 'Invite people', reason: 'Only the workspace owner can invite members' },
    ],
    Help: [
      { label: 'Help centre', href: 'help.html' },
      { label: 'Keyboard shortcuts', href: 'shortcuts.html' },
      { label: 'Service status', href: 'status.html' },
      { label: 'Contact support', href: 'contact.html' },
    ],
  };

  function buildMenu(items, note) {
    const menu = document.createElement('div');
    menu.className = 'appmenu';
    menu.setAttribute('role', 'menu');
    for (const item of items) {
      if (item.rule) {
        menu.appendChild(document.createElement('hr'));
        continue;
      }
      if (item.href) {
        const a = document.createElement('a');
        a.href = item.href;
        a.textContent = item.label;
        a.setAttribute('role', 'menuitem');
        menu.appendChild(a);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = item.label;
      b.setAttribute('role', 'menuitem');
      if (item.reason) {
        b.disabled = true;
        b.title = item.reason;
      } else {
        b.addEventListener('click', () => {
          const by = openedBy;
          closeMenu();
          item.run(by);
        });
      }
      menu.appendChild(b);
    }
    if (note) {
      const p = document.createElement('p');
      p.className = 'mnote';
      p.textContent = note;
      menu.appendChild(p);
    }
    return menu;
  }

  function showMenuFor(button, items, note) {
    if (openedBy === button) {
      closeMenu();
      return;
    }
    closeMenu();
    const menu = buildMenu(items, note);
    document.body.appendChild(menu);
    const rect = button.getBoundingClientRect();
    menu.style.top = rect.bottom + window.scrollY + 3 + 'px';
    menu.style.left = rect.left + window.scrollX + 'px';
    button.setAttribute('aria-expanded', 'true');
    openMenu = menu;
    openedBy = button;
  }

  for (const button of document.querySelectorAll('.menubar button')) {
    const items = MENUS[button.textContent.trim()];
    if (!items) continue;
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      showMenuFor(button, items);
    });
  }

  const workspace = document.querySelector('.workspace');
  if (workspace) {
    workspace.setAttribute('aria-haspopup', 'menu');
    workspace.setAttribute('aria-expanded', 'false');
    workspace.addEventListener('click', (event) => {
      event.stopPropagation();
      showMenuFor(
        workspace,
        [
          { label: 'Marketing team', reason: 'You are already in this workspace' },
          { rule: true },
          { label: 'Members', href: 'members.html' },
          { label: 'Plan and billing', href: 'billing.html' },
          { label: 'Storage', href: 'storage.html' },
        ],
        'Marketing team belongs to Tolvenhart. Your account is a member of this one workspace.'
      );
    });
  }

  const invite = document.querySelector('.invite');
  if (invite) {
    invite.addEventListener('click', () => {
      popnote(invite, 'Only the workspace owner can invite members on the Team plan. Ask o.brandt@tolvenhart.example.');
    });
  }

  document.addEventListener('click', (event) => {
    if (openMenu && !openMenu.contains(event.target)) closeMenu();
  });

  const tbody = document.getElementById('rows');
  const table = document.getElementById('files');
  const isStatic = document.body.dataset.staticList === 'true';

  // Static folder listings filter locally; the Working files list has its own
  // server-backed renderer.
  if (isStatic) {
    const box = document.getElementById('search');
    const rows = [...document.querySelectorAll('#rows tr')];
    const count = document.getElementById('count');
    const base = count ? count.textContent : '';
    if (box) {
      box.addEventListener('input', () => {
        const q = box.value.trim().toLowerCase();
        let shown = 0;
        for (const tr of rows) {
          const hit = !q || tr.textContent.toLowerCase().includes(q);
          tr.style.display = hit ? '' : 'none';
          if (hit) shown += 1;
        }
        const empty = document.getElementById('empty');
        if (empty) empty.style.display = shown ? 'none' : 'block';
        if (count) count.textContent = q ? shown + ' of ' + rows.length + ' items match' : base;
      });
    }
  }

  const COLUMNS = ['name', 'kind', 'size', 'modified'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const UNITS = { KB: 1, MB: 1024, GB: 1024 * 1024 };
  const cellKey = (key, text) => {
    if (key === 'size') {
      const m = /([\d.]+)\s*(KB|MB|GB)/.exec(text);
      return m ? Number(m[1]) * UNITS[m[2]] : 0;
    }
    if (key === 'modified') {
      const [d, mon, y] = text.split(' ');
      return Number(y) * 10000 + MONTHS.indexOf(mon) * 100 + Number(d);
    }
    return text.toLowerCase();
  };

  if (table && tbody) {
    const heads = [...table.querySelectorAll('thead th')].slice(0, COLUMNS.length);
    heads.forEach((th, i) => {
      th.tabIndex = 0;
      th.classList.add('sortable');
      th.title = 'Sort by ' + th.textContent.trim().toLowerCase();
      const activate = () => {
        const dir = th.getAttribute('aria-sort') === 'ascending' ? -1 : 1;
        for (const other of heads) other.removeAttribute('aria-sort');
        th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
        const key = COLUMNS[i];
        if (isStatic) {
          const rows = [...tbody.rows];
          rows.sort((a, b) => {
            const x = cellKey(key, a.cells[i].textContent.trim());
            const y = cellKey(key, b.cells[i].textContent.trim());
            return (x < y ? -1 : x > y ? 1 : 0) * dir;
          });
          for (const tr of rows) tbody.appendChild(tr);
        } else {
          document.dispatchEvent(new CustomEvent('boxelder:sort', { detail: { key, dir } }));
        }
      };
      th.addEventListener('click', activate);
      th.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });
    });
  }

  const info = [...document.querySelectorAll('.toolbar .tbtn')].find(
    (b) => b.textContent.trim() === 'Get info'
  );
  const folderPath = [...document.querySelectorAll('.crumbbar span, .crumbbar b')]
    .map((el) => el.textContent.trim())
    .filter((s) => s && s !== '/')
    .join(' / ');
  let selectedKey = null;
  let details = null;

  const keyOf = (tr) => tr.dataset.id ?? tr.querySelector('td.name')?.textContent.trim() ?? '';
  const visibleRows = () => (tbody ? [...tbody.rows].filter((tr) => tr.style.display !== 'none') : []);
  const selectedRow = () => visibleRows().find((tr) => keyOf(tr) === selectedKey) ?? null;

  function paintSelection() {
    if (!tbody) return;
    for (const tr of tbody.rows) {
      const on = selectedKey !== null && keyOf(tr) === selectedKey;
      tr.classList.toggle('selected', on);
      if (on) tr.setAttribute('aria-selected', 'true');
      else tr.removeAttribute('aria-selected');
    }
    const row = selectedRow();
    if (info) {
      info.disabled = !row;
      info.title = row
        ? 'Show details for ' + row.querySelector('td.name').textContent.trim()
        : 'Select a file to see details';
    }
    if (details && !row) closeDetails();
  }

  function select(tr) {
    selectedKey = tr ? keyOf(tr) : null;
    paintSelection();
    if (details && tr) showDetails();
  }

  function closeDetails() {
    if (details) details.remove();
    details = null;
  }

  function showDetails() {
    const row = selectedRow();
    if (!row) return;
    closeDetails();
    const cells = [...row.cells].map((c) => c.textContent.trim());
    const folder = row.querySelector('td.folder')?.textContent.trim();
    const where = folder ? 'Shared drive / Marketing / ' + folder : folderPath || 'My files';
    const shared = where.startsWith('Shared drive');
    details = document.createElement('aside');
    details.className = 'details';
    details.setAttribute('aria-label', 'File details');
    const h = document.createElement('h2');
    h.textContent = cells[0];
    const dl = document.createElement('dl');
    const facts = [
      ['Kind', cells[1]],
      ['Size', cells[2]],
      ['Modified', cells[3]],
      ['Location', where],
      ['Owner', shared ? 'Marketing team' : 'Ada Reinholt'],
      ['Sharing', shared ? 'Everyone in Marketing team' : 'Only you'],
      ['Versions', 'Earlier versions are kept for 90 days after a change'],
    ];
    for (const [k, v] of facts) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'rowbtn';
    close.textContent = 'Close details';
    close.addEventListener('click', closeDetails);
    details.append(h, dl, close);
    document.querySelector('.frame').appendChild(details);
  }

  if (tbody) {
    tbody.addEventListener('click', (event) => {
      const tr = event.target.closest('tr');
      if (!tr || event.target.closest('input')) return;
      select(tr);
    });
    new MutationObserver(paintSelection).observe(tbody, { childList: true });
  }
  if (info) info.addEventListener('click', showDetails);

  function moveSelection(step) {
    const rows = visibleRows();
    if (!rows.length) return;
    const at = rows.findIndex((tr) => keyOf(tr) === selectedKey);
    const next = rows[Math.min(rows.length - 1, Math.max(0, at === -1 ? 0 : at + step))];
    select(next);
    const button = next.querySelector('button');
    if (button) button.focus();
    else next.scrollIntoView({ block: 'nearest' });
  }

  let pendingG = 0;
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (event.key === 'Escape') {
      if (openMenu) {
        closeMenu();
        return;
      }
      if (details) {
        closeDetails();
        return;
      }
      const box = document.getElementById('search');
      if (box && box.value && (target === box || !typing)) clearSearch(null);
      return;
    }
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '/' && hasSearch) {
      event.preventDefault();
      document.getElementById('search').focus();
      return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && tbody) {
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'g') {
      pendingG = Date.now();
      return;
    }
    if (pendingG && Date.now() - pendingG < 1500) {
      pendingG = 0;
      if (key === 'w') location.href = './';
      if (key === 'r') location.href = 'recent.html';
    }
  });
})();
