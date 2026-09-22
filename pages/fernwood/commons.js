function commonsEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function commonsInitials(name) {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function commonsCheers(n) {
  return n + (n === 1 ? ' cheer' : ' cheers');
}

function commonsReplies(n) {
  return n === 0 ? 'Reply' : n === 1 ? '1 reply' : n + ' replies';
}

function postCard(p, heading = 'h2') {
  const permalink = 'post.html?ref=' + encodeURIComponent(p.ref);
  const el = commonsEl('article', 'card');
  const who = commonsEl('div', 'who');
  const id = commonsEl('div');
  const meta = commonsEl('div', 'meta');
  const when = commonsEl('a', 'when', p.when);
  when.href = permalink;
  meta.append(when, ' \u00b7 ' + p.where);
  id.append(commonsEl('div', 'name', p.author), meta);
  who.append(commonsEl('span', 'avatar', commonsInitials(p.author)), id);
  el.append(who, commonsEl(heading, '', p.title));
  for (const line of p.body) el.append(commonsEl('p', '', line));

  const foot = commonsEl('div', 'cardfoot');
  const acts = commonsEl('span', 'acts');
  const cheer = commonsEl('button', 'cheer', 'Cheer');
  cheer.type = 'button';
  cheer.setAttribute('aria-pressed', String(p.cheered === true));
  const count = commonsEl('span', 'cheers', commonsCheers(p.cheers));
  const replies = commonsEl('a', 'replies', commonsReplies(p.replies));
  replies.href = permalink + '#replies';
  cheer.addEventListener('click', async () => {
    cheer.disabled = true;
    try {
      const r = await fetch('/api/fernwood/cheer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: NONCE, ref: p.ref }),
      });
      if (r.ok) {
        const data = await r.json();
        cheer.setAttribute('aria-pressed', String(data.cheered === true));
        count.textContent = commonsCheers(data.cheers);
      }
    } catch {
    } finally {
      cheer.disabled = false;
    }
  });
  acts.append(cheer, count, replies);
  foot.append(commonsEl('span', 'ref', 'Ref ' + p.ref), acts);
  el.append(foot);
  return el;
}
