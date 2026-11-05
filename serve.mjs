// Multi-origin entry point: bind every manifest origin on its own port, one
// process, one shared state. This is what the Docker container runs, and what
// the_zoo's proxy fronts (one fake domain per port). For single-origin dev
// serving use server.mjs directly.
//
//   node serve.mjs [--seed <s>]
//   node serve.mjs --vhosts [--port 8099] [--seed <s>]
//                                      (every origin at http://<key>.localhost:<port>)
//   node serve.mjs --print-zoo-label   (the compose label, no serve)
//   add --gallery [--gallery-port 8098] to either serve form for a contact
//   sheet that iframes every origin, opened in the default browser

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { startPagesServer } from './server.mjs';
import { ORIGINS, zooDomainsLabel } from './manifest.mjs';

const args = process.argv.slice(2);
if (args.includes('--print-zoo-label')) {
  console.log(zooDomainsLabel());
  process.exit(0);
}
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const seed = flag('--seed') ?? process.env.EVAL_SEED ?? null;
// Host-routed: one port, a host per site, so each site keeps its own cookies in
// the browser, as behind the_zoo's proxy. The container keeps its port per origin.
const vhosts = args.includes('--vhosts');

// Loopback unless told otherwise. The container sets ZOO_HOST=0.0.0.0, because a
// published port that is bound only to the container's loopback refuses every
// connection from the host while the healthcheck — which also runs inside the
// container — keeps reporting healthy.
const host = process.env.ZOO_HOST ?? '127.0.0.1';
// capped, because a standing habitat never resets its state between tasks.
const srv = await startPagesServer(
  vhosts
    ? { vhosts: true, port: Number(flag('--port') ?? 8099), seed, host, capped: true }
    : { origins: ORIGINS, fixedPorts: true, seed, host, capped: true }
);
console.log(
  `zoo-sites: ${ORIGINS.length} origins up (shared state, one process` +
    `${vhosts ? `, host-routed on port ${srv.port}` : ''})`
);
for (const o of srv.origins) {
  console.log(`  ${o.domain.padEnd(24)} ${o.url}  <- pages/${o.dir}`);
}

// Dev-only, on a loopback port of its own, never one of the origins: the
// container does not pass --gallery, so no agent can reach the sheet.
let gallery = null;
if (args.includes('--gallery')) {
  const bases = srv.origins
    .map((o) => [o.dir, o.url])
    .sort((a, b) => b[0].length - a[0].length);
  const page = (await readFile(new URL('./preview.html', import.meta.url), 'utf8')).replace(
    '</head>',
    `<script>window.ZOO_ORIGINS = ${JSON.stringify(bases)};</script>\n</head>`
  );
  gallery = http.createServer((req, res) => {
    if (req.method !== 'GET' || new URL(req.url, 'http://localhost').pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
  });
  await new Promise((resolve, reject) => {
    gallery.once('error', reject);
    gallery.listen(Number(flag('--gallery-port') ?? 8098), '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${gallery.address().port}/`;
  console.log(`gallery at ${url}`);
  const opener = { darwin: 'open', linux: 'xdg-open' }[process.platform];
  if (opener) {
    spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
}

// SIGTERM is what `docker stop` sends PID 1, which then waits 10s for SIGKILL.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    gallery?.close();
    gallery?.closeAllConnections();
    await srv.close();
    process.exit(0);
  });
}
