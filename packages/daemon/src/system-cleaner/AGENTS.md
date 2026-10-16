# system-cleaner instructions

Rules for `src/system-cleaner/`. They extend `packages/daemon/AGENTS.md`.

- The cloud owns each Agent's config (`system.cleaner`: enabled, threshold, interval,
  revision). An Agent with no applied config has no cleaner; never invent a local default.
  `SYSTEM_CLEANER_CONFIG_BOUNDS` and the envelope check are the one validation of a config.
- Apply configs by revision only: a lower one is stale, the same revision with other values is
  a conflict, and a newer one cancels the timer and drops the Agent's items before re-arming.
- A period only measures and marks a hint due. Present it only from
  `onAgentWorkingToIdle`, which `DaemonRuntime` calls when a turn ends and when a process exits
  without a crash. Remeasure MEMORY.md before minting.
- An Agent whose workspace is deleted here or moved to another Computer is forgotten
  (`replaceOwnerSnapshot(id, null)` from `DaemonRuntime`); its config arrives again with it.
- Waking never starts an Agent: `DaemonRuntime` notifies only a running Agent that is not
  working; otherwise the item waits for the next idle drain or launch.
- Hints are App Inbox items with `transient` retention: one per Agent and class, updated in
  place, never written to disk. `AgentAppInbox` keeps them out of `items.json`; a restart
  forgets them along with every other piece of cleaner state.
- Record a tip's timestamp only after its item was minted. A mint the inbox refuses is logged
  and dropped, never thrown.
- The daemon never edits or deletes workspace files for a hint. The disk item points at the
  `workspace-cleanup` Agent Manual topic; keep that slug in step with
  `apps/web/src/server/agents/manual/`.
- Measurements go through the injected clock with a 10-second timeout; tests drive time with a
  manual clock rather than sleeping.
