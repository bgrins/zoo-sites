(() => {
  let open = null;

  function close() {
    if (!open) return;
    open.menu.remove();
    open.button.setAttribute('aria-expanded', 'false');
    open = null;
  }

  function menuFor(button, build) {
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (open && open.button === button) {
        close();
        return;
      }
      close();
      const menu = document.createElement('div');
      menu.className = 'menu';
      menu.setAttribute('role', 'menu');
      build(menu);
      document.body.appendChild(menu);
      const rect = button.getBoundingClientRect();
      const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
      menu.style.top = rect.bottom + window.scrollY + 6 + 'px';
      menu.style.left = Math.max(8, left) + window.scrollX + 'px';
      button.setAttribute('aria-expanded', 'true');
      open = { button, menu };
    });
  }

  function item(menu, label, href) {
    const a = document.createElement('a');
    a.setAttribute('role', 'menuitem');
    a.href = href;
    a.textContent = label;
    menu.appendChild(a);
  }

  function header(menu, strong, rest) {
    const hd = document.createElement('div');
    hd.className = 'hd';
    const b = document.createElement('b');
    b.textContent = strong;
    hd.append(b, rest);
    menu.appendChild(hd);
  }

  const who = document.querySelector('.who');
  if (who) {
    menuFor(who, (menu) => {
      header(menu, 'r.calloway', 'Admin, Skelvane Media');
      item(menu, 'Members and roles', 'members.html');
      item(menu, 'Alert rules', 'alerts.html');
      item(menu, 'Billing', 'billing.html');
      item(menu, 'Sign out', 'signed-out.html');
    });
  }

  const workspace = document.querySelector('.wsw');
  if (workspace) {
    menuFor(workspace, (menu) => {
      header(menu, 'Skelvane Media', 'Current workspace, Scale plan');
      const note = document.createElement('span');
      note.className = 'item';
      note.textContent = 'Your account has access to one workspace.';
      menu.appendChild(note);
      item(menu, 'Workspace overview', 'overview.html');
    });
  }

  document.addEventListener('click', (event) => {
    if (open && !open.menu.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  const cell = (text) => (/[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text);
  for (const link of document.querySelectorAll('a[data-export]')) {
    link.addEventListener('click', (event) => {
      const table = link.closest('.panel')?.querySelector('table');
      if (!table) return;
      event.preventDefault();
      const lines = [...table.rows].map((row) =>
        [...row.cells].map((c) => cell(c.textContent.trim().replace(/—/g, ''))).join(',')
      );
      const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = link.dataset.export;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  function markView() {
    const links = document.querySelectorAll('nav.rail a[href^="views.html#"]');
    for (const a of links) a.classList.toggle('on', a.hash === location.hash);
  }
  if (/views\.html$/.test(location.pathname)) {
    markView();
    window.addEventListener('hashchange', markView);
  }
})();
