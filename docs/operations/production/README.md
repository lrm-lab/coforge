# coforge-production: cloud production environment

Status: **Compose environment and manual deploy path ready; the production
host, managed datastores, and secrets are provisioned by the operator.**

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
- **Release feed:** `https://releases.coforge.cn`.

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
   file mode 600.
5. Point DNS for `coforge.cn` at the ECS public address. TLS uses an ACME
   certificate over 443 (TLS-ALPN); there is no HTTP-01 path by design.
6. Run the first deployment by hand (below).

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
| `authing_app_id` | Authing application id for `coforge.authing.cn`. |
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

## Manual deploy

Run from the operator workstation with the release image digest. This mirrors
staging's bootstrap step; the script is the same, with the production project,
paths, and public health URL:

```
ssh deploy@production-host 'bash -s' < scripts/deploy/remote-deploy.sh -- \
  --image ghcr.io/lrm-lab/coforge/coforge-web@sha256:... \
  --project coforge-production \
  --compose-file ~/coforge-production/infra/production/docker-compose.yml \
  --secrets-dir ~/coforge-production/infra/production/secrets \
  --state-file ~/coforge-production/state.env \
  --web-health-url http://127.0.0.1:18080/health \
  --public-health-url https://coforge.cn/health
```

The script validates the Compose file, the Centrifugo config, and the Caddyfile
with their pinned images before recreating anything, runs the Prisma migration,
and rolls back to the last healthy release on failure. Its report contains no
secret values.

## Not yet covered

- Promotion through a GitHub `production` Environment, with the same
  exact-artifact gate as staging, is follow-up work. Until then every production
  deploy is a manual run of the command above.
- Production CDN and OSS provisioning details are in
  [`docs/operations/aliyun-oss-cdn/`](../aliyun-oss-cdn/README.md).
