# daemon checklist

Scope: `packages/daemon`, `packages/anvil`.

## Read first

`packages/daemon/AGENTS.md` and `packages/anvil/AGENTS.md`. One event loop serves
every Agent, so anything blocking it costs all of them.

## Hot paths

- Per-message delivery.
- Attention index.
- Activity publishing.
- Reminder ticks.
- Reconnect and ready.
- Runtime and catalog discovery.

## Patterns

- Sync fs, `spawnSync` or `execSync` on an event or reconnect path.
- A full-state snapshot written per command instead of coalesced async writes.
- Discovery or process spawns repeated on every reconnect.
- O(n) or O(n^2) scans per event.
- Timers not `unref`'d or never cleared.
- Maps that are never pruned.
- Layering violations: stores constructed inside orchestration instead of the
  entry point; Node APIs where Bun is the rule (see
  [`using-bun-runtime`](../../using-bun-runtime/SKILL.md)).
