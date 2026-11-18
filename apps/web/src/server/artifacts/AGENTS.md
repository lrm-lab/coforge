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
  field states it.
  Any file may be the entry; only an html or markdown entry is read whole (2 MiB).
- Who sees an artifact: whoever reads its home conversation (`access` `conversation`), or every
  Workspace member and Agent once it is `workspace`; a legacy `homeKey` of `workspace` reads as
  wide. An unseen artifact answers `NOT_FOUND`. A hidden or deleted home leaves it to the author
  Agent, its owner and the Workspace's owners and admins. The Agent `move` widens it (author
  only, `artifact-visibility.server.ts`), a person who manages its sharing changes the tier back
  or forth, and each change writes an `artifact_access_events` row.
  Narrowing back needs a viewer who can still read the home (else `NOT_FOUND`
  `artifact-home-unseen`), an author Agent still seated and active there (`artifact-author-not-member`,
  `artifact-author-cannot-see`), and the `expectedLost` count the confirm showed to match the count
  at commit (`artifact-loss-changed`); it also revokes the live public link in the same transaction.
  Read and push share one rule; only creating needs membership of an unarchived conversation.
- Only an Agent writes, and only by `push` (`Artifacts.push`; `ArtifactDocuments.create` makes an
  artifact with its first version in the same transaction). There is no single-text save, no
  history or revert, no Agent share
  (a person's "send to a conversation" is `artifact-shares.server.ts`), and a person never
  authors or publishes: `Artifact.authorAgentId` and `ArtifactVersion.publisherAgentId` are the
  only writer columns. People read, comment, send, rename (managers only, a title-only change that makes no version) and delete.
- A push over an older base merges by path only (`refuseOverlap`): a file or setting both sides
  changed refuses the push with `artifact-base-moved`. Nothing merges inside a file. The entry
  file is what the page shows whole, so a push or create whose entry exceeds
  `ARTIFACT_ENTRY_READ_LIMIT` (2 MiB) is refused (`artifact-entry-too-large`): a larger entry
  could only render blank.

## Web pages and their origins

See [web-pages.md](./web-pages.md).

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

Agents comment through the Agent API and people through the Web; the rules and modules are in
[comments.md](comments.md) and `docs/agent-cli/artifact-comments.md`.

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
- People hear of artifact activity through the Activity inbox: `artifact-activity.server.ts` is the public
  entry (the derived rows, their details, `settleWrite`); `server/inbox/` unions the rows into
  the list and the nav dot and imports nothing else of this module.

## People's reads and writes

- `artifact-gallery.server.ts` pages the Artifacts gallery (readable artifacts only, sorted in
  memory over narrow id rows, cursor `[key, id]`) and marks a card's updates, new comments and
  mentions; "related" means authored by my Agents, commented or followed (a person's mention comes
  with people commenting on the Web). New comments count in SQL from the opened time; only the
  unseen bodies are read, for the mention badge. A conversation's cards take one marks request.
- `artifact-viewer-positions.server.ts` keeps `artifact_viewer_positions` (opened time, highest
  version seen; no foreign key on a user) and the roster: the latest openers plus the people the
  page says are viewing (Centrifugo presence), never anyone without a row. A person's
  `artifact_follows` row is `artifact-person-follows.server.ts`.
- `artifact-rename.server.ts` renames under a row lock, also the current version's title, and
  tells Agent followers through `ArtifactNotices` (best effort). `artifact-version-history.server.ts`
  lists versions with what each changed.
- `artifact-download.server.ts` serves one file or a stored (uncompressed) zip whose blobs are all
  checked before the 200 (a missing one is `NOT_FOUND`) and then streamed one at a time, limited per person a minute (`artifactZip`), refused over
  `ARTIFACT_ZIP_LIMIT_BYTES` (`artifact-zip-too-large`), and the capped text preview of a
  file; an image is never previewed, the page loads it from the versioned download URL. `artifact-visible.server.ts` is `visibleToReader`.
- A share to a `conversation`-tier artifact with no live public link is held, sending nothing,
  when recipients cannot read it elsewhere; `unseen: "send"` overrides the hold. The caller passes
  the sender's post check (`mayPost`) with `send`, and the hold runs it on every target before
  counting anyone, since this module reaches conversations only through `channel-read-access`.
