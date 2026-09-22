// Console-wide behaviour: keyboard shortcuts, and column sorting on every grid
// that opts in with data-sort. Sort order is kept per page for the browser
// session, because a shared workspace link has nowhere to store it.
(function () {
  const GO = { d: 'index.html', o: 'orders.html', c: 'customers.html', p: 'pipeline.html', r: 'reports.html', t: 'tasks.html', a: 'admin.html' };
  let pendingG = 0;

  const typing = (el) => el && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (typing(event.target)) {
      if (event.key === 'Escape') event.target.blur();
      return;
    }
    if (pendingG && Date.now() - pendingG < 1500 && GO[event.key]) {
      pendingG = 0;
      location.href = GO[event.key];
      return;
    }
    pendingG = 0;
    if (event.key === 'g') {
      pendingG = Date.now();
    } else if (event.key === '/') {
      const field = document.querySelector('.filters input, .filters select');
      if (field) {
        event.preventDefault();
        field.focus();
      }
    } else if (event.key === '?') {
      location.href = 'shortcuts.html';
    }
  });

  const numeric = (text) => {
    const n = Number(text.replace(/[$,\s]/g, ''));
    return text.trim() !== '' && Number.isFinite(n) ? n : null;
  };

  for (const table of document.querySelectorAll('table.grid[data-sort]')) {
    const key = 'kelsmere.sort.' + table.dataset.sort;
    const body = table.tBodies[0];
    const heads = [...table.tHead.rows[0].cells];
    const original = [...body.rows];

    function apply(col, dir) {
      heads.forEach((th, i) => th.setAttribute('aria-sort', i === col ? dir : 'none'));
      const rows = [...original];
      if (dir !== 'none') {
        rows.sort((a, b) => {
          const x = a.cells[col].textContent.trim();
          const y = b.cells[col].textContent.trim();
          const nx = numeric(x);
          const ny = numeric(y);
          const cmp = nx !== null && ny !== null ? nx - ny : x.localeCompare(y);
          return dir === 'ascending' ? cmp : -cmp;
        });
      }
      body.append(...rows);
      try {
        sessionStorage.setItem(key, JSON.stringify({ col, dir }));
      } catch {}
    }

    heads.forEach((th, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sort';
      button.append(...th.childNodes);
      th.append(button);
      th.setAttribute('aria-sort', 'none');
      button.addEventListener('click', () => {
        const now = th.getAttribute('aria-sort');
        apply(i, now === 'ascending' ? 'descending' : now === 'descending' ? 'none' : 'ascending');
      });
    });

    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (saved && heads[saved.col] && ['ascending', 'descending'].includes(saved.dir)) {
        apply(saved.col, saved.dir);
      }
    } catch {}
  }
})();
