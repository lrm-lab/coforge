# Default-off gates, ownership and secrets, and network

Part of [OpenViking prototype runtime operations](README.md).

## Default-off gates

Two independent gates keep the prototype off:

| Gate                           | Default                                                             | Enables                                                                                      |
| ------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Compose file + profile         | override file is unused; service has profile `openviking-prototype` | the container                                                                                |
| `OPENVIKING_PROTOTYPE_ENABLED` | unset / anything other than `1` or `true`                           | Web/backend prototype composition (`apps/web/src/server/workspace-memory/prototype-gate.ts`) |

Setting the Web flag without the Compose profile does not start OpenViking.
Starting the container without the Web flag must not enable production profile
behavior.

Official listen port is `1933`. Liveness is unauthenticated `GET /health`.
Readiness is unauthenticated `GET /ready` (AGFS, VectorDB, API key manager,
embedding, Ollama). Compose uses the image's `openviking-entrypoint --healthcheck`
(official Docker healthcheck).

## Ownership and secrets

| Key                                  | Consumer             | Purpose                                                                                                                 | Secret?   |
| ------------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------- |
| `COFORGE_OPENVIKING_PROTOTYPE_IMAGE` | prototype Compose    | reviewed local tag built from D3 revision `e44ea6e` plus the local-embed Dockerfile                                     | no        |
| `OPENVIKING_PROTOTYPE_PORT`          | prototype Compose    | loopback publish; default `1933`                                                                                        | no        |
| `OPENVIKING_CONFIG_FILE`             | runtime              | path of the mounted ov.conf secret (`/run/secrets/openviking_prototype_ov_conf`)                                        | path only |
| `openviking_prototype_ov_conf`       | runtime              | host secret file: `auth_mode=api_key`, generated `root_api_key`, `storage.workspace=/data`, local AGFS/VectorDB         | **yes**   |
| `openviking_prototype_models/`       | runtime              | host-downloaded embedding weights bind-mounted to `/app/.cache/openviking/models`                                       | **yes**   |
| `COFORGE_OPENVIKING_URL`             | host-run Web (later) | `http://127.0.0.1:${OPENVIKING_PROTOTYPE_PORT:-1933}`                                                                   | no        |
| `OPENVIKING_PROTOTYPE_ENABLED`       | Web server           | application prototype gate                                                                                              | no        |

Create secrets outside Git. `infra/secrets/` is gitignored. Directory mode
`0700` on the host.

**Verified secret-file mode is `644`.** Compose `secrets.*.mode: 0400` (and the
current `0444` declaration) does **not** change the file mode inside the
container; the process sees the host file mode. A host-only `0600` file is
unreadable by the container user. Set the ov.conf file to `644` on the host
so the container can read it. Restrict the host directory (`0700`) and do
not put the file in a world-readable tree. Never put `root_api_key`, user
keys, or embedding provider keys in:

- this repository, fixtures, or example JSON
- Compose YAML, labels, or command arguments
- browser, Agent, or Daemon environment
- shell history, CI logs, or `docker compose config` pasted into chat with the
  real value still present

Do **not** use `OPENVIKING_CONF_CONTENT` or `OPENVIKING_ROOT_API_KEY` as
container environment values. Those would place credential plaintext in the
process environment.

`api_key` mode is the prototype default because the official image binds
`0.0.0.0` and refuses to start without `server.root_api_key`. Later gateway
work may run `trusted` mode behind CoForge; this skeleton does not enable
`dev` (unauthenticated) mode. Root keys cannot access tenant data APIs in
`api_key` mode — provision a disposable ADMIN/USER key after first boot.

## Resource and network envelope

The prototype service is limited to **2 CPU** and **2 GiB RAM**. It has
`no-new-privileges`, drops Linux capabilities, writes only
`coforge_openviking_prototype_data` plus a temporary filesystem, and joins the
`openviking` / `coforge_openviking_prototype` bridge. Caddy is not connected
to that bridge. The published port is `127.0.0.1` only and is not a public
route.

**Verified network: `internal: false`.** Docker cannot publish host ports on
an `internal: true` network, so the earlier I1 draft (`internal: true`)
blocked `127.0.0.1:1933` diagnostics and V1.4/F6. The override now uses a
non-internal bridge. Egress containment is **not** a Docker internal-network
guarantee; it is operational: local embedding (`llama-cpp` + preloaded
weights) and no remote LLM / embedding provider in ov.conf. Do not attach
Caddy or join `coforge_network`. Image pulls and model downloads happen on
the host; treat the container as offline for model fetch.

**Warmup:** after `up -d`, the process spends about **2–4 minutes** at full
CPU loading local embedding. `GET /health` may succeed before the service can
answer data-plane requests. Wait until the Compose healthcheck is healthy
**and** `/ready` reports embedding ready before V1.4, F6, or any
`/search/find`. Do not send traffic during warmup.

Capacity review starts when sustained memory exceeds 70% of the limit,
liveness/readiness failures repeat, or the volume reaches 70%. Do not scale
this service horizontally: one environment has one local-VectorDB runtime.
