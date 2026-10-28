---
name: perf-scan
description: Find, verify and rank the most promising performance-optimization and refactor direction in this repository, then hand a recommendation to the owner; never implement. Use when asked to find a performance or refactor direction, scan for hotspots, work out where something is slow, or choose what to optimize next. Accepts areas (web-server, daemon, web-client, or a repository path); defaults to the three named areas.
---

# Perf scan

Output is a ranked recommendation for the owner to choose from. This skill never
creates a branch or writes code.

## Areas

| Area | Scope | Checklist |
| --- | --- | --- |
| `web-server` | `apps/web/src/server/` | [`references/web-server.md`](references/web-server.md) |
| `daemon` | `packages/daemon`, `packages/anvil` | [`references/daemon.md`](references/daemon.md) |
| `web-client` | `apps/web/src/features`, `components`, `routes` | [`references/web-client.md`](references/web-client.md) |
| any repository path | that path | [`references/generic.md`](references/generic.md) |

Default: the three named areas. Several paths may be requested at once.

## Procedure

1. **Read committed code.** Run `git fetch origin`, then
   `git worktree add --detach .worktrees/perf-scan-<date> origin/main`. Every
   scanner reads only that worktree (root `AGENTS.md`: read code where it is
   committed). Remove the worktree when the scan ends.
2. **Scan in parallel, read-only.** Launch one read-only search agent per area in
   a single message. Its brief is the area's checklist plus the report format
   below. Do not pin a model. Scanners never edit files, run tests, or build.
3. **Verify.** The coordinator re-reads the code behind at least each area's top
   candidate, or hands it to an independent agent without the scanner's
   conclusion. Drop or downgrade whatever does not hold. A scanner's confident
   claim is not evidence.
4. **Synthesize.** One table across areas: direction, evidence (`file:line`),
   impact and confidence, rough size. State plainly that nothing was measured.
   Give one recommendation and why. Prefer a place with clear verified waste,
   growth with data, and a refactor seam together. Note files frozen by the size
   ratchet ([`size-limit.md`](../../../docs/agents/git-hooks/size-limit.md)):
   they must be split along seams in a move-only commit before they grow.
5. **Stop.** Present the options and recommendation to the owner (root
   `AGENTS.md`, Decisions) and let them choose. Do not write findings into the
   repository: they go stale. Only the checklists live here.

## Scanner report format

Under 600 words:

- The top 3-5 candidates, ranked by expected user-visible impact times
  confidence. Each gives `file:line`, the exact pattern, the user action or event
  that triggers it and how often, and a rough fix shape.
- Mark every claim `verified-from-code` or `guess`.
- A "checked and fine" list: things suspected and ruled out, such as a deliberate
  decision recorded in a code comment.
- For very large files, proposed seams: name, line range, responsibility.

## When the owner chooses a direction

- The first step is a reproducible baseline measurement, before any change.
- Agree the public test seam first and work test-first
  ([`docs/agents/testing.md`](../../../docs/agents/testing.md)). UI unit tests are
  forbidden: list the affected UI and a manual checklist instead
  ([`ui-manual-checks.md`](../../../docs/agents/ui-manual-checks.md)).
- Split big files at seams in a verbatim move commit first
  ([`size-limit.md`](../../../docs/agents/git-hooks/size-limit.md)).
- Prefer a maintained framework mechanism over hand-rolled code (root
  `AGENTS.md`, Decision gates).
