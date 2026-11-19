# Cloud computer image

Rules for `infra/cloud-computer-image/`, the Swarm staging/production Computer
image. Complements [container host](../../docs/computer/container-host.md) and
[cloud-swarm](../../docs/operations/cloud-swarm/README.md).

- This tree owns the image Swarm runs (`coforge-computer:staging` /
  `coforge-computer:production`). `packages/computer/docker/Dockerfile` is a
  local/fixture image only; do not point `COFORGE_COMPUTER_IMAGE` at it.
- Build with `./scripts/build-swarm.sh` from this directory. The script downloads
  `coforge-computer` from the environment's release feed; it does not compile
  from the monorepo workspace.
- Never commit `config/pi.env`, `config/coforge.env`, or
  `config/pi-agent/models.json`. Do not push the built image to a public
  registry while it carries baked provider keys.
- Do not reintroduce Cube / Multica sandbox packaging here; that stays outside
  this repository.
- Changing the entrypoint, desktop/VNC ports, or `systemctl` shim must stay
  compatible with `packages/computer` `host/` placement and the desktop proxy.
- The shared desktop (display `:1`) starts with the container and stays up.
  Agent screens remain on-demand. Do not reintroduce idle shutdown of the
  shared desktop without an explicit product decision (`VNC_IDLE_SECONDS=0`
  is the default).
