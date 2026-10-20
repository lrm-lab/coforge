# F6 smoke and acceptance checklist

Part of [OpenViking prototype runtime operations](README.md).

## F6 opt-in real OpenViking smoke

The smoke is a synthetic-only, explicit opt-in file. It is **not** named
`*.test.ts` / `*.spec.ts`, so default `bun test` and `mise run test` never
collect it. Invoke it by path after the prototype container is healthy.

```sh
export OPENVIKING_SMOKE=1
export COFORGE_OPENVIKING_URL=http://127.0.0.1:${OPENVIKING_PROTOTYPE_PORT:-1933}
export OPENVIKING_PROTOTYPE_CONF=infra/secrets/openviking_prototype_ov_conf

# Optional citation persist (P3). Without a URL the citation step skipIfs.
# export MIGRATION_TEST_DATABASE_URL=...

mise run test:file -- ./apps/web/test/openviking-prototype.smoke.ts
```

The file loads `server.root_api_key` from the secret path **in-process**. Do
not export the key, put it on argv, or paste it into logs. A disposable
`smoke-<random>` account is provisioned through the typed admin channel,
exercises a real gateway find/resources round-trip, runs the F1
session→batch→commit→extract sequence, asserts `find(tags)` fact-id/version/
generation round-trip (URI + CM binding; do not use `GET /fs/attrs` for tags),
persists a citation when PostgreSQL is configured, then typed-deletes the
account in `finally`. Cleanup asserts DELETE accepted; `gone=` is logged
only.

Pinned evidence must name OpenViking
`e44ea6e11add1c7b3d4accdbfaf16e900a6049df` and the local-embed layer.

Recorded F6 run (2026-09-22, real container `http://127.0.0.1:1933`, after
warmup): `mise exec -- bun test ./apps/web/test/openviking-prototype.smoke.ts
--timeout 180000` **exit 0** (1 pass / 0 fail / 27 expect). Account
`smoke-b99079db4380`. `composeOpenVikingGatewayContext` stayed 401
fail-closed (no server-held credential ops wiring on the web splat route);
smoke used the policy-gateway + runtime-client seam and labeled that step.
Without opt-in env: 0 pass / 1 skip. Default bun discovery does not collect
`*.smoke.ts`.

## Acceptance checklist

- [ ] `docker compose -f infra/docker-compose.yml up` does not start OpenViking
- [ ] No Caddy service or public reverse-proxy route is added
- [ ] Host ov.conf is `644`; secrets directory is `0700`; Compose secret `mode`
      is not trusted
- [ ] Embedding weights exist under `infra/secrets/openviking_prototype_models/`
      before `up`; image is `e44ea6e` + local-embed
- [ ] Network is non-internal; port is `127.0.0.1` only; no remote LLM
- [ ] Warmup (2–4 min) finished and `/ready` passed before requests
- [ ] Credentials are absent from browser, Agent env, CLI args, logs, and fixtures
- [ ] Only synthetic account / document names are used
- [ ] Cleanup treats typed DELETE 202 as success; does not require registry gone
- [ ] Override `config` is additive relative to the default file (no removed
      default services, networks, or volumes)
- [ ] `OPENVIKING_PROTOTYPE_ENABLED` remains default-off on Web
- [ ] AGPL / shipping gate stays user-owned; this override is not a release claim
