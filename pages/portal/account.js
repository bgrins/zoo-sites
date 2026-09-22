// Public pages offer the way back into whichever area this session is signed in to.
fetch('/api/portal/whoami', { headers: { 'X-Session-Nonce': NONCE } })
  .then((res) => (res.ok ? res.json() : null))
  .then((who) => {
    if (!who?.signedIn) return;
    const link = document.getElementById('accountLink');
    link.href = who.home;
    link.textContent = who.label;
    if (who.initials) {
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = who.initials;
      link.before(avatar);
    }
  })
  .catch(() => {});
