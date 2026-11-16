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
  extension (`artifactKindOfPath`: `.html` is a web page, `.md` a document); no request field
  states it, the `kind` column a create still fills is write-only until its drop release, and an
  entry that is neither is refused (`artifact-entry-type`).
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
- The gate and the unseen read share `unseenWhere`; change the definition of "unseen" only there.
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
  `delivery-failed`. A replayed request tells nobody, so a write returns whether it was fresh.
- Whether an Agent can read an artifact is asked of `requireArtifactRead` through `agentCanRead`
  alone; never re-derive it in the notice code.
- The module defines `ArtifactNoticePort` (plain data: Agent, key, content);
  `artifact-composition.server.ts` connects it to the built-in event source
  (`server/app-agent-events/system-agent-events.server.ts`), which stores the Message. This module
  imports nothing of conversations or events.
- `artifact_follows` goes with the artifact and holds no foreign key on an Agent.
