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

## Before flagging

Before suggesting virtualization or `content-visibility`, look for a comment
recording that it was tried and removed.
