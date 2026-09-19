# The zoo-sites container: build, test, and zoo integration

[the_zoo](https://github.com/bgrins/the_zoo) is a reproducible simulated web
environment: a compose stack where CoreDNS resolves `.zoo` domains, Caddy
reverse-proxies each service, and a Squid forward proxy gives a host browser access.
The `zoo.domains` label below is how a service tells that stack which domains it
answers for. Sections 5 and 6 wire this image into the zoo; sections 1 through 4
need nothing but Docker.

## What the image is

One node process serves all 66 simulated origins, each on its own port
(8100-8165), over one shared in-memory state. The server tree needs no
dependencies beyond node builtins, so the image needs no `npm install`: it is the
source plus `node:22-slim`.

The image leaves out `eval/answers.mjs` (the answer key), the harness (`eval/run.mjs` and
`eval/verify.mjs`), the drivers, both MCP servers, and the dev contact sheet
(`preview.html`): the container is the habitat, not the eval. The server runs as the
unprivileged `node` user over root-owned sources, and writes nothing to disk. The
Dockerfile copies those sources with an explicit mode (`--chmod=0755`), so a
checkout made under a restrictive umask still serves.
Graded runs (`node eval/run.mjs ...`) stay on the host, in-process with
their own pages server, because validators read server-observed state (sessions,
counters, minted codes) directly. The container exposes no state-introspection
endpoint, deliberately — such an endpoint would hand any agent in the zoo an
oracle.

Zoo mode is a standing habitat of realistic sites for agents that live in the
zoo, plus demos and manual exploration, carrying the same fictions, gates and
dark patterns the eval grades against.

The dev-only routes stay off here: `serve.mjs` does not enable preview, so `/` on
each port serves that origin's own fixture root and `/_preview` returns 404.
Neither the generated index nor the contact sheet is reachable from the
container, which keeps them away from an agent living in the zoo.

## 1. Build

```sh
docker build -f docker/Dockerfile -t zoo-sites .
```

The build context is the repo root. Expect no network fetches beyond the base
image, and no install step.

`.dockerignore` at the repo root is an allowlist, the inverse of the Dockerfile's
`COPY` set; without it a local build ships `node_modules/`, `eval/results/` and
`staging/` to the daemon. Adding a `COPY` means adding the same path to
`.dockerignore` too, and skipping that step fails the build with
`"/<path>": not found` for a file that plainly exists on disk, because the path
never entered the build context. A `COPY` that fails on a path you did not
add means `docker/Dockerfile`'s file list has drifted from the tree; fix the
Dockerfile, not the tree.

## 2. Host binding

`serve.mjs` reads `ZOO_HOST` and defaults to `127.0.0.1`, so a bare
`node serve.mjs` on a host stays on loopback. The Dockerfile sets
`ENV ZOO_HOST=0.0.0.0`, because a published port bound to the container's own
loopback refuses every connection from the host and from peer containers — the
whole reason the variable exists. Overriding it back to `127.0.0.1` inside the
container makes the published ports unreachable again, so do that only when the
container is meant to be reachable by nothing.

The `HEALTHCHECK` probes `127.0.0.1` whatever `ZOO_HOST` says, because `0.0.0.0`
and `::` are bind addresses rather than connectable ones. Read it as liveness only:
it reports healthy whenever the server is up, including the case where the server
bound loopback alone and refuses every external connection. `ENV ZOO_HOST=0.0.0.0`
is what prevents that case, so a healthy container is not by itself evidence that
the published ports answer.

The probe fetches `/calc.css` on port 8100 rather than a page. Every cookieless HTML
response mints a session, and the session map is capped oldest-first, so a probe that
fetched a page every 30 seconds would start evicting real sessions within two days.

The startup log prints each origin as `http://127.0.0.1:<port>` — the URL to use
from the host after publishing the ports — and does not report the bind address.

## 3. Run and smoke-test the origins

```sh
docker run --rm -p 8100-8165:8100-8165 zoo-sites
```

The startup log opens with `zoo-sites: 66 origins up (shared state, one
process)`, followed by one line per origin mapping domain to port to `pages/`
subtree. Then, from the host:

```sh
# Three spot origins serve their own fiction at their own root:
curl -s http://127.0.0.1:8163/ | grep -o 'Voltro'         # the Voltro storefront
curl -s http://127.0.0.1:8141/ | grep -o 'Nimbrel'        # the status page
curl -s http://127.0.0.1:8133/ | grep -o 'Drennhill'      # the dental practice

# Legacy-prefixed self-links pass through the shim (both must be 200):
curl -so /dev/null -w '%{http_code}\n' http://127.0.0.1:8163/basket.html
curl -so /dev/null -w '%{http_code}\n' http://127.0.0.1:8163/shop/voltro/basket.html

# A foreign site's path on the wrong origin must 404:
curl -so /dev/null -w '%{http_code}\n' http://127.0.0.1:8163/gov/

# Every origin answers robots.txt (200), and a directory without its slash
# redirects to the slash form (301, Location: ./departments/):
curl -so /dev/null -w '%{http_code}\n' http://127.0.0.1:8111/robots.txt
curl -so /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:8111/departments

# API dispatch works on every origin's port (403 = the nonce gate answered,
# which is the route working):
curl -so /dev/null -w '%{http_code}\n' http://127.0.0.1:8163/api/shop/catalog?store=voltro

# Sessions mint per response:
curl -si http://127.0.0.1:8163/ | grep -i '^set-cookie: sid='

# Health (wired into the image as a HEALTHCHECK too):
docker inspect --format '{{.State.Health.Status}}' <container>
```

## 4. Seed determinism (optional but quick)

`EVAL_SEED` pins the sites' difficulty draws — which auction rungs, which cabin
weekend, which board layout — for a container's lifetime:

```sh
docker run --rm -e EVAL_SEED=alpha -p 8100-8165:8100-8165 zoo-sites
```

Two containers started with the same seed deal the same shapes to their first
session per site; unseeded containers draw fresh. Identifier mints (confirmation
codes, references) stay random regardless, so a seeded container is reproducible,
never forgeable.

## 5. Regenerate and wire the zoo snippet

```sh
node docker/gen-zoo-snippet.mjs > docker/zoo-snippet.yaml
```

Paste the block into the_zoo's `docker-compose.yaml`. The generator reads
`manifest.mjs`, so the label cannot drift from what the container serves;
regenerate rather than hand-edit. `scripts/check-fixtures.mjs` fails when a
`domain:port` pair in the committed snippet no longer holds in the manifest, so a
moved or renamed origin cannot land without a regenerated snippet, which then
has to be pasted into the_zoo again. The `zoo.domains` label shape matches what the
zoo's config generator parses: it splits the value on commas and reads each entry
as `domain` or `domain:port`, so a comma-separated list of `<brand>.zoo:<port>` is
correct. If that parser changes, fix `zooDomainsLabel()` in `manifest.mjs` and
regenerate.

The image name follows the repository owner: `.github/workflows/container.yml`
publishes `ghcr.io/<owner>/zoo-sites` once `.github/workflows/gate.yml` passes on a
push to `main` (tagged `sha-<short sha>`, plus `latest` if that commit is still
main's tip when the publish job runs) or on a `v*` tag that points at a commit on
`main` (tagged with the tag name and the sha). A red or cancelled gate publishes
nothing, a tag on a commit that is not on `main` publishes nothing, and a pull
request builds the image without pushing it. The generator reads
`GITHUB_REPOSITORY_OWNER`, so set it when regenerating outside Actions:

```sh
GITHUB_REPOSITORY_OWNER=<owner> node docker/gen-zoo-snippet.mjs > docker/zoo-snippet.yaml
```

The Dockerfile `EXPOSE`s the range 8100-8165. If the zoo's network mode makes
port publishing unnecessary (the proxy sits on the compose network), drop the
`-p` range from local runs and let the proxy reach the container directly.

## 6. Verify the proxy preserves what the fixtures rely on

These are the assumptions the fixtures make about anything fronting them. Check
each once against the_zoo's proxy, in a real browser pointed at the zoo.

1. **Cookies are per-domain.** Interact on voltro.zoo, then check in devtools
   that its `sid` cookie is NOT sent to marrowgate.zoo. Every origin mints its
   own session, and that separation is the zoo-mode model.
2. **Host and navigation metadata pass through.** The navigation gates read
   `sec-fetch-dest` and `sec-fetch-mode`. A browser sends those only to an https
   or loopback origin, so over plain `http://<brand>.zoo` it sends none, and the
   server falls back to the `Accept` header for any request whose Host is not
   loopback (see `navOf` in `server.mjs`). Open
   `http://civic-revenue.zoo/gov/legacy/rv3` and follow the notice it returns:
   the redirect-loop escape (`?v=2`) should serve the archived copy on a real
   browser navigation and refuse a plain `curl` of the same URL. Repeat over
   `https://`. A proxy that rewrites Host to a loopback name breaks the
   plain-http escape first, because the server then expects sec-fetch headers
   the browser never sent.
3. **No response caching.** Sessions substitute a per-session nonce into every
   HTML body, so a cached page would hand one session's nonce to another. HTML goes
   out with `Cache-Control: no-cache, private`, which a proxy has to honour. Two
   fresh browser profiles loading the same page must see different
   `window.NONCE` values (view-source and compare).
4. **The one cross-origin link resolves.** The maintenance splash comes from the
   gadgetron outage mode, a per-task server mode that is off by default, so this
   check runs against the tree rather than the container. Start the server in
   origin mode with `modes: { gadgetronDown: true }`: the splash it serves
   carries a mirror link pointing at the absolute gadgetron-mirror origin URL,
   while in single-origin mode the same token resolves to
   `/shop/gadgetron-mirror/`.
5. **WebSocket-free.** The sites speak plain HTTP; nothing to configure.

## Exposure

Everything these origins serve is fictional, and some of it deliberately hostile:
a phishing-lookalike sign-in pair, dark-pattern consent and unsubscribe flows,
and a prompt-injection bait with an exfiltration sink. The container binds all
interfaces so a published port works, so anything that can reach those ports can
drive every site's state and submit credentials to forms that look real. Publish
the ports to a network you control; see README, "Do not serve these fixtures on a
public network".
