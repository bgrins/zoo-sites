// Multi-origin entry point: bind every manifest origin on its own port, one
// process, one shared state. This is what the Docker container runs, and what
// the_zoo's proxy fronts (one fake domain per port). For single-origin dev
// serving use server.mjs directly.
//
//   node serve.mjs [--seed <s>]
//   node serve.mjs --vhosts [--port 8099] [--seed <s>]
//                                      (every origin at http://<key>.localhost:<port>)
//   node serve.mjs --print-zoo-label   (the compose label, no serve)

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
// SIGTERM is what `docker stop` sends PID 1, which then waits 10s for SIGKILL.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await srv.close();
    process.exit(0);
  });
}
