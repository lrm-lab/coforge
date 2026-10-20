# Enable, disable, and first initialization

Part of [OpenViking prototype runtime operations](README.md).

## Enable (explicit opt-in)

From the CoForge worktree, after the default Compose secrets already required
by [`infra/README.md`](../../../infra/README.md) exist:

```sh
umask 077
mkdir -p infra/secrets
chmod 0700 infra/secrets

# Write ov.conf without printing the key. Replace the placeholder by generating
# it in the same redirected write; do not echo it.
python3 - <<'PY'
import json, os, secrets
path = "infra/secrets/openviking_prototype_ov_conf"
if os.path.exists(path):
    raise SystemExit(f"{path} already exists; refusing to overwrite")
doc = {
    "server": {
        "host": "0.0.0.0",
        "port": 1933,
        "auth_mode": "api_key",
        "root_api_key": secrets.token_hex(32),
    },
    "storage": {
        "workspace": "/data",
        "agfs": {"backend": "local"},
        "vectordb": {"backend": "local"},
    },
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=2)
    fh.write("\n")
os.chmod(path, 0o644)
print("wrote ov.conf (root_api_key not printed)")
PY

# Host-download embedding weights. The container is treated as offline for
# model fetch; Compose bind-mounts this directory to
# /app/.cache/openviking/models.
mkdir -p infra/secrets/openviking_prototype_models
chmod 0700 infra/secrets/openviking_prototype_models
# Place the local-embed model files here on the host (do not commit them).

# Build the verified image: pinned e44ea6e base + local-embed layer
# (compile toolchain lives only in the Dockerfile build stage).
# Official hosted tags are not a substitute.
export COFORGE_CAUSAL_MEMORY_IMAGE="${COFORGE_CAUSAL_MEMORY_IMAGE:?set the default Compose image first}"
export COFORGE_OPENVIKING_PROTOTYPE_IMAGE="${COFORGE_OPENVIKING_PROTOTYPE_IMAGE:?set the local e44ea6e+local-embed tag}"

docker compose -p coforge \
  -f infra/docker-compose.yml \
  -f infra/compose.openviking-prototype.yml \
  --profile openviking-prototype \
  up -d openviking-prototype
```

Wait for warmup (about 2–4 minutes, CPU full) before any data-plane request.
Confirm from the development host only:

```sh
docker compose -p coforge \
  -f infra/docker-compose.yml \
  -f infra/compose.openviking-prototype.yml \
  --profile openviking-prototype \
  ps openviking-prototype

curl --fail --silent --show-error http://127.0.0.1:${OPENVIKING_PROTOTYPE_PORT:-1933}/health
# Require /ready after warmup. Do not treat a live /health as request-ready
# during the 2–4 minute CPU spike.
curl --fail --silent --show-error http://127.0.0.1:${OPENVIKING_PROTOTYPE_PORT:-1933}/ready
```

Do not publish port 1933 on `0.0.0.0`. Do not add a Caddy route. Do not open
`/studio` against anything except this synthetic instance.

A host-run Web server that later consumes the runtime uses
`COFORGE_OPENVIKING_URL=http://127.0.0.1:${OPENVIKING_PROTOTYPE_PORT:-1933}`
and `OPENVIKING_PROTOTYPE_ENABLED=1`. A containerized Web server would use the
internal DNS name `http://openviking-prototype:1933` only after a separately
reviewed network attachment; this override does not attach `web` or Caddy.

## Disable

Stop the prototype service without deleting the volume:

```sh
docker compose -p coforge \
  -f infra/docker-compose.yml \
  -f infra/compose.openviking-prototype.yml \
  --profile openviking-prototype \
  stop openviking-prototype
```

Remove the container but keep the volume:

```sh
docker compose -p coforge \
  -f infra/docker-compose.yml \
  -f infra/compose.openviking-prototype.yml \
  --profile openviking-prototype \
  rm -f openviking-prototype
```

Unset `OPENVIKING_PROTOTYPE_ENABLED` on Web. Default `docker compose -f infra/docker-compose.yml up`
must keep working without this override.

Deleting the volume is destruction of the synthetic workspace, not a profile
`off` transition. Profile `off` retains data.

## First initialization

1. Create the ov.conf secret as above (`644` on the host). Do not add a remote
   embedding or LLM provider block. Local embedding uses the host-downloaded
   weights under `infra/secrets/openviking_prototype_models/`. Never put keys
   in Compose environment.
2. Set `COFORGE_OPENVIKING_PROTOTYPE_IMAGE` to the local tag built from
   `e44ea6e11add1c7b3d4accdbfaf16e900a6049df` plus
   `infra/docker/openviking-prototype-local-embed.Dockerfile`.
3. Start only `openviking-prototype` with the opt-in command above. Wait
   **2–4 minutes** for warmup, then require Compose healthy **and**
   `GET /ready` before any find/write/smoke.
4. Using a **root** key read from the secret file in-process (not pasted into
   argv), create one disposable synthetic account and an ADMIN user through
   typed admin APIs:
   - `POST /api/v1/admin/accounts` with `account_id` such as `synth-i1`
   - `POST /api/v1/admin/accounts/{account_id}/users/{user_id}/key` for the
     data-plane user
     Store issued user/admin keys in the same owner-only secrets directory.
     Official `api_key` mode: the root key cannot call tenant data APIs.
5. Do not reuse a real Workspace slug, production account, or production user
   id. Directory naming is not tenant isolation.
