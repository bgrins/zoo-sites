# The zoo-sites container: every simulated origin on its own port, one node
# process, shared state. The server tree is dependency-free (node builtins
# only), so there is no install step and the image is the source plus node.
#
#   docker build -f docker/Dockerfile -t zoo-sites .
#   docker run -p 8100-8166:8100-8166 zoo-sites
#
# Determinism: pass EVAL_SEED to pin the sites' difficulty draws for the
# container's lifetime.
FROM node:22-slim

WORKDIR /app
# COPY keeps the build context's mode bits, and the server runs as node below,
# so it would answer 500 for any file checked out 0600. One explicit mode has to
# cover the directories too, hence 0755 rather than 0644.
COPY --chmod=0755 server.mjs manifest.mjs serve.mjs LICENSE ./
COPY --chmod=0755 sites/ sites/
COPY --chmod=0755 pages/ pages/

# Bind all interfaces: a published port bound to the container's own loopback
# refuses every connection from the host and from peer containers.
ENV ZOO_HOST=0.0.0.0

EXPOSE 8100-8166
# The probe targets loopback whatever ZOO_HOST says, because 0.0.0.0 and :: are
# bind addresses, not connectable ones. That makes this a liveness check only:
# it reports healthy whenever the server is up, including the case where the
# server bound loopback alone and refuses every external connection. ENV
# ZOO_HOST above is what prevents that case; the healthcheck cannot detect it.
# It fetches a stylesheet (port 8100 serves pages/calc) rather than a page,
# because every cookieless HTML response mints a session: a probe every 30s
# would fill MAX_SESSIONS in server.mjs within two days and then evict real
# sessions, oldest first.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8100/calc.css').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# The sources stay root-owned and read-only to the server, which writes nothing
# to disk.
USER node
CMD ["node", "serve.mjs"]
