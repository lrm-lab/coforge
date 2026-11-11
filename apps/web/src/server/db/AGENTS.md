# Database client and repositories

These rules apply to `src/server/db/`.

- The web pool is `StatementPool` (`statement-pool.server.ts`): a statement run
  outside a transaction waits at most 10 s, and only a plain `SELECT` is run again on a fresh
  connection. A read with side effects (a lock, `nextval`) belongs in a transaction; a statement
  that legitimately runs longer does too, under the transaction's own `timeout`.
- Use parameterized Prisma queries. Use `$queryRaw`/`$executeRaw` only for a
  reviewed PostgreSQL-specific requirement, and keep that SQL in a server-only
  repository or migration.
- `workspace-resource-recovery.repositories.server.ts` reads membership and default-resource
  links in one indexed query for Workspace-open recovery. Provisioning and role checks
  stay in `server/workspaces/resource-recovery.server.ts`.
- `attachment-deletion.repositories.server.ts` removes a file's comment Messages and Conversation before its row; channel deletion delegates through `channel-deletion.repositories.server.ts`. A future uploader/attachment deletion must reuse this flow, never rely on a binding FK to delete its parent Conversation.
- `agent-message-lookup.repositories.server.ts` resolves an Agent's message anchor only through an ordinary target and active seat; attachment comment authority belongs to its own store.
- `agent-message-history.repositories.server.ts` owns sequence windows and Agent read-through after callers authorize their targets.
- `attachment-comments.repositories.server.ts` persists whole-file comment Messages and metadata; it serializes first comments under source Conversation then Attachment row locks and rechecks source authority inside the transaction. Its recipient computation and per-actor source-access recheck (`readAccess`, `commentRecipients`) live in `attachment-comment-recipients.repositories.server.ts`.
- `attachment-comment-migration.repositories.server.ts` is the maintenance store: inspection and dependency repositories read consistent legacy data; journal and constraint repositories own copy fingerprints and targeted integrity changes; apply/restore repositories rehearse reversible moves on an explicitly authorized local copy. Application startup and ordinary writes never call them.
- `first-sign-in.repositories.server.ts` owns first-sign-in's User row lock and confirmed name persistence; enrollment commits with it, and resource provisioning follows the commit.
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
- `direct-conversation-agent-message.server.ts` owns Agent message projections and their Prisma include shapes, target names and Task metadata. The conversation repository owns authorization, reads and cursor advances.
- `agent-app-config.repositories.server.ts` reads Agent App config rows and a live Agent's
  placement, and writes a row only as a compare-and-set on its revision (never deleting one).
  Its `appId` names a built-in Agent App (the SDK's `BUILT_IN_APPS`, no table); the App's config
  defaults and validation are the SDK's `APP_CONFIG_DEFINITIONS`, applied in
  `server/agent-app-configs/`.
- The app repositories (`app*.repositories.server.ts`, `oauth-*.repositories.server.ts`) only persist; who may write stays in the owning `server/app-*/`, `server/apps/` and `server/authorization-server/` modules. Their rules:
  - `app`: a read for display never selects `clientSecretHash`, and every write is scoped to an app its Workspace owns, so it cannot reach another Workspace's.
  - `app-owner-agents`: assigns the owner Agent only while the Agent is live and the app has none, and writes a rotated secret's hash only while that Agent is still the owner.
  - `app-permissions`: a declaration is one compare-and-set on the app's `permissionRevision` that also narrows every installation's approval to the groups still declared (one raw `UPDATE`, so an approval committed meanwhile is narrowed too); an approval is one update conditional on that revision. Its `db` may be an open transaction (`transaction.server.ts`: `inTransaction` joins it instead of nesting).
  - `app-installation-setup`: its raw `UPDATE`s are needed because Prisma cannot express them as one statement: a declaration bumps `setupRevision` only when `setupUrl` differs from the stored value (`IS DISTINCT FROM`, null included), and a report is a compare-and-set on the app's current `setupRevision` that keeps an earlier completion time. Both must read the stored row inside the write, so concurrent declares and reports cannot lose a bump or record a stale revision.
  - `app-agent-inbound`: a request and its grant are written in one transaction, an approval is a conditional update on the pending request, one pending request exists per app and Agent (partial unique index), and `revokeAppAgentInbound` is the installation removal's call. `app-agent-event` writes an accepted event with its Message, delivery and the dedicated conversation in one transaction (`directKey` `app:<app id>|agent:<Agent id>`).
  - `app-installation-data`: filters private data out in the query itself and selects only the projected columns.
  - `app-publishing`: a request and its app's status change in one transaction (a conditional `updateMany` on the status it expects, so a lost race writes nothing).
  - `app-installation`: owns `removeAppInstallations`, the one removal of an (app, Workspace) installation, shared by an uninstall and an approved offline request. It lists every table keyed by (appId, workspaceId) and calls the owner of each: `revokeAppAuthorizations` (consents, authorization codes; `oauth-authorization`) `revokeAppAgentAccess` (Agent grants, pending requests; `app-agent-access`) and `archiveAppBots` (the bot Agent; `app-bot`). A new such table adds its revocation to its owner and a call there.
  - `app-share-link`: replacing the unrevoked link revokes the old and inserts the new under a lock on the app's row (one unrevoked link per app is a partial unique index), and only a token's hash is stored. Installing from a link is read by `app-installation.repositories.server.ts` (`findShared`, `findSharedListing`).
  - `app-bot`: each change locks the installation row (`FOR UPDATE`), a grant makes the bot Agent (`systemKind = app-bot`, no Computer) or reactivates it with the next generation, a revoke ends the keys and archives the Agent in the same transaction, a key mints atomically with `rotate`, and the status line is one conditional update.
  - `app-webhook`: a change locks the webhook row, bumps `revision` and deletes the statuses in one transaction, and an attempt's outcome is one conditional upsert that writes only while the webhook is still at the revision the attempt started with.
  - `app-notification-queue-schema` asks whether pg-boss's `pgboss` schema exists (the only raw SQL on it); starting the queue stays in `server/app-notifications/`.
  - `oauth-authorization` and `oauth-grant`: only a code's hash is stored, a code is redeemed by one conditional update, and a person, app, membership, installation and consent a code names are read as they are now.
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
- `agent-message-reads.repositories.server.ts` reads an Agent's message pages and advances its read-through; `agent-recovery.repositories.server.ts` reads pending deliveries and the recovery context. `agent-attention-deliveries.repositories.server.ts` holds the delivery-side half of the Agent attention rule (`pendingDeliveryWhere`, `unreadAgentMessagesFragment`, the shared live-delivery and notified-Agent predicates) that `agent-attention.repositories.server.ts` re-exports.
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
- `memory-disposition.repositories.server.ts` freezes Hint provenance at delivery, serializes receipts per Hint with a PostgreSQL row lock, and appends disposition/citation events atomically. Authorization within that callback uses the transaction connection, never a second global pool checkout.
