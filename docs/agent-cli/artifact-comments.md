# Artifact comments (`coforge artifact comments|comment|review|resolve|reopen`)

Part of [Artifacts](artifacts.md). People and Agents comment on an artifact; this page is what an
Agent does and what the server holds. An Agent is not notified of a comment: it learns of one by
reading.

Every operation is one `operation` of `POST /api/agent/v1/artifacts`, behind the same
`artifacts` experiment as the rest. The daemon's proxy passes on only the fields of each
operation, nested ones (`anchor`, a review's `comments`) included.

## Who may comment

Whoever can read the artifact: the home's readers, or every Workspace member when its tier is
`workspace`. Commenting needs no write access to the home. An artifact the Agent cannot read, a
deleted one and another Workspace's all answer `NOT_FOUND`.

## What a comment is

- `body`: 1 to 8000 characters, trimmed, never empty.
- `path`: the file it is about (a file of the version it is written on); none is the whole
  artifact.
- `anchor`: `{ type, data }`, only with a path (a reply's inherited path counts), `data` at most
  4 KiB as JSON: `file` `{}`, `lines` `{ start, end }` (1-based, `end >= start`), `element`
  `{ selector, quote? }`, `text` `{ quote, prefix?, suffix? }`.
- `version`: the version it is written on; the current one by default (`--rev`).
- `replyTo`: any comment's id. The reply joins that comment's thread (its root is the thread's
  first comment, never another reply) and inherits its path unless it names its own. A reply to a
  resolved thread reopens it.

A comment is addressed by its id, which `comments` prints as `c_<id>`; every command takes it with
or without the `c_`. (A uuid(7)'s first characters are its timestamp, so a short prefix would not
tell two comments apart.)

## Reading: `comments`

`{ artifact, path?, all?, review?, after? }` answers `{ view, comments, nextCursor?,
unseenVersionCount, review? }`, oldest first, 50 a page (`nextCursor` names the next).

- **Unseen** (default): comments by others after the Agent's comment position, deleted ones left
  out. Reading it with no `path` and no `review` moves the position to the last comment returned,
  never backwards: everything the page returned counts as read from then on, so an Agent that needs
  a comment again reads with `all`. A `path` read narrows to one file's first comments and their replies and moves
  nothing: one position cannot mark "these, but not the older ones before them".
- **All** (`all`): everything, the Agent's own and deleted comments (`{ id, deleted: true, ... }`
  without `body` or `anchor`) included; moves nothing.
- **Review** (`review`): that review's summary and its comments, as the all view; moves nothing.

Each comment: `{ id, author: { kind, name }, version, path, anchor, replyTo, body, createdAt,
editedAt, reviewId, resolvedAt, resolvedBy }`; `resolvedAt` and `resolvedBy` are set only on a
resolved first comment. `unseenVersionCount` is how many versions by others came after the
Agent's version position.

The comment position is the Agent's own and separate from its version position
([What's new](artifacts.md#whats-new)), in a table of its own (`artifact_comment_positions`): the
Agent's own push marks versions it made as seen and nobody's comments. Comments are ordered by (`createdAt`, `id`); a write holds a per-artifact lock
and stamps its time after taking it, so commit order and that order agree and a position never
skips a comment committed later.

`read` carries `unseenComments`, `{ count, comments }`, beside `unseen` (which stays about
versions): `count` of the comments by others after the comment position, and the newest five, each
`{ id, author, path, createdAt, excerpt }`, the excerpt at most 200 characters. It is computed on
every read, of an older version and of a current one whose version summary could not be made too
(then `unseen` is `null`), and `null` only when the summary itself failed. It never moves the
position: only `comments` does.

## Writing

- `comment` `{ artifact, body, path?, anchor?, replyTo?, version?, idempotencyKey }` answers the
  comment. The same key with the same words replays it; the same key with other words is a
  `CONFLICT` (`artifact-idempotency-mismatch`). The CLI sends a fresh key per invocation.
- `review` `{ artifact, body?, comments: [{ body, path?, anchor?, replyTo? }, ...1 to 50],
  version?, idempotencyKey }` answers `{ review, comments }`. One transaction: a refusal of any
  comment names its index (`comments[2]: ...`, `details.index`) and nothing is written. The
  review's comments list in the order written.
- `resolve` `{ artifact, comment, note? }` and `reopen` `{ artifact, comment }` answer `{ comment,
  changed, note? }`. Only a first comment: a reply is refused, naming its first comment. Allowed
  for the thread's author (a person or an Agent) and the Agent that made the artifact. People are also
  allowed as the owner of the Agent that made the artifact, and as a Workspace owner or admin; an
  Agent is neither, so its refusal names only the two authors. A thread already in that state is
  left as it is (`changed: false`) and a note is not posted; a `note` is posted first, as a reply
  that does not reopen the thread it closes.

## The unseen gate

A `push`, a `comment` and a `review` are refused with `CONFLICT`,
`artifact-unseen-comments` (409) while others commented since the Agent's comment position:

- **push:** on a file the push changes (the paths it adds, replaces or deletes), on the entry file it leaves and the one it opens at when it
  changes `entry` (an entry-only push touches no file but changes what the artifact opens at), or
  on the whole artifact. A push that changes only settings (title, description, note, label) is
  held up by whole-artifact comments alone.
- **comment, review:** on the same file, the same thread, or the whole artifact. A comment on the
  whole artifact is held up by whole-artifact comments and by comments in its thread.

The refusal's `details` are `count` and `commentIds` (the first ten, oldest first, comma-separated;
a review adds `index`, the first comment it is about). Reading the comments with `comments` clears
it, and the same request sent again succeeds. A request whose idempotency key already landed
replays instead of being refused. The gate never answers for an artifact the Agent cannot read.

The check of a push is part of the push: it runs in the push's transaction after the replay check,
under the artifact's comment lock, which every comment write takes too, so no comment
lands between the check and the commit. An error of the check is the push's error; the gate does
not let a push through when it cannot look.

## CLI

| Command | Does |
| --- | --- |
| `artifact comments <id> [--path <file>] [--all] [--review <id>] [--after <cursor>]` | Prints the unseen comments as threads. |
| `artifact comment <id> [--path <file>] [--lines <n\|a-b>] [--reply-to <c>] [--rev <n>]` | Posts the words on stdin. |
| `artifact review <id> [--rev <n>]` | Posts the JSON on stdin: `{ body?, comments: [...] }` or the bare array; a comment is `{ body, path?, lines?, anchor?, replyTo? }`, `lines` being `4` or `"3-5"`. |
| `artifact resolve <id> <comment> [--note <text>]` | Closes a thread. |
| `artifact reopen <id> <comment>` | Opens it again. |

A thread prints as `c_<id> @author vN path:lines (date)`, the words indented under it (every line
after the first behind `│ `, so a body cannot pass for output), its replies beneath it, and
`[resolved by @name, date]` on a resolved one. `read` and `pull` add `N new comments from others`
with the newest excerpts, beside the versions part and whichever version is read. `--lines` is
expanded into a `lines` anchor; the CLI checks nothing else of a comment's values: the server
judges them and names the field. A push, comment or review refused for unseen comments prints the count
and `Read them first: coforge artifact comments <id>`.

## Storage

`artifact_comments` and `artifact_comment_reviews` (a review's summary, key and request hash), and
`artifact_comment_positions` (`artifactId`, `agentId`, `seenAt`, `seenId`: the last comment the
Agent was shown; no row means none), all going with the artifact. The version position stays in
`artifact_read_positions`. Author columns have no foreign key, as the module's others. A retry's
request hash is the SHA-256 of the request's key-sorted JSON.
