# Artifact comment modules

Rules for `src/server/artifacts/` comment code. They extend [`AGENTS.md`](AGENTS.md).

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

## People's comments

- `artifact-person-comments.server.ts` (`ArtifactPersonComments`) is the Web seam: list, candidates,
  will-notify preview, post, edit, delete, resolve, reopen and the image upload and read. It takes a
  `CommentPrincipal` (`artifact-comment-principal.server.ts`, tagged `person` or `agent`); the
  write, thread and image modules serve both through it. `unseenGate(principal)` supplies the
  unseen-changes gate and the refusal recorder, which do nothing for a person: a person is never
  gated. `commentColumns` is the one place author, resolver and blob-grant keys come from.
- `artifact-comment-thread-reads.server.ts` pages threads by root (20 a page, cursor `createdAt|id`,
  the count only on the first page), with their replies, and reads comments by id;
  `artifact-comment-mentions.server.ts` lists who can be mentioned. A body's mentions are checked
  by `ArtifactNotices.recipients` (at most `COMMENT_MENTIONS_MAX`; a person's comment naming
  someone who cannot see the artifact is refused, an Agent's names are only reported
  `notNotified`).
- The will-notify preview, the mention check and the real notice share one
  `ArtifactNotices.recipients` call, made once per request; never compute an audience twice. The
  preview takes a body of at most `COMMENT_BODY_MAX` and resolves at most
  `COMMENT_HANDLES_RESOLVED_MAX` handles.
- A person's posts, image uploads and previews are limited per person
  (`artifactPersonComment`, `AppRateLimit`); a refusal is `artifact-rate-limited` with
  `retryAfterSeconds`.
- Only the author edits (text only, no new notices) or deletes. A deletion blanks the row (body,
  anchor to SQL null, the path unless replies keep the thread) and removes its images; their blobs
  are released (`StoredArtifactBlobs.release`) to the sweep unless another comment, file or page
  asset still names them. A root with replies stays as a placeholder and cannot be resolved; one
  without disappears.
- A comment write announces `artifact.comments.changed.v1` (what happened and the comment ids)
  through `announceArtifactComments`; clients fetch just those comments. Person image bytes are
  cleaned once, at upload (`storeCleanImage`), and only the clean bytes are stored; posting reads
  their size and dimensions and stores nothing. An Agent's image is cleaned and stored at post.
- A person's anchor (`text` from a selection, `lines` from line or row numbers) arrives through the
  same `commentDraftInput` as an Agent's and is stored as sent, with the viewed version; the server
  never re-finds a quote, the viewing client does.
- An `element` anchor (`selector`, `quote`) and a `text` anchor on an HTML page come from the page
  runtime's annotation layer through the host bridge, and arrive through the same
  `commentDraftInput`; the server stores them as sent and never re-finds them. The runtime
  limits them tighter than the schema (selector 1000, label 120, context 64) and the host checks
  them again. The page controls its frame, so it can choose what it reports as picked or selected:
  the person sees the anchor's label or quote in the composer before sending and nothing is posted
  without the person sending. A person's anchor quote is text the page chose, and an Agent later
  reads it with the comment: treat it as page content, not as the person's words.
