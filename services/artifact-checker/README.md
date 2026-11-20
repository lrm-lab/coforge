# Artifact Checker Sidecar

Isolated Node + Playwright (Chromium-only) HTTP worker that renders published HTML artifacts across
`desktop` (1280×800), `phone` (390×844 @2x), and `inline` (672×800 with `--coforge-*` tokens)
viewports, captures screenshots, and collects layout and console findings.

## Why a sidecar

- Keeps Chromium out of the `apps/web` image and memory space.
- Enforces hard container limits (`mem_limit: 1g`, `shm_size: 256m`, default concurrency `1`).
- Closes Chromium automatically after 60 seconds of idle time (`CHECKER_IDLE_CLOSE_MS`), dropping
  resident memory to ~35 MB between pushes.
- Serves artifact files purely from memory on synthetic `https://a-<artifactId>.coforge.check`
  via Playwright `context.route`, allowing only that origin plus the configured public CDNs and
  aborting all other network requests (SSRF-safe without wildcard DNS or TLS).

## Endpoints

- `GET /health` — readiness status, active/queued job count, Chromium state, RSS MB, and uptime.
- `POST /check` — requires `Authorization: Bearer <COFORGE_ARTIFACT_CHECK_SECRET>` when the secret
  is set. Accepts the bundled version payload from `apps/web` and returns `{ findings, screenshots,
  metrics }`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3100` | Listen port |
| `COFORGE_ARTIFACT_CHECK_SECRET` | `""` | Shared Bearer secret matching `apps/web` |
| `CHECKER_MAX_CONCURRENCY` | `1` | Max simultaneous browser checks (`1`–`4`) |
| `CHECKER_IDLE_CLOSE_MS` | `60000` | Idle milliseconds before closing Chromium |

## Structured logs

Emits one-line JSON events to stdout/stderr:

- `artifact_checker.started`
- `artifact_checker.browser_launched`, `artifact_checker.browser_idle_closed`
- `artifact_checker.job_started`, `artifact_checker.job_completed`, `artifact_checker.job_failed`
- `artifact_checker.auth_rejected`, `artifact_checker.queue_full`

## Local build and deployment

Enabled by default in local Compose ([`infra/docker-compose.yml`](../../infra/docker-compose.yml)),
staging (`.github/workflows/deploy-staging.yml`), and production
(`.github/workflows/deploy-production.yml`). Staging builds the sidecar via
`.github/workflows/artifact-checker-image.yml`, passes its immutable digest to
`scripts/deploy/remote-deploy.sh --checker-image`, attaches `infra/artifact-checker.compose.yml`,
and derives `COFORGE_ARTIFACT_CHECK_SECRET` automatically when no explicit host secret file exists.

Standalone smoke test:

```bash
docker build -t coforge-artifact-checker services/artifact-checker
docker run --rm -p 3100:3100 --shm-size=256m --memory=1g \
  -e COFORGE_ARTIFACT_CHECK_SECRET=dev-secret \
  coforge-artifact-checker
curl -s http://127.0.0.1:3100/health
```
