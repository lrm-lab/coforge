# Database client and repositories

These rules apply to `src/server/db/`.

- Use parameterized Prisma queries. Use `$queryRaw`/`$executeRaw` only for a
  reviewed PostgreSQL-specific requirement, and keep that SQL in a server-only
  repository or migration.
- Paginate a list with `prisma-extension-pagination` through `paginated(db)`
  (`pagination.server.ts`), not with hand-written `take: limit + 1`:
  `.paginate(query).withCursor({ limit, after })` for a cursor on a single
  unique `id`, `.withPages({ limit, page })` for page numbers. Its cursors are
  our UUID ids. A page after a cursor costs two queries (the extension also
  reads `hasPreviousPage`).
- A cursor page (`withCursor`, or any `findMany({ cursor })`) must end its
  `orderBy` with every field of the cursor's unique key (for `id`:
  `orderBy: [{ name: "asc" }, { id: "asc" }]`). Otherwise Prisma 7 sends no
  LIMIT and reads every row before the cursor (prisma/prisma#15710).
- Don't use a compound unique cursor (`conversationId_sequence`, …) for
  sequence paging: even with a covering orderBy, Prisma's cursor SQL is an OR
  plus subqueries, slower on deep pages than a plain range. A sequence window
  (`sequence < x` / `> x`, `around`) and a raw-SQL page stay hand-written range
  queries; so does a keyset whose cursor encodes the sort values themselves
  (`updatedAt` + id), which a changed or deleted cursor row must not move.
- `clampPageLimit(requested, max)` (`page-limit.server.ts`) bounds every
  requested page size.
- Agent repositories persist only the completed runtime configuration;
  runtime selection and credential encryption stay in `server/agents/`.
- `reminder.repositories.server.ts` owns PostgreSQL locking and persistence
  only; authorization, recurrence, and fire idempotence stay in
  `server/reminders/`.
- Code Agent installation inventory (`computer-runtime.repositories.server.ts`)
  is keyed and queried by the trusted `(workspaceId, computerId)` connection. A
  Computer shared with another Workspace must not share publication state or
  model-catalog rows.
- `daemon-credential-revocation.repositories.server.ts` keeps revocations by
  key hash only, with no relation to the Workspace, Computer, or key row, so
  they outlive the cascade. Expired ones are ignored on read and pruned on the
  next record.
- `agent-migration.repositories.server.ts` persists Agent migrations: the
  revision compare-and-set, the one-active-per-Agent partial unique index, and
  the switch, which re-homes the Agent through `moveAgentToComputer` (Agent
  repositories) in the same transaction. Step order and who may take a step
  stay in `server/agent-migrations/`.
- `agent-deletion.repositories.server.ts` makes a deleted Agent inert in one
  transaction; keep every deletion write inside it.
- `direct-conversation-preferences.repositories.server.ts` owns the viewer's
  DM list preferences (pinned, marked unread, closed) and the sidebar's read
  of their DMs (which, with whom, unread counts), by conversation id, for DMs
  with Agents and between members alike. It writes only to a DM
  `DirectConversations` has authorized and never creates one;
  `PrismaDirectConversationRepository` keeps the DM's messages and read
  cursors.
- `mention-delivery.repositories.server.ts` keeps tracked @mention outcomes on
  `agent_message_deliveries`. Every write is conditional on the outcome still
  being open (pending or unknown) and, for a daemon report, on the row still
  carrying that report's envelope, so a late or repeated report never reopens
  delivered or lost. An issue locks its Agents' rows (`FOR SHARE`) before it
  reads their state. A re-issue selects by outcome and envelope, never by
  `receivedAt`, and writes a row only while it still carries the envelope it
  was read with.
- `write-conflict.server.ts` is the one place that recognizes a PostgreSQL
  deadlock or serialization failure (Prisma P2034, or a raw query's P2010 with
  the adapter's `TransactionWriteConflict`). Retry only those, a bounded number
  of times, and only a transaction that takes its locks in the writers' order.
- `host-directory.repositories.server.ts` persists host-node rows. Enrollment,
  the online window, and token checks stay in `server/hosts/`.
- `host-job.repositories.server.ts` persists a cloud Computer and its create job.
  Membership, the online check, and when the daemon key is cleared stay in `server/hosts/`.
