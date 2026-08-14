# The zoo-sites container: every simulated origin on its own port, one node
# process, shared state. The server tree is dependency-free (node builtins
# only), so there is no install step and the image is the source plus node.
#
#   docker build -f docker/Dockerfile -t zoo-sites .
#   docker run -p 8100-8165:8100-8165 zoo-sites
#
# Determinism: pass EVAL_SEED to pin the sites' difficulty draws for the
# container's lifetime.
FROM node:22-slim

WORKDIR /app
COPY server.mjs manifest.mjs serve.mjs preview.html LICENSE NOTICE ./
COPY sites/ sites/
COPY pages/ pages/

# Bind all interfaces: a published port bound to the container's own loopback
# refuses every connection from the host and from peer containers.
ENV ZOO_HOST=0.0.0.0

EXPOSE 8100-8165
# 0.0.0.0 is a bind address, not a connectable one, so the probe targets
# loopback instead. That makes this a liveness check only: it reports healthy
# whenever the server is up, including the case where the server bound loopback
# alone and refuses every external connection. ENV ZOO_HOST above is what
# prevents that case; the healthcheck cannot detect it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://'+(process.env.ZOO_HOST==='0.0.0.0'?'127.0.0.1':process.env.ZOO_HOST)+':8100/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "serve.mjs"]
