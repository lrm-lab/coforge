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
