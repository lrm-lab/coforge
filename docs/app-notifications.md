# App notifications

How CoForge tells the apps installed in a Workspace what happened in it. This slice is the durable
outbox only: events are recorded and fanned out to installations. The signed HTTP delivery, retries,
subscriptions and the app-editor UI are later slices. The code is
`apps/web/src/server/app-notifications/`; the design is the approved "App Notifications" proposal
(phase 2), which chose [pg-boss](https://github.com/timgit/pg-boss) (MIT, Bun supported) on
2026-10-21 for delivery. pg-boss is a PostgreSQL claim/lease job queue, so it is the exception Frank
approved to the root `AGENTS.md` rule against a database command mailbox or claim/lease workflow: it
is private to app notifications (outbound delivery to third-party apps only, never Agent or Message
delivery) and is not a generic job API.

## Mechanism

1. Domain code calls `AppNotifications.record(tx, workspace, event)` (`workspace` is the caller's `{ id, slug }`, so recording reads nothing but the flag) inside the Prisma interactive transaction
   that makes the event true. It is the only way to emit an app notification. The event is the
   [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
   envelope `{ id (UUIDv7), type, timestamp, workspaceId, data }`; `data` holds ids and changed
   fields. pg-boss writes it as a job in the `app-notification-event` queue through its
   `fromPrisma(tx)` adapter, so the job joins the transaction.
2. The event worker (`event-worker.server.ts`) asks `subscribersOf(event)` for the installations
   to notify: those of the event's Workspace, while the `app-notifications` flag is on for it. It
   inserts one job per installation into `app-notification-delivery`, with the job id
   `UUIDv5(eventId:installationId)`.
3. The delivery handler is a **no-op stub** in this slice: delivery jobs complete without sending
   anything. The flag is off everywhere until the next slice fills the handler.

Events recorded today: `workspace.member_added` with `data: { userId, role }`
(`admitWorkspaceMember`). `AppNotificationEvent` is a discriminated union: each `type` is paired with
its `data` shape, so adding an event adds a member to `AppNotificationEventPayload`.

Naming: Raft calls Workspace events `server.*`. CoForge's Workspace is Raft's server (the read APIs
map server to workspace), so the same events are `workspace.*` here.

## Guarantees

- An event is recorded if and only if its domain transaction commits; a rollback leaves no job.
- Recording an event id again changes nothing (the job id is the event id), and rerunning the event
  worker enqueues no duplicate delivery (the delivery job id is derived).
- At least once from the outbox on: a worker crash makes pg-boss run the job again. Events with no
  Postgres write (Redis-lease status changes) are not part of this slice and would be best effort.
- A flag-off Workspace records nothing: `record` returns before it writes a job, so it can never
  fail the domain transaction and needs no `DATABASE_URL` for pg-boss.
- **Fail closed:** for a flag-on Workspace, `record` throws `AppNotificationsUnavailable` when the
  queue is not running in this process (it never starts it). The domain transaction rolls back, so
  an event is never lost silently; the user retries once the queue is up.

## The `pgboss` schema and when the queue starts

pg-boss owns the PostgreSQL schema `pgboss` and creates and migrates it itself when it starts; it
is not in Prisma migrations, which compare only `public`. That DDL must never run inside a domain
transaction, and `record` never waits for a start in flight (it sees the queue only once a start
has settled successfully), so the queue starts outside any, in two places:

- **Server start** (`src/server.ts`, when `DATABASE_URL` is set). The SSR entry loads on the first
  request, which the deployment's health check makes right after the process starts. The queue
  starts if the `pgboss` schema already exists (jobs pending at a restart drain) or the flag file
  defines `app-notifications` as ENABLED (`isFeatureDefined`, read from the loaded definitions,
  not from an evaluation), so the first event finds a running queue.
- **Flag file reload:** the provider polls the file, and when a reload makes the flag defined where
  it was not, the queue starts then.

A deployment whose flag file never defines the flag gets no schema. A start that fails is logged
(`app_notifications:queue_start_failed`) and retried with backoff (1 s doubling to 30 s, 24 retries,
`QUEUE_START_RETRY`), so a database that was not ready does not leave recording failing closed until
a restart; after the last retry only a flag file reload or a restart tries again. On shutdown one
hook stops listening for reloads and retrying first, forbids any later start, then stops the queue.
The database user needs `CREATE` on the database for the first start (staging and production
included). pg-boss uses its own pool (4 connections, built from the same pool settings as
Prisma's). Rollback: stop the server, then `DROP SCHEMA pgboss CASCADE`; domain tables are
untouched.

## Retries

Workers poll every 2 s (`APP_NOTIFICATION_POLLING_INTERVAL_SECONDS`).

| Queue                      | Attempts          | Delay                            | Expires |
| -------------------------- | ----------------- | -------------------------------- | ------- |
| `app-notification-event`   | 8 retries         | 5 s, doubling, at most 1 h       | default |
| `app-notification-delivery`| 16 retries        | 5 s, doubling, at most 24 h      | 60 s    |

The delivery schedule is the proposal's; it matters once the next slice sends over HTTP.

## Feature flag

`app-notifications` ([feature flags](feature-flags.md)), evaluated per event for the event's
Workspace, first in `record` and again in `subscribersOf`. While it is off for a Workspace its
events are not recorded at all.

## Tests

`app-notifications.integration.test.ts` runs against real PostgreSQL
(`APP_NOTIFICATIONS_TEST_DATABASE_URL`, and `DATABASE_URL` naming the same database, which
`mise run test:integration:web` sets). `app-notifications-dark.integration.test.ts` creates and
migrates its own database to prove the dark, server start, flag reload, retry, shutdown and
fail-closed behaviour above.
