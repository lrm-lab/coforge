# User-content wildcard certificate

Web-page artifacts are served at `a-<uuid>.coforgeusercontent.com` (production) and
`a-<uuid>.staging.coforgeusercontent.com` (staging). One wildcard certificate per environment covers
them. Caddy obtains and renews it itself by ACME DNS-01 through Alibaba Cloud DNS. Wildcard DNS
records already point at the host.

## How it works

- Caddy runs `ghcr.io/lrm-lab/coforge/coforge-caddy`, built from [`infra/caddy/`](../../../infra/caddy/README.md):
  stock Caddy plus the `alidns` DNS provider. The Compose file pins it by digest.
- Only the wildcard site in each Caddyfile (`*.coforgeusercontent.com`,
  `*.staging.coforgeusercontent.com`) has a `tls { dns alidns ... }` block. `coforge.cn`, the apex
  user-content site and every other site keep HTTP-01/TLS-ALPN. There is no global `acme_dns`.
- The credentials reach Caddy as the environment variables `ALIDNS_ACCESS_KEY_ID` and
  `ALIDNS_ACCESS_KEY_SECRET`. `scripts/deploy/deploy-secrets.sh` reads them from the host secret files
  `alidns_access_key_id` and `alidns_access_key_secret` and hands them to Compose for one invocation.
  `remote-deploy.sh` validates the Caddyfile with the same image and variables before recreating Caddy.
- The certificate and ACME account live in the `caddy_data` volume; a deploy that does not change the
  image keeps them.

## RAM identities

| Environment | RAM user | Policy |
| --- | --- | --- |
| Production | `coforge-production-usercontent-dns` | `CoForgeProductionUserContentDns` |
| Staging | `coforge-staging-usercontent-dns` | `CoForgeStagingUserContentDns` |

Each user has one AccessKey and no console access. Its policy allows only the DNS record actions
Caddy needs on the zone `coforgeusercontent.com`, and carries a source-IP condition for that
environment's host.

## GitHub Environment secrets

| Environment | Secret | Written to the host as |
| --- | --- | --- |
| `production` and `staging` | `ALIDNS_ACCESS_KEY_ID` | `secrets/alidns_access_key_id` |
| `production` and `staging` | `ALIDNS_ACCESS_KEY_SECRET` | `secrets/alidns_access_key_secret` |

Both deploy workflows check both values in their first step, before any SSH connection or file
copy, and fail without touching the host when either is missing. Every production deploy, including
re-promoting an older image, therefore fails until both secrets exist in the `production`
Environment. Every deploy refreshes both files on the host.

## Residual risk

The RAM policy can only scope to the whole zone `coforgeusercontent.com`, and staging lives inside
it. The staging key can therefore write `_acme-challenge` records for production names. Splitting
staging into its own zone is the fix if that matters.

## Triage

Issuance failures (wrong secret, a source IP that does not match the policy, a missing RAM action)
do not show in the deploy health checks, which only probe `coforge.cn`. After a healthy deploy,
`remote-deploy.sh` resolves a fixed host `a-00000000-0000-0000-0000-000000000000.<sandbox domain>`
to the local Caddy and requires a trusted TLS handshake, retrying for about 60 seconds. If that
fails it adds a `warning=` line to the deploy report (shown as a workflow warning) and never rolls
back. Then read the Caddy logs on the host:

```sh
docker logs <caddy container> 2>&1 | grep -i -E 'acme|alidns|certificate'
```

## Rotation

1. In RAM, create a second AccessKey for the environment's user.
2. Update `ALIDNS_ACCESS_KEY_ID` and `ALIDNS_ACCESS_KEY_SECRET` in that GitHub Environment.
3. Run the environment's deploy workflow; the changed environment recreates Caddy.
4. Confirm the wildcard host answers over HTTPS, then delete the old AccessKey.

## Updating the image

After a change under `infra/caddy/` lands on `main`, run the workflow `caddy-image.yml` by hand
(`gh workflow run caddy-image.yml`); like every publishing workflow it has no push trigger, and it
prints the digest in its job summary. Put that digest in the `caddy` service of both
`infra/staging/docker-compose.yml` and `infra/production/docker-compose.yml`.
