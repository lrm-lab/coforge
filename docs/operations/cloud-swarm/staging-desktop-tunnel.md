# Staging desktop reverse tunnel

Staging Web/Caddy runs on the public ECS (`DEPLOY_SSH_HOST`, currently
`101.200.210.144`). The Swarm manager and `coforge-computer host` (desktop
proxy on `:6090`) stay on the Lenovo intranet and are not reachable from that
ECS. Staging therefore keeps an **outbound SSH reverse tunnel** from the Swarm
manager to the ECS loopback, and Caddy reaches it as
`host.docker.internal:16090`.

Product path after this is in place:

`Browser → https://staging.coforge.cn/desktop/... → Caddy forward_auth → host.docker.internal:16090 → tunnel → intranet :6090`

Do not publish `:16090` on the ECS public interface. The remote forward must
bind `127.0.0.1` only.

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
gh workflow run install-staging-desktop-tunnel-key.yml --repo lrm-lab/coforge --ref main
```

The workflow SSHs as `deploy` with `DEPLOY_SSH_KEY` and appends the pubkey to
`authorized_keys` (idempotent).

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

## Compose on the ECS (GitHub Deploy Web)

`infra/staging/docker-compose.yml` sets:

- `COFORGE_CLOUD_DESKTOP_ORIGIN: https://staging.coforge.cn`
- `COFORGE_DESKTOP_UPSTREAM: host.docker.internal:16090`
- Caddy `extra_hosts: host.docker.internal:host-gateway`

Deploy with the usual `Deploy Web (staging)` workflow after the tunnel is up.
If the tunnel is down, owner-authorized `/desktop` requests 502.

## Host proxy secret

After Caddy reaches `:6090` through the tunnel, run a `coforge-computer host`
build that enforces `X-Coforge-Desktop-Proxy-Secret`, with
`COFORGE_CLUSTER_TOKEN` equal to staging `COFORGE_CLOUD_CLUSTER_TOKEN`. Turn
the gate on only after the tunnel and site origin are healthy; otherwise the
proxy answers `forbidden`.

## Checks

On the ECS (as `deploy`):

```sh
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 3 http://127.0.0.1:16090/
```

A connection failure means the tunnel is down. On the Swarm manager,
`journalctl -u coforge-staging-desktop-tunnel.service -n 50`.

From a browser: signed-out `https://staging.coforge.cn/desktop/...` is 401/403;
the computer owner gets the desktop page (not 502).
