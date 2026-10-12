# coforge-production: cloud production environment

Status: **Compose environment ready; deploys run through the
`Deploy Web (production)` GitHub workflow. The host, managed datastores, and
secrets are provisioned by the operator.**

The production environment runs as the `coforge-production` Compose project on
a single ECS host (`infra/production/`). It mirrors `coforge-staging` except for
the datastores: PostgreSQL and Redis are managed Alibaba Cloud services reached
over the VPC, so the Compose project defines no database or cache containers.

## What runs where

- **Public entry:** Caddy on 443 only, trusted HTTPS for `coforge.cn`. Port 80
  is intentionally unreachable: no plaintext, not even redirects.
- **Loopback diagnostics:** web `127.0.0.1:18080`, Centrifugo `127.0.0.1:18000`.
- **Web and Centrifugo:** containers in the `coforge` network, pinned by digest.
  Centrifugo's Redis engine is the managed Redis instance.
- **PostgreSQL:** managed RDS PostgreSQL 18, reached over the VPC. Prisma
  migrations run from the `migrate` service (profile `tools`).
- **Redis:** managed Redis 7.0 (ApsaraDB for Redis), reached over the VPC.
- **User files:** OSS private bucket `coforge-files-prod`, accessed through the
  `coforge-production-web` ECS RAM role (STS from instance metadata; no
  AccessKey file or environment value).
- **CDN:** `files.coforge.cn` (signed attachment URLs; signing key is the
  secret `coforge_file_delivery_key`) and `images.coforge.cn` (public avatars
  and project icons, bucket `coforge-images-prod`).
- **Release feed:** `https://releases.coforge.cn`, bucket `coforge-releases`,
  published by `release-production.yml` and `release-installer-production.yml`
  ([runbook](computer-release.md)).

Not yet enabled in production: GitHub integration (the Web code returns no
GitHub client when `COFORGE_GITHUB_CLIENT_ID` is unset), OpenTelemetry tracing,
and Server-Timing.

## Operator bootstrap

1. Provision the ECS host, Docker rootless under the `deploy` user, and the
   `coforge-production-web` RAM role with the bucket policy for `coforge-files-prod`
   and `coforge-images-prod`. Follow the staging steps in
   [`docs/operations/staging/operator-bootstrap.md`](../staging/operator-bootstrap.md),
   replacing `staging` with `production` in names and paths.
2. Create the directories on the host:
   ```
   sudo -iu deploy mkdir -p ~/coforge-production/infra/production/{secrets,caddy,centrifugo}
   ```
3. Copy `infra/production/` (`docker-compose.yml`, `caddy/Caddyfile`,
   `centrifugo/config.yaml`) to `~/coforge-production/infra/production/`,
   preserving the layout.
4. Write the secret files listed below into
   `~/coforge-production/infra/production/secrets/`. Generate them on the host;
   never paste secret values into chat, issues, tickets, or CI logs. Keep every
   file mode 600: no container bind-mounts them. `remote-deploy.sh` reads them
   and passes each value to Compose, which creates the container's copy owned by
   the image's own user (the rootless daemon would show a bind-mounted 600 file
   as root-owned, unreadable to Web's and Centrifugo's non-root users).
5. Point DNS for `coforge.cn` at the ECS public address. TLS uses an ACME
   certificate over 443 (TLS-ALPN); there is no HTTP-01 path by design.
6. Back up the secrets directory to the `coforge` 1Password vault (item
   "CoForge production host secrets"). Losing
   `coforge_agent_credential_encryption_key` makes stored Agent credentials
   unreadable.
7. Set up the GitHub `production` Environment (below) and deploy through the
   workflow.

### Secrets directory

| File | Contents |
| --- | --- |
| `database_url` | Full PostgreSQL URL for the managed RDS instance, `postgresql://<user>:<password>@<host>:5432/<database>`. Written verbatim into `.env` as `DATABASE_URL`. |
| `redis_url` | Full Redis URL, `redis://<instance-id>:<password>@<host>:6379`. Written verbatim into `.env` as `REDIS_URL`, and read by Centrifugo as a secret. |
| `centrifugo_token_hmac_secret_key` | Centrifugo client-token HMAC key (`openssl rand -hex 32`). |
| `centrifugo_http_api_key` | Centrifugo HTTP API key (`openssl rand -hex 32`). |
| `centrifugo_proxy_secret` | Shared secret for Centrifugo proxy calls into Web (`openssl rand -hex 32`). |
| `worker_jwt_private_jwk` | Ed25519 private JWK, single-line JSON, for daemon-runtime tokens. |
| `worker_jwt_key_id` | Stable key id for the JWK, for example `coforge-production`. |
| `authing_app_id` | Authing application id in the production user pool (`coforge-cn.authing.cn`). |
| `authing_app_secret` | Authing application secret. |
| `coforge_session_secret` | Web session secret (at least 32 characters). |
| `coforge_agent_credential_encryption_key` | Encryption key for stored Agent credentials. |
| `coforge_web_push_public_key` | VAPID public key (P-256). |
| `coforge_web_push_private_key` | VAPID private key (P-256). |
| `coforge_file_delivery_key` | CDN URL-auth primary key for `files.coforge.cn`. Not an OSS credential. |

Generate the VAPID pair once in a controlled operator environment and keep it
in the approved secret store. Do not generate it on each host bootstrap.

### Redis URL needs the username

Managed Redis instances authenticate with an account name. A password-only URL
(`redis://:<password>@host`) authenticates as the `default` account, which may
not exist or may hold other permissions. Use the instance-scoped username
(the instance id) in the URL: `redis://<instance-id>:<password>@<host>:6379`.

## Deploy

Run **Deploy Web (production)** (`.github/workflows/deploy-production.yml`)
with the full digest of a Web image that is already healthy in staging:

```
gh workflow run deploy-production.yml -f image=ghcr.io/lrm-lab/coforge/coforge-web@sha256:...
```

The first job finds a successful staging deployment record of that exact
digest and fails otherwise. The deploy job waits for a required reviewer of
the `production` Environment to approve, then ships the Compose assets, logs
the host in to GHCR with the run's short-lived token, runs
`scripts/deploy/remote-deploy.sh --project coforge-production`, logs out, and
checks `https://coforge.cn/health`, the WebSocket endpoint, and that port 80
stays closed. The script validates the Compose file, the Centrifugo config,
and the Caddyfile with their pinned images before recreating anything, runs
the Prisma migration, and rolls back to the last healthy release on failure.

The workflow never syncs secrets: the host's secrets directory is the source
of truth, backed up in 1Password.

### GitHub `production` Environment

| Kind | Name | Value |
| --- | --- | --- |
| Protection | Required reviewers | Frank |
| Variable | `DEPLOY_SSH_HOST` | Production ECS public address |
| Variable | `DEPLOY_SSH_USER` | `deploy` |
| Secret | `DEPLOY_SSH_KEY` | Private half of an ed25519 key used only for this deploy; its public half is in `~deploy/.ssh/authorized_keys` |
| Secret | `DEPLOY_SSH_HOST_KEY` | The host's ed25519 public host key (`<type> <key>`) |

## Not yet covered

- Production CDN and OSS provisioning details are in
  [`docs/operations/aliyun-oss-cdn/`](../aliyun-oss-cdn/README.md); the release
  feed's are in [`computer-release.md`](computer-release.md).
