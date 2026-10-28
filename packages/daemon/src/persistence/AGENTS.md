# persistence instructions

Rules for durable local state in `src/persistence/`. They extend
`packages/daemon/AGENTS.md`.

- `daemon-config.ts` owns environment validation for daemon configuration and
  recovery. The entrypoint uses it; it does not validate environment itself.
- This directory owns atomic record writes, atomic App Inbox storage, and
  guarded Agent workspace clearing.
- `private-json-record.ts` owns permission-restricted atomic JSON replacement
  for App Inbox and reminder receipts; callers own their record validation.
- Persisted Agent runtime records stay outside the Agent workspace, so clearing
  a workspace can never delete them.
- A connection outbox is not durable storage, and nothing here is a jobs queue
  or a Message outbox.

- `conversation-session-store.ts` atomically stores Memory conversation identities outside
  Agent workspaces, namespaced by the control session so a Session Reset starts fresh.
- `agent-state-db.ts` owns each Agent's durable ledger (`agent-state/<agentId>/state.db`) in the
  daemon state directory — one SQLite database per Agent holding the consumed cursor and the
  held-send draft — and the first-boot import of the legacy JSON stores. Writes commit when they
  happen (WAL, `synchronous=NORMAL`); there is no write delay, batching, or stop-time flush.
