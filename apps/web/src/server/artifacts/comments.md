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

## Drafts and review send

- A person's drafts (`artifact_comment_drafts`) are private to the author: no other person, no Agent
  and no API reads them. `ArtifactCommentDrafts` (`artifact-comment-drafts.server.ts`, composed as
  `drafts`) lists, creates, edits (body only), deletes and discards; a create may carry the
  creation time of a draft being restored, which keeps its place in creation order (clamped to not
  after now and not before the 30-day window; expiry restarts from now); at most `COMMENT_DRAFTS_MAX`
  per person per artifact (checked under the `artifact-drafts:<artifactId>:<userId>` advisory lock,
  always taken after the comment lock). A draft expires 30 days after its last change and is swept
  hourly by `artifact-comment-draft-sweep.server.ts` (`FOR UPDATE SKIP LOCKED`), before the blob sweep.
  A person who loses access to the artifact cannot read their drafts; they stay stored until they
  expire and are readable again if access returns.
- The HTML page's runtime is sent the anchors (never the bodies or images) of the viewer's own
  drafts as marks, like the anchors of sent threads, so the page can draw them.
- Draft images are stored in the draft's `images` column; `NO_OTHER_REFERENCE` counts them, so a blob
  a draft holds is never swept; a GIN index on `images` serves that check. Draft rows are locked
  (`lockedDrafts`, one `SELECT ... FOR UPDATE`) while a send, an edit or a delete reads them.
- Send (`artifact-comment-drafts-submit.server.ts`) takes the client's draft ids and a client key.
  A set that differs from the person's current drafts is `artifact-drafts-changed`. Every draft is
  validated (mentions, file in its version, version, reply target) in one pass; the first failure
  in creation order, mention checks included, returns `{status: "rejected", draftId, reason}` and
  writes nothing. The mention audience is resolved once for the union of the drafts' handles and
  attributed to each draft in memory; the one mention rule is `requireMentionable`, which a direct
  post throws from and the send maps to a refusal. Otherwise the drafts
  become comments in creation order in one transaction under one review (`version` is the highest
  draft version), the drafts are deleted, and Agents are notified once per review. A retry with the
  same key and ids returns the same review; the same key with other ids is a conflict.
- A reply draft stores no path; the comment takes its parent's at send.

## Activity

- One Activity item per artifact the person follows and can read (`visibleToMemberSql`), in the one
  `items` list beside conversations (`kind: "artifact"`). The state lives on the follow:
  `followedAt` (a re-follow sets it again), `readAt`, `doneAt`. An event counts when it is at or after
  `followedAt` and is not the person's own (their own comments and versions; an Agent they own is
  another author). The item is listed while an event is newer than `doneAt`, and unread while one is
  newer than `GREATEST(readAt, doneAt, openedAt)`. Mark read and Read all keep it listed without the
  dot, Done and Done all remove it, and Undo restores the previous `readAt` and `doneAt`. Every
  Activity write targets only the caller's own follow of an artifact they can read, with the item's
  server time as its fence; it never writes `artifact_viewer_positions`. Opening sets `openedAt`; an
  open, visible page keeps it moving as comments and versions arrive (`markArtifactSeen`, coalesced on the page: one in flight, one trailing, 3 s apart; it announces only when it cleared an unread state). Read-all and Done-all take only artifacts with an event at or before their bound, and Undo restores `readAt` only where it still equals the Done's time.
- `artifact_comment_mentions` (person, artifact, and exactly one of a comment or a review, with
  `mentionedAt`) is written in the write's transaction from the SDK resolver (`mentionHandles`;
  person mentions, never the author; a review body's mentions belong to the review; an edit rewrites
  the rows; a delete removes them) and is the only source of mention items, the Mentions view, the
  gallery's @ badge and the wake. A mentioned reader follows in the same transaction, from the
  mention (`followedAt` = the mention's time). Backfill of old comments and reviews:
  `apps/web/scripts/backfill-artifact-comment-mentions.ts` (see the production README); it takes each
  comment's row lock and resolves the locked body, so an edit never loses to it, and follows no one.
- `artifact-activity.server.ts` is the one derivation behind the list and the nav dot: it starts
  from the person's follows, filters with EXISTS before aggregating (the dot is EXISTS only), and
  reads edits as a second range, not an `OR`; the page cut comes first and the page's rows alone get
  their counts, latest event and preview.
- A person who posts a comment, reply or review follows the artifact in that transaction. Every
  write returns one `AfterWrite` (none for a replay or an edit that changed nothing, none for
  version 1); `settleWrite` (`artifact-activity-wake.server.ts`) works out the audience once,
  followers and mentioned readers except the writer, and publishes `activity.changed.v1` in batches of
  50 off the request path (`ArtifactSignals.background`, detached in production, collected in tests);
  a failure is logged and never fails the write. Opening, marking read and Done wake the person's own
  other pages (`announceActivityAttention`); deleting a comment wakes the people its mentions told.
