# agent-reminder instructions

Rules for `src/agent-reminder/`. They extend `packages/daemon/AGENTS.md`.

- The server times every reminder. This daemon advertises `reminder-due:v1`
  next to `reminder:v1` and never arms a timer or sends a fire request.
  `ReminderSync` publications are consumed and ignored.
- One `ReminderDue` names one occurrence. The receiver writes it to the
  Agent's Due record before sending the Due ACK. It delivers only after the
  server accepts that ACK. A refused ACK ends the occurrence as `refused`.
- Delivery means the `system.reminder` App Inbox item is stored. Waking the
  Agent is best-effort: a refused, held or impossible notice leaves the item
  for the next drain or launch. An Agent under a fenced Stop is not started.
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
