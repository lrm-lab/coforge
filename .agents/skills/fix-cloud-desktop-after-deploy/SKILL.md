---
name: fix-cloud-desktop-after-deploy
description: >-
  Step-by-step: restore cloud desktop on the Swarm/host machine after a
  Web/Caddy deploy when ECS cannot reach intranet :6090 (owner gets 502) or
  the host gate returns forbidden. Use when production or staging desktop
  breaks after platform deploy, or the user asks what to configure on the
  cloud-computer server.
---

# Fix cloud desktop after platform deploy

After Web/Caddy deploy, 「打开桌面」goes to `https://<site>/desktop/...`
(Caddy `forward_auth`), then to `COFORGE_DESKTOP_UPSTREAM`. Lab topology:
platform on public ECS, `coforge-computer host` on intranet Lenovo (`:6090`).
ECS cannot dial `:6090` directly — the **host machine** must keep an SSH
reverse tunnel up.

- Staging: [`docs/operations/cloud-swarm/staging-desktop-tunnel.md`](../../../docs/operations/cloud-swarm/staging-desktop-tunnel.md)
- Production: [`docs/operations/cloud-swarm/production-desktop-tunnel.md`](../../../docs/operations/cloud-swarm/production-desktop-tunnel.md)

## 1. Read the symptom

| What you see | Cause | Do this |
| --- | --- | --- |
| Signed-out `/desktop` → 401/403 | Auth OK | Not a tunnel problem |
| Signed-in owner → **502** | ECS cannot reach upstream | Steps 2–4 below + ECS relay/upstream |
| **forbidden** | Host gate / token mismatch | Step 5 |
| `http://127.0.0.1:6090/` on host fails | Host down | Fix `coforge-host` first |

## 2. On the cloud-computer server: host must answer

```sh
systemctl is-active coforge-host.service
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 3 http://127.0.0.1:6090/
```

`/` often returns `404`; that still means the proxy is up.

## 3. On the cloud-computer server: SSH reverse tunnel

One dedicated key per environment (never `DEPLOY_SSH_KEY`, never share staging↔production).

User unit templates:

- Staging: [`infra/staging/desktop-tunnel/`](../../../infra/staging/desktop-tunnel/)
- Production: [`infra/production/desktop-tunnel/`](../../../infra/production/desktop-tunnel/)

```sh
ssh -N \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -i ~/.coforge-host/<env>-desktop-tunnel \
  -R 127.0.0.1:16090:127.0.0.1:6090 \
  deploy@<ECS_HOST>
```

Meaning: ECS `127.0.0.1:16090` → this machine `127.0.0.1:6090`. Remote side
must stay **loopback only** (do not bind `0.0.0.0`).

```sh
mkdir -p ~/.config/systemd/user
# copy the matching user unit, set IDENTITY / SSH_HOST for this env
systemctl --user daemon-reload
systemctl --user enable --now coforge-<env>-desktop-tunnel.service
sudo loginctl enable-linger "$USER"   # survive logout
```

## 4. Prove tunnel from the ECS

As `deploy` on the ECS:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 3 http://127.0.0.1:16090/
```

Fail → tunnel down (check host unit / journal). OK → host path works.

Caddy still cannot use `127.0.0.1` from a container. Each env also needs on ECS:

1. Relay: ECS private IP `:16090` → `127.0.0.1:16090`
2. `COFORGE_DESKTOP_UPSTREAM=${COFORGE_DESKTOP_HOST_GATEWAY}:16090`

## 5. Token (only if host enforces the proxy secret)

When the host build checks `X-Coforge-Desktop-Proxy-Secret`:

`~/.coforge-host/host.env` → `COFORGE_CLUSTER_TOKEN`
must equal ECS `coforge_cloud_cluster_token`
(Caddy `COFORGE_DESKTOP_PROXY_SECRET`).

Enable the gate only after tunnel + relay + site `/desktop` are healthy.

## 6. Browser check

- Signed-out `/desktop/...` → 401/403
- Owner → desktop page (not 502)

## Rules

- Separate keys/units/ECS hosts for staging and production.
- Never commit tunnel private keys or paste cluster tokens.
- Do not publish `:6090` or `:16090` on a public interface.
