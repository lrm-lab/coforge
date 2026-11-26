# persistence instructions

Rules for durable local state in `src/persistence/`. They extend
`packages/daemon/AGENTS.md`.

- Persisted Agent runtime records stay outside the Agent workspace, so clearing
  a workspace can never delete them.
- A connection outbox is not durable storage, and nothing here is a jobs queue
  or a Message outbox.

- `agent-state-db.ts` owns each Agent's durable ledger (`agent-state/<agentId>/state.db`) in the
  daemon state directory — one SQLite database per Agent holding the consumed cursor, the
  held-send draft, and the held send's continuation — and the one-time import of the legacy JSON
  stores. Writes commit when they
  happen (WAL, `synchronous=NORMAL`, `busy_timeout`); there is no write delay, batching, or
  stop-time flush. When the Agent is deleted or moved to another Computer,
  `DaemonRuntime.#forgetLocalAgent` calls `AgentConsumedSeqStore.remove`, which closes the handle
  and deletes the directory: an Agent that moves back starts a fresh cursor, never the old one.
- The cursor is written row by row, and the database keeps it monotonic: an update (delta or
  snapshot) that arrives late never lowers a frontier, a review boundary or a read order (a target
  that moved to another conversation resets its legacy slot). Scoped evidence is keyed by
  conversation ID and, for threads, the authoritative thread root returned by the server.
  On open, the cursor store merges provable legacy cursors from version 1 databases into
  the additive scoped table in one transaction. Task discussions with their own conversation
  IDs have top-level scope. Legacy thread progress is merged when its full root matches a
  previously stored authoritative scope. Active cursor updates can write the scoped row and
  the legacy slot in the same transaction for rollback. A thread projection requires the full
  root in the legacy spelling. Scoped-only updates preserve the legacy slot and its binding.
  `meta` holds the schema version — a database a newer build wrote
  is refused, not migrated — the marker that says the legacy import already ran, and per-Agent
  runtime ledgers (`compactionFailures`, `contextGeneration`, `standingPrompt` — SHA-256 hash and
  metadata only, never raw prompt text — and `sessionSummary` for summary-backed idle session
  recycle).

- `memory-review-ledger.ts` keeps personal review watermarks, active batch and pending key/revision
  pairs in the existing `meta` table. It stores no memory bodies or chat text. Deletion and
  migration use the existing Agent-state removal, with no separate storage cleanup path.

- `claude-model-quota-ledger.ts` owns the Workspace Daemon's private
  `claude-model-quota.json` facts by trusted account digest and weekly model.
  The delivery hold owns session bindings, waiting Agents and input admission.
