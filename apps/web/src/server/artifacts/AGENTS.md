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
  home access through `actorConversationAccess`, a `#name`/`@name` target
  through `visibleChannelIdByName`/`directConversationIdBetween`. Never the
  conversation tables or their predicates from here.
- Artifact data lives only in the `artifacts` and `artifact_*` tables. No table
  outside this module gains a foreign key to them.

## Public entries

- `artifact-composition.server.ts` — production wiring: `productionArtifacts`,
  `productionArtifactSandbox`.
- `artifact-access.server.ts` — the feature gate (`artifactsEnabled`) and the
  home/tier access predicates external callers need.
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
  extension (`artifactKindOfPath`: `.html` is a web page, `.md` a document); no column or request
  field states it, and an entry that is neither is refused (`artifact-entry-type`).
- Only an Agent writes, and only by `push` (`Artifacts.push`; `ArtifactDocuments.create` makes an
  artifact from a first push). There is no single-text save, no history or revert, no Agent share
  (a person's "send to a conversation" is `artifact-shares.server.ts`), and a person never
  authors or publishes: `Artifact.authorAgentId` and `ArtifactVersion.publisherAgentId` are the
  only writer columns. People read, comment, share, change the access tier and delete.
- A push over an older base merges by path only (`refuseOverlap`): a file or setting both sides
  changed refuses the push with `artifact-base-moved`. Nothing merges inside a file, and no entry
  file has a size limit of its own (`ARTIFACT_ENTRY_READ_LIMIT` bounds only what the server reads
  whole to show).

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
