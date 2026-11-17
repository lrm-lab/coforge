# Production desktop reverse tunnel

Production Web/Caddy runs on the public ECS (`DEPLOY_SSH_HOST`, currently
`123.56.79.233`). The Swarm manager and `coforge-computer host` (desktop
proxy on `:6090`) stay on the Lenovo intranet (`10.110.158.147`) and are not
reachable from that ECS. Production therefore keeps an **outbound SSH reverse
tunnel** from the Swarm manager to the ECS loopback, plus a **host relay** on
the ECS private IP so Compose Caddy can reach it.

Product path after this is in place:

`Browser → https://coforge.cn/desktop/... → Caddy forward_auth → ECS private IP:16090 → relay → 127.0.0.1:16090 → tunnel → intranet :6090`

Do not publish `:16090` on the ECS public interface. The SSH remote forward must
bind `127.0.0.1` only. Compose containers cannot dial that loopback address, and
on this host they also cannot dial `docker0` / `host.docker.internal`
(`host-gateway`); they can dial the ECS primary private IP.

## One-time: tunnel SSH key

On the Swarm manager (not the deploy private key from GitHub):

```sh
install -d -m 700 ~/.coforge-host
ssh-keygen -t ed25519 -f ~/.coforge-host/production-desktop-tunnel -N '' \
  -C "coforge-production-desktop-tunnel"
cat ~/.coforge-host/production-desktop-tunnel.pub
```

Never commit the private key; never reuse `DEPLOY_SSH_KEY` on the Swarm
manager; never share the staging tunnel key with production.

## Install the public key on the ECS via GitHub

After generating the key on the Swarm manager:

```sh
gh variable set PRODUCTION_DESKTOP_TUNNEL_PUBLIC_KEY --env production --repo lrm-lab/coforge \
  < ~/.coforge-host/production-desktop-tunnel.pub
```

`Deploy Web (production)` appends that line to `deploy`'s `authorized_keys`
(idempotent). The dedicated workflow
`install-production-desktop-tunnel-key.yml` does the same without a full deploy.

## Swarm manager: systemd unit

Prefer the **user** unit when passwordless `sudo` is unavailable:
[`coforge-production-desktop-tunnel.user.service`](../../../infra/production/desktop-tunnel/coforge-production-desktop-tunnel.user.service).

```sh
mkdir -p ~/.config/systemd/user
cp infra/production/desktop-tunnel/coforge-production-desktop-tunnel.user.service \
  ~/.config/systemd/user/coforge-production-desktop-tunnel.service
systemctl --user daemon-reload
systemctl --user enable --now coforge-production-desktop-tunnel.service
systemctl --user is-active coforge-production-desktop-tunnel.service
# Survive logout (needs one sudo):
sudo loginctl enable-linger "$USER"
```

System unit (needs sudo):
[`coforge-production-desktop-tunnel.service`](../../../infra/production/desktop-tunnel/coforge-production-desktop-tunnel.service).

Both run:

`ssh -N -R 127.0.0.1:16090:127.0.0.1:6090 deploy@123.56.79.233`

with `ExitOnForwardFailure` and `Restart=always`. The Swarm manager must be
allowed to open outbound TCP 22 to the ECS.

## ECS: private-IP relay (deploy user)

`Deploy Web (production)` copies the relay script and user unit onto the ECS
and enables them. Manual install (same files):

```sh
install -d -m 755 ~/bin ~/.config/systemd/user
cp infra/production/desktop-tunnel/desktop-tunnel-docker-relay.py \
  ~/bin/desktop-tunnel-docker-relay.py
chmod 755 ~/bin/desktop-tunnel-docker-relay.py
cp infra/production/desktop-tunnel/coforge-production-desktop-docker-relay.user.service \
  ~/.config/systemd/user/coforge-production-desktop-docker-relay.service
systemctl --user daemon-reload
systemctl --user enable --now coforge-production-desktop-docker-relay.service
systemctl --user is-active coforge-production-desktop-docker-relay.service
```

The relay auto-detects the primary private IP (override with
`RELAY_LISTEN_HOST`). Keep security groups closed for `:16090` from the public
Internet; only Compose on this host should reach that address.

## Compose on the ECS (GitHub Deploy Web)

`infra/production/docker-compose.yml` sets:

- `COFORGE_CLOUD_DESKTOP_ORIGIN: https://coforge.cn`
- `COFORGE_DESKTOP_UPSTREAM: ${COFORGE_DESKTOP_HOST_GATEWAY}:16090`

`write_deploy_env` records the ECS private IP as `COFORGE_DESKTOP_HOST_GATEWAY`
in Compose `.env` on every deploy. Deploy with the usual
`Deploy Web (production)` workflow after the tunnel and relay are up. If either is
down, owner-authorized `/desktop` requests 502.

## Host proxy secret

After Caddy reaches `:6090` through the tunnel, run a `coforge-computer host`
build that enforces `X-Coforge-Desktop-Proxy-Secret`, with
`COFORGE_CLUSTER_TOKEN` equal to production `COFORGE_CLOUD_CLUSTER_TOKEN`. Turn
the gate on only after the tunnel, relay, and site origin are healthy; otherwise
the proxy answers `forbidden`.

## Checks

On the ECS (as `deploy`):

```sh
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 3 http://127.0.0.1:16090/
gw=$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 3 "http://$gw:16090/"
docker exec coforge-production-caddy-1 wget -qO- --timeout=3 -S \
  "http://$gw:16090/" 2>&1 | head
```

A connection failure on loopback means the tunnel is down. Loopback OK but Caddy
failing means the relay is down. On the Swarm manager,
`journalctl --user -u coforge-production-desktop-tunnel.service -n 50`.

From a browser: signed-out `https://coforge.cn/desktop/...` is 401/403;
the computer owner gets the desktop page (not 502).
