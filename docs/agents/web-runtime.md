# Web runtime and file boundaries

Part of [the documentation index](../../README.md). The rules live in
[`apps/web/AGENTS.md`](../../apps/web/AGENTS.md); this page holds the mechanics behind them.

## The runtime entry point

`src/server.ts` is the runtime entry point. Keep it limited to request middleware and the Start
server handler; do not put feature behavior there.

Nitro loads it on the first request, not at boot. Boot-time work (failing a bad deployment
configuration) belongs to a Nitro plugin registered in `vite.config.ts`
(`src/server/runtime/boot-config-check.server.ts`); the plugin runs in Nitro's environment, whose
module state is separate from the SSR one's, so it only validates a copy of the environment.

Shutdown on SIGTERM/SIGINT is `src/server/runtime/server-lifecycle.server.ts`: whoever starts a timer
or opens a long-lived handle registers its stop with `onServerShutdown` where it starts it (open Redis
connections through `openRedisClient`, never `new RedisClient`), so the process can end.
`test/production.integration.ts` (run by the Dockerfile) pins the boot check and
`test/server-lifecycle.integration.ts` the shutdown.

## File naming and import protection

- `.functions.ts` for `createServerFn` wrappers (importable anywhere).
- `.server.ts` for server-only code; every TypeScript module under `src/server/` ends in
  `.server.ts` (data files such as the Manual topics are read only by those modules).
- No suffix for client-safe code.
- `vite.config.ts` import protection denies both `*.server.*` and `src/server/**` in the client build.
- Code the browser also needs (schemas, slugs, pure formatting) lives in the owning `features/`
  module or `src/lib/`, never in `src/server/`.
- Server Functions and function middleware live in `features/`, not `src/server/`.
- Import through `#src/`. Untitled UI's CLI writes `@/` imports; rewrite them to `#src/` when adding
  a component.

## The trailing blank line

CI's `Plan checks` job runs `git diff --check` over the whole diff, and one trailing blank line fails
the entire run. No package `check` looks for it, so the local checks stay green while the run goes
red. Deleting a file's last member strands the blank line that preceded it, so a deletion trips this
as easily as an addition. Reproduce what CI sees before pushing with
`git diff --check origin/main...HEAD`.
