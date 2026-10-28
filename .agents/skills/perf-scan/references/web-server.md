# web-server checklist

Scope: `apps/web/src/server/`.

## Read first

`apps/web/AGENTS.md` and `apps/web/src/server/AGENTS.md` (module maps), then the
owning module's own `AGENTS.md`.

Existing perf work exists: `*.integration.ts` plan tests, `server-timing-prisma`.
Check for it before reporting a query as unmeasured or unplanned.

## Hot paths

- Message send and list.
- Conversation list and sidebar.
- Centrifugo RPC and the publish proxy.
- Delivery fan-out.
- Inbox and nav attention.
- Task board.
- Records catalog.

## Patterns

- N+1: Prisma calls inside loops, `Promise.all` over per-row queries.
- Identical reads repeated within one request.
- Unbounded `findMany` without `take` or `select`; `include` that over-fetches
  large JSON or body columns.
- Independent awaits run sequentially.
- Work done while holding a row lock or inside a transaction that could run
  before or after it.
- A count where a boolean or `EXISTS` would do.
- Fan-out per online viewer per message.
- Writes hidden inside GET or other read paths.
- Query shapes with no matching `@@index` in `apps/web/prisma/`.
- Several publish HTTP calls where the Centrifugo batch or broadcast API exists.
