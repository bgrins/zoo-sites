(function () {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (at) => {
    const d = new Date(at);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
      ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  };
  const age = (ms) => {
    const mins = Math.max(0, Math.floor(ms / 60000));
    return (mins >= 60 ? Math.floor(mins / 60) + ' hr ' : '') + (mins % 60) + ' min ago';
  };
  const IMPACT = { degraded: '#e2b93b', partial: '#d4694f' };
  const IMPACT_WORD = { degraded: 'degraded performance', partial: 'partial outage' };

  function drawBars(summary) {
    const windowText = document.querySelector('.sys-window');
    if (windowText) windowText.textContent = 'Daily uptime from ' + summary.window.from + ' to ' + summary.window.to;
    for (const comp of summary.components) {
      const row = document.querySelector('.sysrow[data-component="' + comp.key + '"]');
      if (!row) continue;
      const name = row.querySelector('.sys-name').textContent;
      const bar = row.querySelector('.sys-bar');
      const width = 100 / summary.window.days;
      const marks = comp.days.map((d) => {
        const from = (d.index * width).toFixed(3);
        const to = ((d.index + 1) * width).toFixed(3);
        return 'linear-gradient(90deg, transparent ' + from + '%, ' + IMPACT[d.impact] + ' ' + from +
          '% ' + to + '%, transparent ' + to + '%)';
      });
      if (marks.length) bar.style.backgroundImage = marks.join(', ') + ', ' + getComputedStyle(bar).backgroundImage;
      const label = comp.days.length
        ? comp.days.map((d) => d.day + ', ' + IMPACT_WORD[d.impact] + ' (' + d.refs.join(', ') + ')').join('; ')
        : 'no incidents';
      bar.setAttribute('aria-label', name + ', last ' + summary.window.days + ' days: ' + label);
      bar.title = label;
      row.querySelector('.sys-pct').textContent = comp.uptime + '%';
    }
  }

  function drawIncident(summary, now) {
    const inc = summary.incident;
    for (const el of document.querySelectorAll('[data-live="opened"]')) {
      el.textContent = 'opened ' + stamp(inc.openedAt) + ', ' + age(now - inc.openedAt);
    }
    for (const el of document.querySelectorAll('[data-live="update"]')) {
      const update = inc.updates.find((u) => u.state === el.dataset.state);
      if (update) el.textContent = stamp(update.at) + ', ' + age(now - update.at);
    }
  }

  fetch('/api/status/summary', { headers: { 'X-Session-Nonce': NONCE } })
    .then((r) => (r.ok ? r.json() : null))
    .then((summary) => {
      if (!summary) return;
      const skew = summary.now - Date.now();
      drawBars(summary);
      drawIncident(summary, summary.now);
      setInterval(() => drawIncident(summary, Date.now() + skew), 30000);
    })
    .catch(() => {});
})();
