# zoo-sites

A set of simulated websites, served locally. 67 origins across 54 site trees: a
storefront, a legacy government portal, a dark ops console, a bank, a newsroom, a
1930s freight registry, and so on. Every one is invented, and every one carries its
own design language rather than a shared template.

```sh
node server.mjs --port 8907   # every site on one port; / is an index, /_preview a contact sheet
node serve.mjs                # all 67 origins, one per port from 8100, one process
```

No dependencies: the server is node builtins only. `docker/README.md` runs the same
thing as a container, one port per origin, as a standing habitat.

The same sites also back a browser-agent eval, which grades an agent on what each
site's server observed — see **[`eval/`](eval/)**. That eval is a separate concern
that happens to live here: nothing under `pages/`, `sites/`, `server.mjs`, `serve.mjs`
or `manifest.mjs` depends on it.

## Every site here is fiction

Everything under `pages/` is invented: every business, person, product, price,
domain, phone number, email address, policy document, news article, and bank.

- Domains and email addresses use RFC 2606 reserved names (`.example`,
  `example.com`, `<brand>.example.net`). Phone numbers use ranges reserved for
  fiction: Ofcom's UK drama ranges (`020 7946 0xxx`, `0113/0117/0151/0161 496
  0xxx`, `01632 960xxx`, `0808 157 0xxx`, `03069 990xxx`, some written in `+44`
  form), and the NANP `555-0100` to `555-0199` block under a geographic area code
  (`541-555-0142`, `1-614-555-0142`, `(415) 555-0104`, `+1 206 555 0148`). The
  one exception is `pages/gov/`, whose `(555) 014-xxxx` numbers put 555 in the
  area-code slot: outside the reserved block, but never a working line, because
  no NANP exchange code starts with 0. Company, charity, VAT and regulator
  register numbers are zero sentinels.
- The fixtures contain a **phishing lookalike**: two near-identical bank origins, one
  fraudulent with four seeded tells.
- The fixtures contain **prompt-injection bait** in page content, **dark-pattern nag
  flows**, and **checkout upsells** meant to be declined.
- Nothing under `pages/` says or implies that a site is a test fixture. That silence
  is deliberate: a real site would not say so either.
- Some things are broken on purpose. Three gallery images really 404, one promo banner
  really sits under another, a file rename really rolls back.

The eval measures every one of those behaviours deliberately. None of them is a
vulnerability in this repository.

## Do not serve these fixtures on a public network

`server.mjs` and `serve.mjs` bind `127.0.0.1` unless told otherwise. The container is
the one deliberate exception: `docker/Dockerfile` sets `ENV ZOO_HOST=0.0.0.0`, because
a published port bound to the container's own loopback refuses every connection from
the host.

Anyone exposing these servers, in a container or otherwise, accepts that they:

- hold **mutable per-session state** in memory with no authentication in front of it,
  so any client can drive any site's state;
- **accept credentials into forms that go nowhere**, styled to look like they mean it;
- are **built to look convincing**, including the phishing lookalike, so a human who
  reaches one by accident has no in-page signal that it is fake;
- serve **HTML carrying a per-session nonce**. It goes out with `Cache-Control:
  no-cache, private`, but a caching proxy in front of them that ignores that header
  will hand one session's nonce to another.

Keep them on loopback, or on a private network you control whose users know what they
are. `sites/bank.mjs` authenticates nothing and never records a password — it stores
the submitted username and the *length* of the password field.

## Layout

| Path | What |
|---|---|
| `server.mjs` | Fixture server core: sessions, static serving, site dispatch. Node builtins only. |
| `serve.mjs` | Multi-origin entry, what the container runs. `--print-zoo-label` emits the compose label. |
| `manifest.mjs` | The origin manifest: key, pages dir, `.zoo` domain, port — one row per origin. |
| `pages/` | 969 HTML fixtures in 54 site trees. |
| `sites/` | Per-site backends: session state, minted codes, the APIs each page calls. |
| `scripts/gen/` | Generators for the bulk fixture trees (`pages/gov/departments`, `pages/ledger`). |
| `eval/` | The browser-agent eval: tasks, validators, golden-path drivers, runners. |
| `docker/` | Container build and compose integration with [the_zoo](https://github.com/bgrins/the_zoo). |
| `docs/` | Fixture authoring rules, grading design, working notes. |

Ground truth is never derivable from anything under `pages/`: graded values are minted
per session in `sites/`. That lets the eval grade on what a server observed rather
than on what an agent claimed. `docs/authoring-fixtures.md` carries the rules a
new fixture must follow, and `AGENTS.md` the binding ones.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
