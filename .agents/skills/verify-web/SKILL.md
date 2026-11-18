---
name: verify-web
description: "Run this worktree's Web app with working realtime and drive it in a browser to see a change work: one command gives the worktree its own database, ports and Centrifugo, builds, seeds and serves it; several worktrees verify at once."
when_to_use: "see a UI or realtime change working before pushing, screenshots for UI-Evidence, reproduce a bug in the running app, check that a page updates live"
---

# Verify in the running Web app

Use this after the tests pass and before the full suite, for any change a person sees or that
reaches a page over realtime. It stands in for the built-in `run` and `/verify` skills here.

## Start

1. The managed stack must be up (`amp orb services ensure`): Postgres 5432, Redis 6379, Centrifugo 8000.
   A worktree without `infra/secrets` uses the main clone's; do not copy or link them in.
2. Run `scripts/e2e/verify-web.sh` from the worktree root, in the background. Wait for its
   `VERIFY READY <worktree> <url>` line (a build takes a few minutes); the URL is also in
   `.amp/verify/url` while it runs. Open `<url>/<locale>/w/dev-user`; you are signed in as Dev User.

What the script settles, so you do not have to, and so several Agents can verify at once:

- Its own database `coforge_verify_<worktree>_<hash>`, created if missing, migrated and seeded.
- Its own port block (front door, Web, Centrifugo), derived from the worktree name and moved on if
  taken (claimed under `$TMPDIR/coforge-verify-ports`), and its own Centrifugo container
  (`coforge-verify-<worktree>-<hash>-centrifugo`, its own Redis prefix) pointed at this Web; the
  managed stack's Centrifugo on 8000 is not used. The Web's own Redis keys and channels (cache
  flushes, rate limits) are still shared with every other run.
- The Worker key id is derived from this worktree's key (`scripts/e2e/worker-key-id.ts`).
- The page's one origin is the front door, with `/connection/*` proxied to Centrifugo; artifact
  sandbox pages use `localhost` on the same port, as in CI. Everything binds to 127.0.0.1.
- READY prints only once the Web and the front door answer `/health`; the script exits when either
  stops. A run killed with SIGKILL leaves its container behind: `docker rm -f` it.

## Check

- Realtime is connected when the sidebar shows no "离线"/"Offline" and
  `docker logs --since 2m <its container>` has no `invalid token` line.
- To see a live update, change data from another process while the page is open: a short
  `bun` script under `apps/web` that calls the same server entry point the browser uses (for a
  Task, `browserTaskBoard(db).execute(...)`), run with the same environment: source
  `scripts/e2e/e2e-env.sh` with `COFORGE_E2E_DATABASE`, and set `COFORGE_CENTRIFUGO_API_URL` to
  the Centrifugo port the READY line names. Delete the script before committing.
- Drive and capture with `ego-browser` (load its skill): light, dark (`localStorage`
  `coforge-theme`), and phone width via `Emulation.setDeviceMetricsOverride` at 390px, in one
  script per capture so the emulation holds.
- Rebuild after a source change: stop the script and start it again.

## Finish

Stop the script with `kill <its pid>` (started in the background, it ignores SIGINT); the Web, the
front door, the Centrifugo container and the port claim go with it. Finish the browser space, and
drop the database once the change is on `main`:
`docker exec <postgres container> psql -U coforge -d postgres -c 'DROP DATABASE <its database> WITH (FORCE)'`.
