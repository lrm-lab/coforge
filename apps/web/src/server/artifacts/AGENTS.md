# Artifact server modules

These rules apply to `src/server/artifacts/`. They extend
[`../AGENTS.md`](../AGENTS.md).

The artifacts module is written to be lifted into its own App later; today it
is a module inside the Web server. Three rules keep "moving it
out" a move, not a split:

- Code outside this directory imports only the public entries below, never
  another file here. `test/artifact-boundary.test.ts` enforces it.
- A conversation is reached only through
  [`../conversations/channel-read-access.server.ts`](../conversations/channel-read-access.server.ts):
  home access through `actorConversationHomeReads`, a `#name`/`@name` target
  through `visibleChannelIdByName`/`directConversationIdBetween`. Never the
  conversation tables or their predicates from here.
- Artifact data lives only in the `artifacts` and `artifact_*` tables. No table
  outside this module gains a foreign key to them.

## Public entries

- `artifact-composition.server.ts` — production wiring: `productionArtifacts`,
  `productionArtifactSandbox`.
- `artifact-access.server.ts` — the feature gate (`artifactsEnabled`) and the
  home access predicates external callers need.
- `agent-artifacts.server.ts` — the Agent HTTPS API surface.
- `agent-artifact-files.server.ts` — the Agent API's file bytes: upload by sha256 and download by
  path.
- `artifact-sandbox-config.server.ts`, `artifact-sandbox-http.server.ts` — the
  sandbox origin and its HTTP serving.
- `artifact-blob-sweep.server.ts` — the hourly blob sweep registration.

Everything else is internal: `artifacts.server.ts` (the `Artifacts` use
cases), the merge/read/write/signals/documents/public-links/blobs
modules, and the sandbox implementation.

## Model

The artifacts module follows the reference product, Raft; add nothing it does not have.

- An artifact is a versioned set of files with an entry file. Its type comes from the entry file's
  extension (`artifactKindOfPath`: html, markdown, text, csv, image, pdf, video, other); no request
  field states it and the `kind` column a create still fills is write-only until its drop release.
  Any file may be the entry; only an html or markdown entry is read whole (2 MiB).
- Who sees an artifact: whoever reads its home conversation (`access` `conversation`), or every
  Workspace member and Agent once it is `workspace`; a legacy `homeKey` of `workspace` reads as
  wide. An unseen artifact answers `NOT_FOUND`. A hidden or deleted home leaves it to the author
  Agent, its owner and the Workspace's owners and admins. The Agent `move` widens it (author
  only, `artifact-visibility.server.ts`), a person changes the tier back or forth, and each change
  writes an `artifact_access_events` row. Read and push share one rule; only creating needs
  membership of an unarchived conversation.
- Only an Agent writes, and only by `push` (`Artifacts.push`; `ArtifactDocuments.create` makes an
  artifact with its first version in the same transaction). There is no single-text save, no
  history or revert, no Agent share
  (a person's "send to a conversation" is `artifact-shares.server.ts`), and a person never
  authors or publishes: `Artifact.authorAgentId` and `ArtifactVersion.publisherAgentId` are the
  only writer columns. People read, comment, share and delete.
- A push over an older base merges by path only (`refuseOverlap`): a file or setting both sides
  changed refuses the push with `artifact-base-moved`. Nothing merges inside a file. The entry
  file is what the page shows whole, so a push or create whose entry exceeds
  `ARTIFACT_ENTRY_READ_LIMIT` (2 MiB) is refused (`artifact-entry-too-large`): a larger entry
  could only render blank.

## Web pages and their origins

- A page of artifact `<uuid>` is served only from `a-<uuid>.<sandbox host>`, matched by host name
  alone (`artifact-sandbox-config.server.ts`). Every name under the sandbox host belongs to the
  sandbox and anything but an artifact's origin is refused, so the application's host must never
  be the sandbox host or under it (a boot rule). Locally the sandbox is `http://localhost:<port>`
  and the application runs on `127.0.0.1`.
- Opening is two signed values (`artifact-sandbox-ticket.server.ts`): a ticket, single use (its
  nonce is spent through `TicketNonces`: Redis `SET NX EX`, an in-process map only without Redis;
  an unspendable nonce refuses the ticket, never opens it), then a file token in the path
  (`/_f/<token>/<path>`) good for 10 minutes. A path, not a cookie: the page is a third-party frame
  and a browser may refuse it cookies. Both name the origin they are for and are refused on any
  other. A used or expired ticket answers a small page that posts a `coforge/notifications/frame-status`
  message to the ticket's embedder origin only.
- The page's CSP and headers live in `artifact-sandbox-response.server.ts`; hosts a page may load
  from live only in `artifact-sandbox-cdns.server.ts`. A nonce or hash in `script-src` would turn
  `'unsafe-inline'` off, so the runtime (`artifact-page-runtime.server.ts`) is a script file of the
  page's own origin, injected first.
- A page reader's access is checked on the ticket and on each page document; a subresource serves
  under its file token until the token expires. Do not widen who can read in this module; call
  `ArtifactReads` as it is.
- Known gaps, pinned in `test/artifact-sandbox-browser.e2e.ts`: resource hints still reach out, and
  so does a WebRTC constructor taken from an `about:blank` frame the page makes: every HTML
  document carries `webrtc 'block'` (the frame inherits it) and the runtime removes the page's own
  constructors, but Chrome 157 does not enforce the directive. Flip the test when a browser does.

## Page data and assets

What a page keeps while it runs, reached only from the host (never from the sandbox origin, which
serves GET and HEAD alone): the page's frame asks the host over the bridge, the host calls the
`*.functions.ts` server functions, which call `ArtifactPageData` and `ArtifactPageAssets`
(`productionArtifactPage`). Raft's `db` and `assets`.

- Every call asks `ArtifactReads.artifact` again and derives the level from that one read
  (`pageAccess`): `interact` for a Workspace member who reads it, `admin` where
  `canManageArtifactSharing` holds, `owner` for the author Agent's owner. A method's floor is
  `PAGE_METHOD_LEVELS` (`features/artifacts/artifact-page-levels.ts`), which the bridge also
  enforces; the server's check is the authority. Only an `.html` entry has data or assets.
- `artifact_page_documents` rows are (collection, docId) with a `version` that counts writes
  (`ifVersion` refuses a stale one) and a size; a write runs under its own advisory lock
  (`artifact-page-data:<id>`, never the comment lock), so the caps (64 KiB a document, 5 MiB and
  10,000 documents an artifact) and a batch's atomicity hold. `where` and `orderBy` field names
  are bound as parameters after a charset check; never build SQL from a page's text.
- A write announces `artifact.data.changed.v1` (collection only, no content) after it commits, on
  the channel the artifact's other events use (`announceDataChange`); a watching host reads again
  through its own access. Never publish a document's data.
- `artifact_page_assets` names an artifact blob. The row's transaction marks the blob used
  (`blobs.use`), which keeps the blob sweep away; deleting the row leaves the blob, as a deleted
  artifact's files do. The type is sniffed from the bytes (`sniffPageAsset`): never take it from
  the name, and never serve HTML, script, stylesheet or SVG.
- Assets are served at `/_a/<file token>/<name>` on the page's origin to subresource requests
  only, and that prefix is in the page's `img-src`, `media-src` and `connect-src`, never
  `script-src` or `style-src`. A public-link page has no bridge and no assets.

## Comments

Comments on artifacts are written for Agents (the Agent API's `comments`, `comment`, `review`,
`resolve`, `reopen`); the rules are in `docs/agent-cli/artifact-comments.md`. Their modules:

- `artifact-comments.server.ts` (comment, review), `artifact-comment-threads.server.ts` (resolve,
  reopen), `artifact-comment-reads.server.ts` (the unseen and all reads, the read's summary),
  `artifact-comment-gate.server.ts` (the gate of a push, a comment and a review),
  `artifact-comment-access.server.ts` (who reads, who resolves), plus the write helpers, the
  unseen definition and position, and the views.
- Every comment write runs in `withCommentLock` (a per-artifact advisory lock) and stamps its time
  after taking it (`nextStamp`): listing order, the unseen position and the gate depend on commit
  order and (`createdAt`, `id`) agreeing. Do not insert a comment outside it. It also reads the
  artifact's current version under the lock.
- An Agent's push takes the same lock (`lockComments`) before it locks the artifact's row, the order
  a comment write needs them in, and checks the gate after its replay check, inside its
  transaction (`Artifacts.push`): no comment lands between the check and the
  commit. Errors of the check propagate: the gate never fails open.
- The gate and the unseen read share `unseenWhere`; change the definition of "unseen" only there. A refused write rolls back, so `recordingRefusal` advances the positions after it; a `UnseenChanges` error must keep flat `details` (the Agent API refuses nested ones).
- The comment position is `artifact_comment_positions`, not the version position
  (`artifact_read_positions`): it moves only in `comments` with no filter; a version read, a push
  or `read` never moves it.

## Following and notices

The rules are in `docs/agent-cli/artifact-follows.md`. Their modules:

- `artifact-follows.server.ts` (follow, unfollow, the follow a write makes), `artifact-notices.server.ts`
  (the audience and delivery of a write's notices), `artifact-notice-mentions.server.ts`,
  `artifact-file-authors.server.ts` (what a version changed and who last changed a file, by
  content), `artifact-notice-content.server.ts`, and `agent-artifact-writes.server.ts`, which runs
  a write, the follow and the notices in order.
- Notices are told after the write commits and never fail it: a failure is logged and reported as
  `delivery-failed`. A replayed request tells again what the first attempt did not deliver and
  duplicates nothing: delivery is idempotent per write and recipient. The follow and the re-read of
  the artifact are best effort too.
- Which Agents can read an artifact is asked once, of `agentsReadingArtifact` (the batched form of
  the read rule); never re-derive it in the notice code. Deliveries run four at a time.
- The module defines `ArtifactNoticePort` (plain data: Agent, key, content);
  `artifact-composition.server.ts` connects it to the built-in event source
  (`server/app-agent-events/system-agent-events.server.ts`), which stores the Message. This module
  imports nothing of conversations or events.
- `artifact_follows` goes with the artifact and holds no foreign key on an Agent.
