# Staging desktop reverse tunnel

Staging Web/Caddy runs on the public ECS (`DEPLOY_SSH_HOST`, currently
`101.200.210.144`). The Swarm manager and `coforge-computer host` (desktop
proxy on `:6090`) stay on the Lenovo intranet and are not reachable from that
ECS. Staging therefore keeps an **outbound SSH reverse tunnel** from the Swarm
manager to the ECS loopback, plus a **host relay** on the ECS private IP so
Compose Caddy can reach it.

Product path after this is in place:

`Browser → https://staging.coforge.cn/desktop/... → Caddy forward_auth → ECS private IP:16090 → relay → 127.0.0.1:16090 → tunnel → intranet :6090`

Do not publish `:16090` on the ECS public interface. The SSH remote forward must
bind `127.0.0.1` only. Compose containers cannot dial that loopback address, and
on this host they also cannot dial `docker0` / `host.docker.internal`
(`host-gateway`); they can dial the ECS primary private IP.

## One-time: tunnel SSH key

On the Swarm manager (not the deploy private key from GitHub):

```sh
install -d -m 700 ~/.coforge-host
ssh-keygen -t ed25519 -f ~/.coforge-host/staging-desktop-tunnel -N '' \
  -C "coforge-staging-desktop-tunnel"
cat ~/.coforge-host/staging-desktop-tunnel.pub
```

Append that public key to `deploy`'s `authorized_keys` on the ECS (one-time SSH
with the staging deploy key, or any operator who can log in as `deploy`):

```sh
# From a machine that can already `ssh deploy@101.200.210.144`:
pubkey='ssh-ed25519 AAAA... coforge-staging-desktop-tunnel'
ssh deploy@101.200.210.144 "mkdir -p ~/.ssh && chmod 700 ~/.ssh &&
  grep -qxF '$pubkey' ~/.ssh/authorized_keys 2>/dev/null ||
  echo '$pubkey' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Prefer a restricted `authorized_keys` line when your OpenSSH version supports
it (`restrict,port-forwarding,...`). Never commit the private key; never reuse
`DEPLOY_SSH_KEY` on the Swarm manager.

## Install the public key on the ECS via GitHub

After generating the key on the Swarm manager:

```sh
gh variable set STAGING_DESKTOP_TUNNEL_PUBLIC_KEY --env staging --repo lrm-lab/coforge \
  < ~/.coforge-host/staging-desktop-tunnel.pub
```

`Deploy Web (staging)` appends that line to `deploy`'s `authorized_keys`
(idempotent). The dedicated workflow
`install-staging-desktop-tunnel-key.yml` does the same without a full deploy
once it exists on `main`.

## Swarm manager: systemd unit

Prefer the **user** unit when passwordless `sudo` is unavailable:
[`coforge-staging-desktop-tunnel.user.service`](../../../infra/staging/desktop-tunnel/coforge-staging-desktop-tunnel.user.service).

```sh
mkdir -p ~/.config/systemd/user
cp infra/staging/desktop-tunnel/coforge-staging-desktop-tunnel.user.service \
  ~/.config/systemd/user/coforge-staging-desktop-tunnel.service
systemctl --user daemon-reload
systemctl --user enable --now coforge-staging-desktop-tunnel.service
systemctl --user is-active coforge-staging-desktop-tunnel.service
# Survive logout (needs one sudo):
sudo loginctl enable-linger "$USER"
```

System unit (needs sudo):
[`coforge-staging-desktop-tunnel.service`](../../../infra/staging/desktop-tunnel/coforge-staging-desktop-tunnel.service).

Both run:

`ssh -N -R 127.0.0.1:16090:127.0.0.1:6090 deploy@101.200.210.144`

with `ExitOnForwardFailure` and `Restart=always`. The Swarm manager must be
allowed to open outbound TCP 22 to the ECS.

## ECS: private-IP relay (deploy user)

On the ECS, as `deploy`, install the relay next to the tunnel listener:

```sh
install -d -m 755 ~/bin ~/.config/systemd/user
cp infra/staging/desktop-tunnel/desktop-tunnel-docker-relay.py \
  ~/bin/desktop-tunnel-docker-relay.py
chmod 755 ~/bin/desktop-tunnel-docker-relay.py
cp infra/staging/desktop-tunnel/coforge-staging-desktop-docker-relay.user.service \
  ~/.config/systemd/user/coforge-staging-desktop-docker-relay.service
systemctl --user daemon-reload
systemctl --user enable --now coforge-staging-desktop-docker-relay.service
systemctl --user is-active coforge-staging-desktop-docker-relay.service
```

The relay auto-detects the primary private IP (override with
`RELAY_LISTEN_HOST`). Keep security groups closed for `:16090` from the public
Internet; only Compose on this host should reach that address.

## Compose on the ECS (GitHub Deploy Web)

`infra/staging/docker-compose.yml` sets:

- `COFORGE_CLOUD_DESKTOP_ORIGIN: https://staging.coforge.cn`
- `COFORGE_DESKTOP_UPSTREAM: ${COFORGE_DESKTOP_HOST_GATEWAY}:16090`

`write_deploy_env` records the ECS private IP as `COFORGE_DESKTOP_HOST_GATEWAY`
in Compose `.env` on every deploy. Deploy with the usual
`Deploy Web (staging)` workflow after the tunnel and relay are up. If either is
down, owner-authorized `/desktop` requests 502.

## Host proxy secret

After Caddy reaches `:6090` through the tunnel, run a `coforge-computer host`
build that enforces `X-Coforge-Desktop-Proxy-Secret`, with
`COFORGE_CLUSTER_TOKEN` equal to staging `COFORGE_CLOUD_CLUSTER_TOKEN`. Turn
the gate on only after the tunnel, relay, and site origin are healthy; otherwise
the proxy answers `forbidden`.

## Checks

On the ECS (as `deploy`):

```sh
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 3 http://127.0.0.1:16090/
gw=$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 3 "http://$gw:16090/"
docker exec coforge-staging-caddy-1 wget -qO- --timeout=3 -S \
  "http://$gw:16090/" 2>&1 | head
```

A connection failure on loopback means the tunnel is down. Loopback OK but Caddy
failing means the relay is down. On the Swarm manager,
`journalctl --user -u coforge-staging-desktop-tunnel.service -n 50`.

From a browser: signed-out `https://staging.coforge.cn/desktop/...` is 401/403;
the computer owner gets the desktop page (not 502).
