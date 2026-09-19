// What the console says when a vault request comes back without data.
function vaultTrouble(status, name) {
  if (status === 401) return 'You are signed out of the console.';
  if (status === 403) return 'This page has been open too long. Reload it to carry on.';
  if (status === 404) {
    return name
      ? 'No secret called "' + name + '" is held for Platform Delivery.'
      : 'Nothing is held under that name.';
  }
  return 'The vault did not answer (HTTP ' + status + '). Try again in a moment.';
}

// A signed-out console stops naming the account in the rail.
function vaultSignedOutRail() {
  const who = document.querySelector('.rail .who');
  if (!who) return;
  who.textContent = '';
  const id = document.createElement('p');
  id.className = 'id';
  id.textContent = 'Signed out';
  const next = document.createElement('p');
  const a = document.createElement('a');
  a.href = 'signout.html?signin=1';
  a.textContent = 'Sign in';
  next.append(a);
  who.append(id, next);
}

// Writes that message into `el`, with the way out a reader needs next.
function vaultTroubleInto(el, status, name) {
  el.textContent = vaultTrouble(status, name);
  if (status === 401) vaultSignedOutRail();
  const next =
    status === 401
      ? ['signout.html?signin=1', 'Sign in again']
      : status === 404
        ? ['index.html', 'Back to Secrets']
        : null;
  if (!next) return el;
  const a = document.createElement('a');
  a.href = next[0];
  a.textContent = next[1];
  el.append(' ', a);
  return el;
}
