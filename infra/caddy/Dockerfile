FROM caddy:2.10.2-builder@sha256:01668408cc26e2e00c9d067c30cb43b2ba14ad1f2808beda55503cb2a31f59dc AS builder
RUN xcaddy build v2.10.2 \
    --with github.com/caddy-dns/alidns@c8c945ded9ace193e86f063842ba59981b35146b

FROM caddy:2.10.2@sha256:c3d7ee5d2b11f9dc54f947f68a734c84e9c9666c92c88a7f30b9cba5da182adb
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
