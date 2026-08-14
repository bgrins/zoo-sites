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
    popnote(anchor, 'Search cleared.');
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
      { label: 'Working files', href: '/filemgr/' },
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
        [{ label: 'Marketing team', reason: 'You are already in this workspace' }],
        'Your account belongs to one workspace. Workspace owners can add more.'
      );
    });
  }

  const invite = document.querySelector('.invite');
  if (invite) {
    invite.addEventListener('click', () => {
      popnote(invite, 'Only the workspace owner can invite members on the Team plan. Ask o.brandt@boxelder.example.');
    });
  }

  document.addEventListener('click', (event) => {
    if (openMenu && !openMenu.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  // Static folder listings filter locally; the Working files list has its own
  // server-backed renderer.
  if (document.body.dataset.staticList === 'true') {
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
})();
