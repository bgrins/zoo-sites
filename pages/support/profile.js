// Fills the service fields on My Account pages from the profile record.
async function loadProfile(ids) {
  let res = null;
  let data = null;
  try {
    res = await fetch('/api/support/profile', { headers: { 'X-Session-Nonce': NONCE } });
    if (res.ok) data = await res.json();
  } catch {
    data = null;
  }
  const signedOut = !data && !!res && (res.status === 401 || res.status === 403);
  for (const id of ids) {
    const slot = document.getElementById(id);
    slot.textContent = '';
    if (data) {
      slot.textContent = data[id] ?? '';
    } else if (signedOut) {
      const link = document.createElement('a');
      link.href = 'signin.html';
      link.textContent = 'Sign in to see this';
      slot.append(link);
    } else {
      slot.textContent = 'Not available right now';
    }
  }
}
