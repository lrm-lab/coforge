# Generic checklist

For a repository path with no area checklist.

## Read first

The nearest `AGENTS.md` chain, from the root down to the path. Then find entry
points and the per-event or per-request loops.

## Pattern families

- I/O in loops (queries, file reads, spawns, network calls per item).
- Sync blocking on a shared event loop or request path.
- Redundant work: the same read, parse or computation repeated.
- Unbounded growth: caches, maps, listeners, queues, result sets.
- Polling where an event or realtime signal exists.
- Oversized files with natural seams (see
  [`size-limit.md`](../../../../docs/agents/git-hooks/size-limit.md)).

Check for a comment or test recording a deliberate decision before reporting.
