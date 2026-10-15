# Memory Hint receipts

An addressed task Agent decides `adopt`, `reject`, or `defer` with the native
`memory_disposition` tool. A delivered Hint carries recipient-only structured
`hint_id` and tool metadata. The channel body stays the cited Hint text.
The Memory Agent cannot receive a Hint or submit its receipt.

The authenticated server determines the deciding Agent and timestamp. The tool
records intent only; it does not post a channel message, freeze other tools,
prove followthrough, or award positive utility. Actions preceding a successful
`adopt` must not be counted as followthrough by a consumer.

## State and permissions

- `adopt` and `reject` are terminal. Repeating the current decision returns its
  original record, even after expiry, without another citation.
- `defer` can be followed once by `adopt` or `reject` within the original Hint
  delivery TTL. Repeating `defer` does not refresh that TTL.
- New writes recheck the target's current access to each frozen source. Each
  readable source receives `considered` for adopt/defer or `rejected` for reject.
  Unreadable source identifiers are returned without their contents. If all
  sources are unreadable, nothing is recorded.
- Existing delivery provenance is not reranked or rechecked for current
  discovery eligibility. Leaving the channel does not remove receipt rights.
- Malformed requests fail before lookup. Unknown and another Agent's Hint have
  the same unauthorized result. Empty reasons fail without checking source ACL.
- PostgreSQL locks each Hint while checking and appending its receipt. History
  and per-source citations commit together; failures append neither.

## Runtime and configuration

The first delivery integrates the native tool into bundled CoForge and Pi
task sessions. Other provider adapters do not yet have a native-tool injection
surface; their adapter integration remains outstanding. There is no CLI receipt
subcommand, and a channel reply cannot stand in for the native tool.

Q196 delivery suppression (`defer-all`, type filters, and user silence) also
remains outstanding: the current product has no persisted controls for these
policies. This branch does not treat an Agent's `defer` receipt as such a control.
Those delivery controls must gate publication before Hint creation and exposure.

Set `COFORGE_MEMORY_HINT_TTL_SECONDS` explicitly on the Web/backend. No default
is selected here: the design left the TTL duration open. Invalid/missing values
prevent new Hint creation. Delivery sets the expiry once; replay never extends
it. Apply the Prisma migration before starting the updated backend, and update
the Computer/Daemon alongside it so receipt metadata survives message codecs.

Historical Memory Offers have no retroactively fabricated Hint or receipt.
The IR benchmark's separate Go harness is unchanged by this product branch.

## Validation

Public behavior tests cover the native tool, authenticated local proxy,
state transitions, authority failures, source ACL changes, and delivery/recovery
codec round trips. PostgreSQL integration exercises the actual migration,
cross-process row locking (including mixed-case Hint UUIDs), append-only
history, and per-source citation roles. The six PostgreSQL cases also verify
no partial write on an ACL outage and receipt rights after leaving the channel;
five repetitions passed (30/30).

Run repository gates with `mise run test`, `mise run check`, and `mise run build`.
Run the database cases explicitly after migrations against a disposable database:

```sh
MEMORY_DISPOSITION_TEST_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/DATABASE \
  mise exec -- bun test ./apps/web/test/memory-disposition.integration.ts --rerun-each 5
```

Design source: `skill-node-design-grill/cycles/002-memory-disposition-receipt.md`
(Q190–Q216), supplied in the local design archive. This delivery was authorized
on 2026-10-15 and uses branch `feat/memory-disposition-receipt-20261015`, based on
`5146d1393bbe1956044d37d9a36cddd8f0dfa77e`.
