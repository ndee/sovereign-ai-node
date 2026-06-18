# Custom Caddy image with the deSEC DNS-01 provider plugin, used ONLY by nodes
# running in relay TLS-passthrough mode (the node terminates its own TLS with a
# Let's Encrypt cert obtained via deSEC DNS-01). Legacy relay / direct / internal
# modes keep the stock caddy:2.10.2-alpine image.
#
# Build + publish (CI / operator), then reference by digest via
# SOVEREIGN_MATRIX_CADDY_DESEC_IMAGE (or update DEFAULT_CADDY_DESEC_IMAGE):
#
#   docker build -t ghcr.io/ndee/sovereign-caddy-desec:2.10.2 deploy/caddy-desec
#   docker push   ghcr.io/ndee/sovereign-caddy-desec:2.10.2
#
# Keep the Caddy version aligned with DEFAULT_CADDY_IMAGE (caddy:2.10.2-alpine)
# in src/system/matrix.ts so legacy and passthrough nodes run the same Caddy.
FROM caddy:2.10.2-builder-alpine AS builder
RUN xcaddy build v2.10.2 \
    --with github.com/caddy-dns/desec

FROM caddy:2.10.2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
