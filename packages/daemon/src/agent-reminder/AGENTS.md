# agent-reminder instructions

Rules for `src/agent-reminder/`. They extend `packages/daemon/AGENTS.md`.

- The server times every reminder. This daemon advertises `reminder-due:v1`
  next to `reminder:v1` and never arms a timer or sends a fire request.
  `ReminderSync` publications are consumed and ignored.
- One `ReminderDue` names one occurrence. The receiver writes it to the
  Agent's Due record before sending the Due ACK. It delivers only after the
  server accepts that ACK. A refused ACK ends the occurrence as `refused`.
- Delivery means the `system.reminder` App Inbox item is stored. A failed
  delivery is retried at 1, 5 and 15 minutes, then waits for the next
  `restore()`.
- The wake runs after the record says `delivered`, outside the Agent's
  serial queue, so a slow start blocks no ack or later Due. A failed wake is
  retried at 1, 5 and 15 minutes while the item is still in the inbox. An
  Agent under a fenced Stop is neither started nor retried.
- The Due record is written with fsync before its ACK. A record file that
  cannot be read is moved aside as `*.corrupt-<ms>` and the Agent starts
  empty; `restore()` handles each Agent on its own.
- A repeated Due only repeats its ACK. On every connection, `restore()` ACKs
  `received` records again and delivers `acknowledged` ones.
- Records go once `expiresAt` passes, except `acknowledged` ones, which the
  server has already handed over. An expired Due is neither ACKed nor
  delivered.
- The Due ACK and the user's `ack`/`dismiss` are separate. Only an occurrence
  this daemon delivered is synced as acknowledged
  (`ReminderAcknowledgementSync`); an item with no record is removed locally.
- `stop()` is synchronous and fences out later steps. Runtime `stop` awaits
  `awaitIdle()` under a bound.
