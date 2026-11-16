# Cloud computer image (Swarm)

Production and staging **cloud Computer** images for CoForge Swarm. The Swarm
manager's `host` process tags services with `COFORGE_COMPUTER_IMAGE` (for example
`coforge-computer:staging`); this tree builds that tag.

Moved from `exp-repair/create_docker_image_for_pi` (Swarm path only). Cube /
Multica sandbox templates stay in that repository and are not used here.

The thin image under `packages/computer/docker/` is for local/fixture use only.
It is not the image Swarm runs in staging or production.

## Build

On the Swarm manager (or any host that will `docker load` / already shares the
engine with the manager):

```bash
cd infra/cloud-computer-image
cp config/coforge.env.example config/coforge.env
# set COFORGE_ENV=staging or production
cp config/pi.env.example config/pi.env
# set LENOVO_DEEPSEEK_V4_FLASH_API_KEY (baked into the image; never commit pi.env)

./scripts/build-swarm.sh
# or: COFORGE_ENV=production ./scripts/build-swarm.sh
```

`build-swarm.sh` loads `config/coforge.env` and `config/environments/<env>.env`,
resolves the feed's `latest` version and its sha256, reuses
`coforge/coforge-computer` when that checksum already matches, otherwise
downloads, verifies cloud-host bake, then builds the Dockerfile. The result is
tagged `coforge-computer:staging` or `coforge-computer:production`. Set
`COFORGE_COMPUTER_FORCE_DOWNLOAD=1` to always re-download.

Optional on the build machine: `config/pi-agent/models.json` (gitignored)
overrides the baked DeepSeek config with a known-good local copy. Do not commit
it or push the image to a public registry.

## Layout

| Path | Role |
| --- | --- |
| `Dockerfile` | Swarm computer image; entrypoint `entrypoint-foreground.sh` → `coforge-computer foreground` |
| `scripts/build-swarm.sh` | Environment-aware build entry |
| `scripts/build.sh` | Feed download + `docker build` |
| `config/environments/` | Staging / production feed, cloud host, image tag |
| `coforge/` | Staged binary from the feed (gitignored except `.gitkeep`) |

Operator steps: [staging](../../docs/operations/cloud-swarm/staging-bring-up.md),
[production](../../docs/operations/cloud-swarm/production-bring-up.md),
[cluster overview](../../docs/operations/cloud-swarm/README.md).

## Secrets

- `config/pi.env`, `config/coforge.env`, and `config/pi-agent/models.json` are
  gitignored.
- The DeepSeek API key is passed as a Docker build-arg and ends up in image
  layers; treat the resulting image as private to the Swarm nodes.
- Cluster tokens and daemon keys never belong in this tree.
