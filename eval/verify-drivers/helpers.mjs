// The helpers object every golden-path driver receives (probes.mjs holds the
// driver contract), bound to one MCP client and one pages server. verify.mjs
// builds one per gate worker and backends/scripted.mjs one per attempt, so a
// driver meets the same helpers in the gate and in a scripted run.

// How a pages server's URLs map to the single-origin paths drivers name
// (/paylink/checkout.html). In origin and vhost mode the site owning the
// longest matching dir prefix serves the rest of the path at its own root, so
// shop/gadgetron-mirror never lands on shop/gadgetron. A path no site owns (/,
// /api/...) stays on the single-origin listener, 127.0.0.1 in vhost mode too.
export function pagesRouting(pages) {
  const byDir = [...pages.origins].sort((a, b) => b.dir.length - a.dir.length);
  const urlFor = (path) => {
    const owner = byDir.find(
      (o) => path.startsWith(`/${o.dir}`) && /^([/?#]|$)/.test(path.slice(o.dir.length + 1))
    );
    if (!owner) return pages.url + path;
    const rest = path.slice(owner.dir.length + 1);
    return owner.url + (rest.startsWith('/') ? rest : `/${rest}`);
  };
  // A URL this server serves as the single-origin path it maps to
  // (/registrar/index.html), whichever serving mode served it, or null.
  const pathOf = (url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const owner = byDir.find((o) => url === o.url || url.startsWith(`${o.url}/`));
    if (owner) return `/${owner.dir}${parsed.pathname}`;
    return url.startsWith(pages.url) ? parsed.pathname : null;
  };
  return { urlFor, pathOf };
}

// `mcp(name, args)` calls one tool and resolves to its raw result. `mark(helpers,
// name)` stamps a profile marker; the default does nothing. Once `signal`
// aborts, sleep rejects, so a driver polling between calls stops at its next
// wait instead of outliving its attempt.
export function makeHelpers({ mcp, pages, mark = async () => {}, signal }) {
  // Only goto maps: helpers.base stays the single-origin listener, so a driver
  // must read the browser's URL before reporting it in origin or vhost mode.
  const { urlFor } = pagesRouting(pages);
  // Most drivers only need to navigate and read/poke the page; uid-based tools
  // are available too, and using them is what makes this a real dogfood of the
  // surface.
  const helpers = {
    mcp,
    base: pages.url,
    goto: (path) => mcp('navigate_page', { url: urlFor(path) }),
    evaluate: async (fn, fnArgs) => {
      const r = await mcp('evaluate_script', { function: String(fn), args: fnArgs });
      const text = (r.content ?? []).map((c) => c.text).join('\n');
      const m = text.match(/```json\n([\s\S]*?)\n```/);
      if (!m) return text;
      // A function with no return value comes back as the literal `undefined`,
      // which is not JSON; treat any unparseable payload as raw text.
      try {
        return JSON.parse(m[1]);
      } catch {
        return m[1] === 'undefined' ? undefined : m[1];
      }
    },
    snapshot: async () => {
      const r = await mcp('take_snapshot', {});
      return (r.content ?? []).map((c) => c.text).join('\n');
    },
    sleep: (ms) =>
      signal
        ? new Promise((resolve, reject) => {
            const stop = () => {
              clearTimeout(timer);
              reject(new Error(`sleep stopped: ${signal.reason ?? 'aborted'}`));
            };
            const timer = setTimeout(() => {
              signal.removeEventListener('abort', stop);
              resolve();
            }, ms);
            if (signal.aborted) stop();
            else signal.addEventListener('abort', stop, { once: true });
          })
        : new Promise((r) => setTimeout(r, ms)),
    // Stamp a named point inside the running task's profile span, e.g.
    // `await mark('scrolled-to-batch-8')`. The caller sets taskId, so a label
    // only has to be unique within its own driver. Costs nothing and reaches
    // nothing unless the caller profiles, so a driver may call it freely.
    mark: (label) => mark(helpers, `zoo:${helpers.taskId}:${label}`),
    taskId: null,
    phase: 'harness',
  };
  return helpers;
}
