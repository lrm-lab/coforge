# Artifact Checker Sidecar

Isolated Bun + Playwright (Chromium-only) HTTP worker that renders published HTML artifacts across
`desktop` (1280×800), `phone` (390×844 @2x), and `inline` (672×800 with `--coforge-*` tokens)
viewports, captures screenshots, and collects layout and console findings.

## Why a sidecar

- Keeps Chromium out of the `apps/web` image and memory space.
- Runs Chromium's namespace and Seccomp-BPF sandboxes as UID/GID 1000. The container is
  read-only, drops capabilities and caps memory, CPU, shared memory, and processes.
- Separates the checker from Web and data services with an internal network. Web calls it over
  a read-only mount of the private Unix socket. Chromium and Bun send CDN traffic through Squid.
  Squid allows HTTPS CONNECT to the CDN hosts in the sandbox CSP and rejects non-public
  destination addresses.
- Closes Chromium automatically after 60 seconds of idle time (`CHECKER_IDLE_CLOSE_MS`), dropping
  resident memory to ~35 MB between pushes.
- Serves artifact files purely from memory on synthetic `https://a-<artifactId>.coforge.check`
  via Playwright `context.route`, caching allowed public CDN fetches per check job and aborting
  all other network requests (SSRF-safe without wildcard DNS or TLS).

## Endpoints

Production serves these endpoints on the private Unix socket.

- `GET /health` — readiness status, active/queued job count, Chromium state, RSS MB, and uptime.
- `POST /check` — requires `Authorization: Bearer <COFORGE_ARTIFACT_CHECK_SECRET>` when the secret
  is set. Accepts the bundled version payload from `apps/web` and returns `{ findings, screenshots,
  metrics }`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `COFORGE_ARTIFACT_CHECK_WORKER_SOCKET` | unset | Absolute Unix socket path required in production |
| `COFORGE_ARTIFACT_CHECK_EGRESS_PROXY` | unset | HTTP proxy origin required in production |
| `PORT` | `3100` | Development TCP port |
| `COFORGE_ARTIFACT_CHECK_SECRET` | `""` | Shared Bearer secret matching `apps/web` |
| `CHECKER_MAX_CONCURRENCY` | `1` | Max simultaneous browser checks (`1`–`4`) |
| `CHECKER_IDLE_CLOSE_MS` | `60000` | Idle milliseconds before closing Chromium |
| `COFORGE_ARTIFACT_CHECK_DAILY_CAP` (on `web`) | `200` | Rolling 24-hour checks per workspace (`0` = unlimited) |

## Structured logs

Emits one-line JSON events to stdout/stderr:

- `artifact_checker.started`
- `artifact_checker.browser_launched`, `artifact_checker.browser_idle_closed`
- `artifact_checker.job_started`, `artifact_checker.job_completed`, `artifact_checker.job_failed`
- `artifact_checker.auth_rejected`, `artifact_checker.queue_full`

## Local build and deployment

Local Compose exposes the checker only when started with the `artifact-checker` profile.
Staging and production attach the checker overlay when the operator selects
`enable_artifact_checker` in the deployment workflow. Releases keep the checker image by immutable digest.
The deploy snapshot retains the overlay and Chromium's container seccomp profile for rollback.

The renderer profile is based on the [Moby default seccomp profile](https://github.com/moby/profiles/blob/2ab3e516a3b49550c35b5e4511a0a7d136a02c8d/seccomp/default.json).
It allows Chromium to use `clone`, `setns`, `unshare`, and `chroot` inside its container.
Only the browser container uses this profile.

Build the image from the repository root with
`docker build -f services/artifact-checker/Dockerfile .`. The image generates the proxy
allowlist from the Web sandbox CSP's CDN list.
