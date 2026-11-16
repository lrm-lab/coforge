# Caddy image

`coforge-caddy` is Caddy 2.10.2 with the `github.com/caddy-dns/alidns` DNS provider, used by both
Compose environments to obtain the user-content wildcard certificate by DNS-01
([how it works](../../docs/operations/usercontent-certificate/README.md)).

`Dockerfile` builds it with `xcaddy` from `caddy:2.10.2-builder` and copies the binary onto
`caddy:2.10.2`; both base images and the plugin commit are pinned. The workflow
`.github/workflows/caddy-image.yml` pushes it to `ghcr.io/lrm-lab/coforge/coforge-caddy` by digest; the
Compose files pin that digest. To check a local build, run `caddy version` and
`caddy list-modules` in it and look for `dns.providers.alidns`.
