(() => {
  const handle = document.body.dataset.handle;
  const name = document.getElementById('p-name');
  const status = document.getElementById('p-status');
  const facts = document.getElementById('p-facts');
  const msg = document.getElementById('p-msg');
  const send = document.getElementById('p-send');
  const done = document.getElementById('p-done');
  const err = document.getElementById('p-err');

  function fact(k, v) {
    const box = document.createElement('div');
    box.className = 'fact';
    const key = document.createElement('span');
    key.className = 'fact-k';
    key.textContent = k;
    const val = document.createElement('span');
    val.className = 'fact-v';
    val.textContent = v;
    box.append(key, val);
    return box;
  }

  async function load() {
    const res = await fetch(`/api/console/card/${handle}`, { headers: { 'X-Session-Nonce': NONCE } });
    if (!res.ok) {
      status.textContent = 'Status unavailable.';
      return;
    }
    const d = await res.json();
    document.title = `${d.name} - People - Cindergrid`;
    name.textContent = d.name;
    status.textContent = d.status;
    status.className = d.status.startsWith('On call') ? 'pf-status on' : 'pf-status';
    facts.textContent = '';
    facts.append(
      fact('Handle', `@${d.handle}`),
      fact('Role', d.role),
      fact('Team', d.team),
      fact('Pager rotation', d.rotation ?? 'None'),
      fact('Email', d.email),
      fact('Paged by', 'Phone and email')
    );
  }

  send.addEventListener('click', async () => {
    const text = msg.value.trim();
    err.textContent = '';
    if (!text) {
      err.textContent = 'Write a message to send with the page.';
      return;
    }
    send.disabled = true;
    try {
      const res = await fetch('/api/console/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: NONCE, handle, message: text, via: 'profile' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        err.textContent = data.error || 'The page could not be sent.';
        return;
      }
      done.textContent = '';
      const lead = document.createElement('span');
      lead.textContent = 'Page sent. Receipt';
      const receipt = document.createElement('span');
      receipt.className = 'rc';
      receipt.textContent = data.receipt;
      done.append(lead, ' ', receipt);
    } finally {
      send.disabled = false;
    }
  });

  load();
})();
