# Computer server modules

These rules apply to `src/server/computers/`.

- `computer-metadata.server.ts` persists last-observed OS and executable
  metadata. The Daemon `ready` message supplies observations only, never
  creator identity.
- A Computer-scoped creator avatar download authorizes Workspace membership
  before resolving the original Computer owner and reading the User avatar
  store.
- `computer-http.server.ts` binds the fixed `/api/computer/workspace` and
  `/api/computer/attach` routes to `workspace:get` and `computer:register`.
  It is composition only; `ComputerRegistrar` owns registration authorization,
  idempotency, and persistence.
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
  Deleting a Computer row or its owner cascades the keys without a record:
  those Computers get the ordinary retryable failure. Add a record there too
  when such a delete path is built.
- A daemon key is valid only while its owner is a member of its Workspace:
  `verifyDaemonApiKey` (`server/auth/daemon-api-key.server.ts`) reads the key
  and that membership in one statement (`PrismaDaemonApiKeyRepository.findByHash`)
  for every caller, the connect proxy, the RPC proxy and the daemon's HTTPS
  routes. Keep the check there, never in one caller.
- `computer-lifecycle-memory.server.ts` is the only store of a shutdown
  reason and of the last daemon instance whose return was announced.
- `computer-agent-workspaces.server.ts` summarizes the Daemon's existing
  workspace-directory observations for the Computer owner's detail inventory.
- `computer-model-catalog-refresh.server.ts` waits for the terminal reply to
  an explicit model probe; ordinary catalog reads use the stored inventory.
  The same probe is the Computer page's "Rescan runtimes": the daemon re-runs
  runtime discovery before it re-reports.
- `computer-runtime-detection.server.ts` marks a Computer as detecting its
  runtimes while a rescan waits (Redis, expiring); the Computer page and a
  move's refusal read it. No daemon state is involved.
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

- `computer-runtime-auth.server.ts` stores structurally validated status reports without a
  provider whitelist, so a newer daemon's report survives an older Web. Provider identifiers
  are 1–64 ASCII identifier characters, at most 32 unique entries, normalized JSON at most
  16 KiB. Unknown fields are discarded and account labels retain Anvil's masking limits.
  Invalid entries are skipped with one content-free warning count; duplicate providers and
  whole-report limit violations reject the report. All display reads still filter through
  Anvil's current providers and viewer visibility.
