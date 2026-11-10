# Computer server modules

These rules apply to `src/server/computers/`.

- `computer-list-visibility.server.ts` is the list/search filter for Workspace
  members: another person's account default cloud Computer is omitted; extras
  and local Computers stay. Host jobs, daemons, and Agent placement that read
  links directly are unchanged.
- `computer-metadata.server.ts` persists last-observed OS and executable
  metadata. The Daemon `ready` message supplies observations only, never
  creator identity.
- A Computer-scoped creator avatar download authorizes Workspace membership
  before resolving the original Computer owner and reading the User avatar
  store.
- `computer-http.server.ts` binds the fixed `/api/computer/workspace`,
  `/api/computer/attach`, and `/api/computer/roster` routes to `workspace:get`,
  `computer:register`, and `computer:list`.
  It is composition only; `ComputerRegistrar` owns registration authorization,
  idempotency, and persistence.
- `roster.server.ts` lists the signed-in User's owned local Computers for
  explicit setup adoption; it never returns another User's rows.
- `desktop-proxy-auth.server.ts` answers Caddy before it forwards
  `/desktop/<computer id>/...`. The signed-in user must own that cloud
  computer. A missing session, any other computer, or a path that is not a
  desktop is refused. The route is `/api/internal/desktop-authorize`.
- A flow that removes a Computer from a Workspace calls
  `DaemonCredentialRevocations.recordForComputer(tx, {workspaceId, computerId})`
  inside its transaction, before anything revokes or cascades those daemon
  keys, so the Computer parks that binding with `computer_unlinked`. After the
  commit it calls `reconnectDaemon` for that binding: the open connection is
  not re-checked until it reconnects, and the reconnect meets the refusal.
  A member leaving or being removed is such a flow for every Computer they own
  there: `unlinkDepartingMemberComputers` (`computer-membership.server.ts`)
  records and revokes the daemon keys they own in that Workspace, by owner, and
  removes their Computers' links to it, never touching another Workspace's.
  `previewDepartingMemberComputers` answers the same set for a confirmation
  dialog before the departure, with each Computer's live Agents (names only
  for Agents `viewer` may see; the count stays whole). Deleting a Computer row
  or its owner cascades the keys without a record: those Computers get the
  ordinary retryable failure. Add a record there too when such a delete path
  is built.
- A daemon key is valid only while its owner is a member of its Workspace:
  `verifyDaemonApiKey` (`server/auth/daemon-api-key.server.ts`) reads the key
  and that membership in one statement (`PrismaDaemonApiKeyRepository.findByHash`)
  for every caller, the connect proxy, the RPC proxy and the daemon's HTTPS
  routes. Keep the check there, never in one caller.
- A `daemonApiKey` migrates to `sk_computer` (`kind: "computer"`) through
  `POST /api/computer/swap-key` (issues the new key without revoking the old),
  save the new key to the daemon's credential file, then
  `POST /api/computer/confirm-key` (revokes the old key and any prior unconfirmed
  `sk_computer`s). A repeated `swap-key` revokes the unconfirmed `sk_computer`s
  first — the server keeps hashes and cannot replay a lost plaintext key.
  `GET /api/computer/self` verifies a key answers for the same Computer; the
  startup migration does not call it. The
  stored key is opaque to the daemon: an older binary reads the same
  (workspaceId, computerId) credential file and uses an `sk_computer` everywhere
  a `dk_` went, so downgrading past the cutover needs no re-attach
  (`packages/daemon/test/computer-key-migration.test.ts` locks this). The
  computer-self endpoints (`self`, `detach`, `swap-key`,
  `confirm-key`) authenticate through `authenticateLinkedDaemon` and accept
  only `kind: "computer"`; the daemon's other routes accept either key during
  the transition.
- `computer-lifecycle-memory.server.ts` is the only store of a shutdown
  reason and of the last daemon instance whose return was announced.
- `computer-workspace-files.server.ts` requests one local Daemon workspace scan
  for the Computer owner's detail inventory; the Daemon owns directory traversal.
- `computer-local-sessions.server.ts` and its production composition own the Computer-owner gate and short-lived request/reply flow for bounded local Claude Code and Codex Session discovery; `local-session-capability.server.ts` rejects old daemons before publication.
- `computer-model-catalog-refresh.server.ts` is an explicit model probe — scoped to one provider when
  the request names it; ordinary catalog reads use the stored inventory. The same probe is the
  Computer page's "Rescan runtimes": the daemon re-runs runtime discovery before it re-reports.
  Production closes a request idle for about ten seconds and a whole-Computer rescan runs its
  runtimes one after another, so, as the reference Computer acknowledges a rescan and reports it
  separately, it is two calls like the reset credit: `start` publishes and returns a request id (or
  `refused` for a Computer the viewer does not reach, or `failed` with nothing sent), and `read`
  returns pending or the settled per-provider outcome. `read` answers only a request that names the
  caller's Workspace and Computer, says pending without authorizing until an answer exists, and
  then re-checks the Computer link and the viewer's runtime visibility. Each provider's outcome
  reports separately. The request stays pending for 60 seconds and a stored answer lives 30 seconds,
  both expiring on their own.
- `computer-runtime-detection.server.ts` marks a Computer as detecting its runtimes; the Computer
  page and a move's refusal read it. The mark (Redis) names the request that set it, expires after
  45 seconds (the daemon's probe budget, under the page's 50 second wait), and only that request
  ends it; a request that begins meanwhile takes the mark over, so the Computer detects until the
  newest ends. It begins at `start` and ends when the daemon's result for that request arrives
  (`model-refresh-result-method.server.ts`, before the result is stored, so a closed page cannot
  leave it set and a page that reads the result never sees it), or when a failed start sent nothing.
  No daemon state is involved.
- `computer-workspace-files.server.ts` is the owner scope for that inventory's
  scan and for workspace delete: the owned-Computer lookup, the Agent
  assignment rule, and the Workspace Files query both server functions use.
- `runtime-auth.server.ts` signs a Code Agent runtime in or out on a Computer through the daemon.
  Only the Computer's owner and an owner or admin of a Workspace it is connected to may
  (`runtime-auth-authorization.server.ts`). `runtime-auth-store.server.ts` allows one login per
  provider per Computer, not per Workspace, and its lock and login record are written together.
  The pasted code goes to the daemon control channel once and is never stored or logged. Progress
  reaches only the person who started the login, on `runtimeauth:user:<user_id>`; a page that was
  closed reads it with `readRuntimeAuthLogin`. A stale or repeated report is accepted and dropped,
  a report for a login the Computer does not hold is a 403, and a store failure is a 503 so the
  daemon retries.

- `runtime-reset-credit.server.ts` spends one Codex rate-limit reset credit on a Computer for the
  usage popover. The server authority is `PrismaRuntimeAuthAuthorization.canManage` (the
  Computer's owner, or a Workspace owner or admin who sees the runtime on the Computer page; never
  another member's default cloud Computer), the same rule that lets them read and scan the usage
  that shows the button (`runtime-usage-access.server.ts`).
  - `start` never waits: production closes a request idle for about ten seconds and the Computer
    can take up to about 90, so the page polls `read`. Refusals are values, in this order:
    `forbidden`, `offline`, `needs_upgrade` (the `runtime-usage:reset-credit:v1` lease).
  - `read` answers only a request that names the caller's Workspace, Computer and runtime and
    passes `canManage`; until then it says pending without a database read.
  - `unknown` means the credit may have been spent. Every path that cannot say otherwise ends
    there, never in a refusal: no answer in time, a publish that failed (the request may have been
    delivered), the page going away. The page keeps the attempt's idempotency key through
    `unknown` so a retry cannot spend a second credit. Only a store that cannot record the request
    throws, because nothing was sent.
  - The idempotency key is validated here and at the schema, goes to the Computer as given, and is
    never logged.
  - The usage the Computer read afterwards is stored from the result RPC under the request id,
    before the outcome is readable; a page that finds another scan id in the cache scans itself.
    The result RPC also ends any usage scan in flight, with or without a reading, so that scan
    never joins one that began before the spend and reads the old count.
- `runtime-auth-authorization.server.ts` (`PrismaRuntimeAuthAuthorization.canManage`) is the one
  rule for managing a runtime: sign-in and sign-out (`runtime-auth.server.ts`), the reset credit,
  and reading and scanning usage all ask it, and nothing restates it. The Computer's owner, or an
  owner or admin of a Workspace the Computer is connected to, and never a removed Computer
  (`liveComputerWhere`, the list's own condition); another member's default cloud Computer is
  refused to everyone but its owner (`defaultCloudComputerHiddenFromViewer`, the list's rule too),
  so an admin who holds its id reaches none of them by API either.
  - A call that names the runtime (`provider`: start of a sign-in, a status re-read, sign-out, the
    reset credit) also needs the runtime visible to the viewer as the Computer page lists it
    (`runtimeVisibleToViewer`, which `ComputerRuntimeVisibility.list` uses): the Computer owner's
    always, an admin another member's only once public. The continuing calls of a login (code,
    cancel, reads) are asked again with the provider stored on the login, so a runtime made private
    mid-login ends the admin's login. Usage names no provider: it already reads the runtime row and
    applies `runtimeVisibleToViewer` to it, which saves a query on a poll every 100 ms.
  - Whether a runtime can start (`unavailableCode`) is not part of it: the Computer page withholds
    usage and sign-in from such a runtime, and only the Agent profile's `usageOffer` repeats that.
- `runtime-usage-access.server.ts` is the gate for reading and scanning one runtime's usage
  (`readUsage` / `scanUsage`): `canManage`, on a runtime the Computer reported. Usage carries the
  account and plan, so never read the usage cache outside it for a viewer. What offers the usage
  asks `usageOffer`, never its own rule: the Agent profile's `runtimeUsageVisible` (readable and
  able to start, as the Computer page) and runtime version come from it (`runtime-usage-composition.server.ts` builds it for both).
  - Only the Computer's owner (the runtime row's `ownerId`) reads the cached reading whole. Anyone
    else gets `drawnReading`: the fields the popover draws, named one by one, so a field a newer
    Computer reports reaches them only once the popover draws it and it is added there. The credit
    balance, `lastAttemptAt` and the snapshot's own `collectedAt` never go, and a failure's
    `message` only as the one line the popover compares it with.
  - The snapshot reaches a browser only through `readUsage`: `scanUsage` returns the scan id,
    `readResetCredit` the outcome, and the reset reading goes to the usage cache.
  - A scan already in flight for the runtime is joined, not started again
    (`createUsageScan`, `../centrifugo/AGENTS.md`). The id it hands back reads nothing by itself:
    `readUsage` is keyed by the caller's own authorized Workspace, Computer and runtime.
- A login report that changes a runtime's login (signed in or out, another account) ends that
  runtime's running usage scans in every Workspace the Computer is in (`runtimeAuthScanEnder`),
  after storing it and before announcing it, so the scan a page starts once it learns of a
  sign-in never joins one that began before it. A report that restates the login ends nothing.
- `command-code-effort-read.server.ts` reads one Command Code model's reasoning efforts from a
  Computer for the Agent form. The Computer can take about 30 seconds and production closes a
  request idle for about ten, so it is two calls like the reset credit: `start` publishes and
  returns a request id (or `failed`), `read` returns pending or the answer. Both need
  `ComputerRuntimeVisibility.canSelect` for Command Code. `read` answers only a request that
  names the caller's Workspace and Computer and authorizes only once an answer exists; the
  answer expires on its own (30 seconds) so a lost reply can be asked for again. Every failure is
  one value, `failed`; the read changes nothing, so a failed start is just tried again.
- `computer-agent-context-views.server.ts` asks a local Computer to restore an Agent's context
  (`agentContextView` flag, Computer owner only). The Computer restores for up to about 25
  seconds and production closes a request idle for about ten, so it is two calls: `start`
  publishes and returns a request id, or a refusal value with nothing pending; `read` returns
  pending or the result. `read` answers only a request that names the caller's Workspace,
  Computer and Agent, checks the flag and the Computer's owner again once a result exists, and
  leaves the result to expire (35 seconds) so a lost reply can be asked for again. Never hold a
  request for the result.
- `computer-file-upload.server.ts` places an owner's browser upload in the Computer's `uploads/`.
  Production closes a request idle for about ten seconds and storing the object plus the Computer's
  pull can take minutes, so it is two calls. `start` (behind `POST /api/computers/<id>/file-uploads`)
  answers once the body is validated and the status record is written, with an upload id or a
  refusal (`too_large`, `invalid_name`, `unavailable`, `storage_unavailable`, `offline`,
  `unsupported`); nothing is stored for a refusal, and a record that cannot be written throws. The
  server then stores the object and asks the Computer to pull it, never awaited by the request.
  `read` (`readComputerFileUpload`) returns the record: pending, placed (with the path the Computer
  used) or failed with a reason. Both need the Computer's owner; `read` answers pending from the
  record alone and checks ownership once there is an outcome. The record lives in Redis under the
  Workspace, Computer and upload id, and names its owner (`computer-file-upload-statuses.server.ts`).
  Pending is a 90 second lease the running upload renews every 15 seconds (a renewal also makes a
  record that expired during a Redis stall pending again, and never touches an outcome), so a web
  process that restarts mid-upload leaves a record that expires and reads as failed, as does any
  id that is missing or not the reader's. The outcome is written with a few retries and stays
  readable for 10 minutes; the stored object is removed, best effort, once the outcome is known.
  A shutdown after the pull request is published can still place the file on the Computer though
  the page reads failed, and leaves the stored object behind. The page's deadline
  (`features/computers/computer-file-upload-poll.ts`) must stay past the server's store and pull
  limits (`COMPUTER_FILE_UPLOAD_TIMING`).
- `computer-runtime-auth.server.ts` stores structurally validated status reports without a
  provider whitelist, so a newer daemon's report survives an older Web. Provider identifiers
  are 1–64 ASCII identifier characters, at most 32 unique entries, normalized JSON at most
  16 KiB. Unknown fields are discarded and account labels retain Anvil's masking limits.
  Invalid entries are skipped with one content-free warning count; duplicate providers and
  whole-report limit violations reject the report. All display reads still filter through
  Anvil's current providers and viewer visibility.
