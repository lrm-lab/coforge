# OpenViking prototype runtime operations

> **NON-PRODUCTION / LICENSE-REVIEW-REQUIRED**
>
> The local OpenViking source is AGPL-3.0 and has **not** received project-level
> approval for a distributable product integration (approval ledger
> `AGPL license / shipping` is still **pending** and user-owned).
> This runbook is an isolated, synthetic-data-only prototype. It is not a
> release, staging, or production procedure. Do not add OpenViking to default
> Compose, release manifests, staging, or production. Do not present this
> runtime as a shippable CoForge capability.

This runbook delivers I1 of the
historical OpenViking + Causal Memory profiles plan (retired to git history with the repository's
implementation slices), superseded by [OpenViking channel memory](../../memory/openviking.md).
It applies to one local development machine. The only added runtime is the
private `openviking-prototype` HTTP service declared in
[`infra/compose.openviking-prototype.yml`](../../../infra/compose.openviking-prototype.yml).

Pinned inventory (D3): OpenViking
`e44ea6e11add1c7b3d4accdbfaf16e900a6049df`
([interface inventory](../../research/openviking-prototype-interface-inventory/README.md)).
Bump that pin only with a new inventory, not a silent `main` follow.

Verified image for I1/V1.4/F6: that pin **plus** a local-embed extension layer
built from
[`infra/docker/openviking-prototype-local-embed.Dockerfile`](../../../infra/docker/openviking-prototype-local-embed.Dockerfile)
(adds `llama-cpp-python` and a compile toolchain; does not patch OpenViking
source). Tag the result locally; do not substitute an official hosted
`:latest`.

This runbook records the **verified** prototype envelope (2026-09-22), not the
earlier I1 draft assumptions. Compose `secrets.mode: 0400` does not take
effect; the Docker prototype network is **not** `internal: true`; embedding
models are host-downloaded and bind-mounted. See the secrets and network
sections in [gates-secrets-network.md](gates-secrets-network.md) and warmup in
[enable-disable.md](enable-disable.md). This is still not a release procedure.

## What this override does not do

- It does **not** change [`infra/docker-compose.yml`](../../../infra/docker-compose.yml),
  [`infra/docker-compose.centrifugo.yml`](../../../infra/docker-compose.centrifugo.yml),
  [`infra/staging/docker-compose.yml`](../../../infra/staging/docker-compose.yml),
  Caddyfiles, or any release manifest.
- It does **not** declare a Caddy service or a public reverse-proxy route.
- It does **not** start when you run the default Compose project.
- It does **not** accept production Workspace data, production credentials, or
  non-synthetic fixtures.

Web/backend remains the only intended client, through the later deny-by-default
policy gateway. Browsers, `coforge-computer`, `coforge-daemon`, Agent processes,
and CLI arguments must never receive OpenViking administration credentials.

## Topics

- [Default-off gates, ownership and secrets, and network](gates-secrets-network.md): default-off gates, ownership and secrets, and the resource and network envelope.
- [Enable, disable, and first initialization](enable-disable.md): explicit opt-in, disable, and first initialization.
- [Synthetic seed, cleanup, backup, and restore](data-lifecycle.md): synthetic seed and cleanup; backup, restore, and reindex.
- [Known issues and the C4 tag/filter round-trip](known-issues.md): known issues of OpenViking `e44ea6e` and the C4 tag/filter round-trip (V1.4 verdict).
- [F6 smoke and acceptance checklist](smoke-and-acceptance.md): the F6 opt-in real OpenViking smoke and the acceptance checklist.
