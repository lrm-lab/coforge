# web-client checklist

Scope: `apps/web/src/features`, `components`, `routes`.

## Read first

`apps/web/AGENTS.md`, `apps/web/src/features/AGENTS.md`, and the feature's own
`AGENTS.md`.

## Patterns

- Input or draft state, or per-second timers (countdowns, clocks), held in a
  large parent so every keystroke or tick re-renders a whole list.
- Per-row O(n) work inside `.map` (`some`, `findIndex`, `slice` over the full
  list).
- Context values that change on unrelated updates. Split stable callbacks from
  changing data; subscribe per row with `useSyncExternalStore`.
- Un-memoized rows matter only if their props are stable. Check prop identity
  before recommending `memo`.
- Polling (`refetchInterval`, `setInterval` with an unfiltered
  `router.invalidate()`) where a realtime signal exists.
- Heavy libraries in the initial bundle. Check `vite.config.ts` chunking and
  `lazy` or dynamic imports before reporting.
- Resize or drag handlers that set state on every pointermove.

## Static scan (`react-doctor`)

Run `bunx react-doctor@latest . --yes --scope full` (or `--scope changed --base origin/main`
when reviewing a diff) from `apps/web` on-demand via `bunx` — do not add `react-doctor`
to `package.json`.

- Focus on client and shared files (`src/features`, `src/components`, `src/routes`,
  `src/hooks`, `src/lib`). Ignore `src/server/` diagnostics (such as server helpers
  named `use*` or server-only async loops) and generated directories (`src/generated/`,
  `src/paraglide/`).
- Treat every diagnostic as a candidate and verify against the code before reporting:
  check for deliberate decisions, official Untitled UI component internals, or
  high-level cleanup handles (e.g. `disconnect()`) that static analysis misses.

## Before flagging

Before suggesting virtualization or `content-visibility`, look for a comment
recording that it was tried and removed.
