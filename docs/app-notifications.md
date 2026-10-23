# App notifications

How CoForge tells the apps installed in a Workspace what happened in it: events are recorded in a
durable outbox, fanned out to installations and delivered to each app's signed webhook
([HTTP delivery](#http-delivery)), to the events each installation is subscribed to
([subscriptions](app-notifications/subscriptions.md)). The code is
`apps/web/src/server/app-notifications/`; the design is the approved "App Notifications" proposal
(phase 2), which chose [pg-boss](https://github.com/timgit/pg-boss) (MIT, Bun supported) on
2026-10-21 for delivery. pg-boss is a PostgreSQL claim/lease job queue, so it is the exception Frank
approved to the root `AGENTS.md` rule against a database command mailbox or claim/lease workflow: it
is private to app notifications (outbound delivery to third-party apps only, never Agent or Message
delivery) and is not a generic job API.

## Mechanism

1. Domain code calls `AppNotifications.record(tx, workspace, event)` (`workspace` is the caller's `{ id, slug }`, so recording reads nothing but the flag; a caller that holds only the Workspace id goes through `recordAppNotifications`, which reads the slug first) inside the Prisma interactive transaction
   that makes the event true. It is the only way to emit an app notification. The event is the
   [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
   envelope `{ id (UUIDv7), type, timestamp, workspaceId, data }`; `data` holds ids and changed
   fields. pg-boss writes it as a job in the `app-notification-event` queue through its
   `fromPrisma(tx)` adapter, so the job joins the transaction.
2. The event worker (`event-worker.server.ts`) asks `subscribersOf(event)` for the installations
   to notify: those of the event's Workspace whose app has an enabled webhook and whose
   [effective events](app-notifications/subscriptions.md#effective-events) include the event's
   type, while the `app-notifications` and `app-data-permissions` flags are both on for it. It
   inserts one job per installation into `app-notification-delivery`, with the job id
   `UUIDv5(eventId:installationId)`.
3. The delivery handler (`webhook-delivery.server.ts`) POSTs the event to the installation's app
   webhook, or completes the job unsent ([HTTP delivery](#http-delivery)).

Events recorded today, and what each carries and where it is recorded:
[event data](app-notifications/subscriptions.md#event-data). `AppNotificationEvent` is a discriminated union: each `type` is paired with
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
- **Best effort, never blocking:** notifications never affect the operation that emits them
  (admitting a Workspace member must not fail because of them). For a flag-on Workspace, `record`
  never throws and never aborts the caller's transaction. When the queue is not running in this
  process (it never starts it) or the send fails, the event is skipped and logged as
  `app_notifications:record_skipped` (`reason`, `type`, `workspace_id`, `event_id`; no personal
  data) and the domain transaction commits. The send runs in a `SAVEPOINT` in the caller's
  transaction, so a failed send rolls back only to it. Events of that moment are not delivered
  while the queue is down and are not replayed later. A send that succeeds is atomic with the
  domain transaction.

## Enabling

Before turning `app-notifications` on in staging or production, confirm the database user can
`CREATE` a schema (pg-boss creates `pgboss` on its first start), then enable the flag for one test
Workspace first and check that its events appear as jobs.

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
`QUEUE_START_RETRY`), so a database that was not ready does not leave recording skipped until
a restart; after the last retry only a flag file reload or a restart tries again. On shutdown one
hook stops listening for reloads and retrying first, forbids any later start, then stops the queue.
The database user needs `CREATE` on the database for the first start (staging and production
included). pg-boss uses its own pool (4 connections, built from the same pool settings as
Prisma's). Rollback: stop the server, then `DROP SCHEMA pgboss CASCADE`; domain tables are
untouched.

## HTTP delivery

An app's owner or admin enables a signed webhook (Standard Webhooks) by saving an endpoint. The
delivery handler signs each event and POSTs it, retrying with backoff and stopping per installation
on a 410 or when retries run out. Details are topic files:

- [HTTP delivery](app-notifications/http-delivery.md): the request and its headers, who is
  notified, the outcome of an attempt, statuses and revisions, the outbound egress.
- [Subscriptions and the editor](app-notifications/subscriptions.md): the event catalog and the
  data group each event needs, how an app subscribes and an installation approves, the effective
  events, and the App notifications section of the app editor.
- [Webhook secret and endpoint](app-notifications/webhook-secret.md): the derived signing secret and
  its rotation, `COFORGE_APP_WEBHOOK_KEY` (and rotating it), the endpoint rules.

## Retries

Workers poll every 2 s (`APP_NOTIFICATION_POLLING_INTERVAL_SECONDS`).

| Queue                      | Attempts          | Delay                            | Expires |
| -------------------------- | ----------------- | -------------------------------- | ------- |
| `app-notification-event`   | 8 retries         | 5 s, doubling, at most 1 h       | default |
| `app-notification-delivery`| 16 retries        | 5 s, doubling, at most 24 h      | 60 s    |

The delivery schedule is the proposal's (`DELIVERY_QUEUE_OPTIONS`): pg-boss waits between 1x and 2x of
`5 s * 2^n` after the n-th failed attempt, at most a day; 17 attempts in all, about 3.4 days.

## Feature flag

`app-notifications` ([feature flags](feature-flags.md)), evaluated per event for the event's
Workspace, first in `record` and again in `subscribersOf`. While it is off for a Workspace its
events are not recorded at all.

## Tests

`app-notifications.integration.test.ts` runs against real PostgreSQL
(`APP_NOTIFICATIONS_TEST_DATABASE_URL`, and `DATABASE_URL` naming the same database, which
`mise run test:integration:web` sets). `app-webhook-delivery-{signing,failures,access,queue}.integration.test.ts`, sharing `test/helpers/app-webhook-delivery-fixture.ts` (same variables), drives signing, rotation, retries,
410, exhaustion, the egress refusals, the flag and the key against a loopback receiver (the egress under test gets a public `resolve` and a `fetch` that forwards to it), and one
event through pg-boss with a 503 first. The pure parts are in `app-webhook-signing.test.ts` and
`outbound-egress.test.ts`. `app-notifications-dark.integration.test.ts` creates and
migrates its own database to prove the dark, server start, flag reload, retry, shutdown and
skip-and-log behaviour above.
