// My account: loads the signed-in account for each page, fills the shared
// header, and runs a settings tab's form (unsaved-changes state, Save, Discard,
// and the leave warning while edits are unsaved).
(() => {
  const $ = (id) => document.getElementById(id);

  async function api(path, body) {
    const init = body === undefined
      ? { headers: { 'X-Session-Nonce': NONCE } }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nonce: NONCE, ...body }),
        };
    const res = await fetch(path, init);
    return { ok: res.ok, body: await res.json().catch(() => ({})) };
  }

  const when = (at) =>
    new Date(at).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });

  async function load() {
    let r = null;
    try {
      r = await api('/api/lumeva/account');
    } catch {}
    if (!r || !r.ok) {
      $('acctError').hidden = false;
      throw new Error('account unavailable');
    }
    const { account } = r.body;
    $('acctNumber').textContent = account.number;
    $('acctPlan').textContent = `${account.plan}, ${account.lines.length} lines`;
    return r.body;
  }

  // `read()` returns the form's values in the shape the tab's endpoint takes,
  // `write(values)` puts saved values back into the controls.
  function settingsForm({ tab, form, read, write }) {
    const pill = $('dirtyPill');
    const saveBtn = $('saveBtn');
    const discardBtn = $('discardBtn');
    const note = $('saveNote');
    let saved = null;
    let saving = false;
    let guarded = false;

    const changed = () => {
      if (!saved) return [];
      const now = read();
      return Object.keys(saved).filter((key) => now[key] !== saved[key]);
    };
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    function paint() {
      const dirty = changed().length > 0;
      pill.hidden = !dirty;
      saveBtn.disabled = !dirty || saving;
      discardBtn.disabled = !dirty || saving;
      if (dirty !== guarded) {
        (dirty ? addEventListener : removeEventListener)('beforeunload', warn);
        guarded = dirty;
      }
    }
    const say = (text, ref) => {
      note.textContent = text;
      if (ref) {
        const strong = document.createElement('strong');
        strong.className = 'ref';
        strong.textContent = ref;
        note.append(' Change ref ', strong);
      }
    };

    form.addEventListener('input', () => {
      say('');
      paint();
    });
    form.addEventListener('change', paint);
    discardBtn.addEventListener('click', () => {
      write(saved);
      say('Changes discarded.');
      paint();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (saving || !changed().length) return;
      saving = true;
      paint();
      say('Saving…');
      let r = null;
      try {
        r = await api(`/api/lumeva/account/${tab}`, { values: read() });
      } catch {}
      saving = false;
      if (!r || !r.ok) {
        say(r?.body?.error || 'We could not save your changes. Try again in a moment.');
        paint();
        return;
      }
      saved = r.body.values;
      write(saved);
      if (r.body.changed) say('Changes saved.', r.body.ref);
      else say('Nothing to save.');
      paint();
    });
    addEventListener('pagehide', () => {
      const fields = changed();
      if (fields.length) {
        navigator.sendBeacon('/api/lumeva/account/leave', JSON.stringify({ nonce: NONCE, tab, fields }));
      }
    });

    return {
      start(values) {
        saved = values;
        write(values);
        $('formBody').disabled = false;
        paint();
      },
    };
  }

  window.LumevaAccount = { load, settingsForm, when };
})();
