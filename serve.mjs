// Multi-origin entry point: bind every manifest origin on its own port, one
// process, one shared state. This is what the Docker container runs, and what
// the_zoo's proxy fronts (one fake domain per port). For single-origin dev
// serving use server.mjs directly.
//
//   node serve.mjs [--seed <s>]
//   node serve.mjs --print-zoo-label   (the compose label, no serve)

import { startPagesServer } from './server.mjs';
import { ORIGINS, zooDomainsLabel } from './manifest.mjs';

const args = process.argv.slice(2);
if (args.includes('--print-zoo-label')) {
  console.log(zooDomainsLabel());
  process.exit(0);
}
const seedIdx = args.indexOf('--seed');
const seed = seedIdx !== -1 ? args[seedIdx + 1] : (process.env.EVAL_SEED ?? null);

// Loopback unless told otherwise. The container sets ZOO_HOST=0.0.0.0, because a
// published port that is bound only to the container's loopback refuses every
// connection from the host while the healthcheck — which also runs inside the
// container — keeps reporting healthy.
const host = process.env.ZOO_HOST ?? '127.0.0.1';
const srv = await startPagesServer({ origins: ORIGINS, fixedPorts: true, seed, host });
console.log(`zoo-sites: ${ORIGINS.length} origins up (shared state, one process)`);
for (const o of srv.origins) {
  console.log(`  ${o.domain.padEnd(24)} ${o.url}  <- pages/${o.dir}`);
}
process.on('SIGINT', async () => {
  await srv.close();
  process.exit(0);
});
