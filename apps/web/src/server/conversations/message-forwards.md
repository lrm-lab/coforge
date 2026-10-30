# Message forwards

Moved out of [`AGENTS.md`](AGENTS.md) to keep it under 200 lines.

- A forward is a new message in the destination (`message-forwards.server.ts`, `MessageForwards`) whose
  `body` is the forwarder's note, possibly empty, with a one-to-one `MessageForward` row
  (`message-forward-view.server.ts`, `recordForward`) holding the snapshot of the original. It is written by
  `recordForward` as the `withinSend` hook of the send (`sent-message-hook.server.ts`), in the send's own transaction,
  through the existing `sendChannel` and `DirectConversations.send`; never write a forward's message by hand.
  Only a send with `allowEmptyBody` accepts an empty body, and `forwarded` is the original as the Agent that is
  delivered the message reads it.
- `message-forward-source.server.ts` decides what can be forwarded and freezes it. A message that is itself a forward,
  an action card or a server notice is refused for the whole request (`INVALID_INPUT`, `forward-not-forwardable`), and
  one the person cannot read is `NOT_FOUND`, so a refusal never says whether it exists. A Task's message and a comment
  on an attachment forward as the snapshot they are (no Task state, no comment anchor; a comment has no original to
  open). One request names one message.
- `sourceBody` is stored as plain text (`peopleReadableBody`: a person reads as their name, an Agent as its
  `@handle`), so a forward notifies nobody the original named and a later edit or delete of the original changes
  nothing. Only the note's mentions resolve and notify, as in any message.
  `sourceRawBody` (the original's stored body, tokens included) and `sourceMentions` (its mentions as the browser
  reads them) are frozen beside it, for the card's chips only; `sourceBody` is computed from those two in the same
  step. Nothing resolves the tokens in `sourceRawBody` into a mention or a wake, and a task it names is the
  source conversation's, so the card draws it as `task #N` without reading any task. Both are null on a forward made
  before they existed, which the card draws from `sourceBody`.
- Each destination is its own send under the forwarder's normal permission to post there, with a key derived from the
  request id and the destination (`forwardIdempotencyKey`) in the existing message-request idempotency. A retry with
  the same request id answers a finished destination from its record without copying or sending, and sends only the
  rest. A public channel the person has not joined fails with `not_joined`: nothing joins silently; the client asks,
  joins, and sends again.
- The original's uploads are copied in object storage (`ObjectCopy.copyObject`) before the send, as new unlinked
  attachments of the forwarder's in the destination conversation, which the send links. The copies share nothing
  with the originals; a failed destination discards its copies.
- A forward's `sourceMessageId` is `SET NULL` when the original is deleted. `sourceAccessible` is settled per viewer
  in one batched lookup per page (`attachForwardedAccess`, called by `attachViewerViews` and by the Saved list, search
  and the Activity inbox); `mapBrowserMessage` always starts it `false`, so a surface that forgets it opens nothing.
- An Agent reads `forwarded` (`agentForwarded`: `from`, `thread`, `sender`, `sentAt`, `body`, `attachments`) beside the
  note in `body`, from `agentMessageView`. A daemon delivery has no field for it, so `encodeAgentDelivery` (and
  `agentDeliveryView` for recoveries and pending deliveries) reads the original into the delivered body after the note,
  both through `withForwarded`.
