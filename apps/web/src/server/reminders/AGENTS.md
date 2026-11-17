# Reminders

These rules apply to `src/server/reminders/`.

- The public `Reminders` interface owns authorization, recurrence, fire
  idempotence, and snapshot behavior. Its repository owns PostgreSQL locking
  and persistence only.
- The authenticated Agent HTTPS and Daemon WSS compositions are adapters
  only; they never re-implement Reminder rules.
- ReminderDue timing belongs to the server for Computers whose persisted ready
  capabilities include `reminder-due:v1`, even while offline. Other Computers
  keep the legacy daemon timer/fire path. Ready capability downgrades expire
  pending Due records with an alert; they never convert them to legacy fires.
- Due transport ACK takes custody of an exact occurrence and revision; user
  acknowledgement and dismissal are separate lifecycle operations.
- Publish the Web migrations and server before releasing a Computer that
  advertises `reminder-due:v1`. Before rolling Web back to a server without Due
  support, downgrade every due-capable daemon first; otherwise those daemons
  have no timer or server delivery. See the [promotion checklist](../../../../../docs/release/staging-to-production.md#reminder-due-compatibility).
- The browser read model in `server/agents/agent-reminders.server.ts` (the Agent's creator or a Workspace owner/admin)
  reads bounded, scheduled Reminders only; lifecycle and history persistence
  stay here.
