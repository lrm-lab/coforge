# persistence instructions

Rules for durable local state in `src/persistence/`. They extend
`packages/daemon/AGENTS.md`.

- Persisted Agent runtime records stay outside the Agent workspace, so clearing
  a workspace can never delete them.
- A connection outbox is not durable storage, and nothing here is a jobs queue
  or a Message outbox.

- `conversation-session-store.ts` atomically stores Memory conversation identities outside
  Agent workspaces, namespaced by the control session so a Session Reset starts fresh.
- `agent-state-db.ts` owns each Agent's durable ledger (`agent-state/<agentId>/state.db`) in the
  daemon state directory — one SQLite database per Agent holding the consumed cursor, the
  held-send draft, and the held send's continuation — and the one-time import of the legacy JSON
  stores. Writes commit when they
  happen (WAL, `synchronous=NORMAL`, `busy_timeout`); there is no write delay, batching, or
  stop-time flush. When the Agent is deleted or moved to another Computer,
  `DaemonRuntime.#forgetLocalAgent` calls `AgentConsumedSeqStore.remove`, which closes the handle
  and deletes the directory: an Agent that moves back starts a fresh cursor, never the old one.
- The cursor is written row by row, and the database keeps it monotonic: a snapshot that arrives
  late never lowers a frontier, a review boundary or a read order (a target that moved to another
  conversation resets instead). `meta` holds the schema version — a database a newer build wrote
  is refused, not migrated — and the marker that says the legacy import already ran.
