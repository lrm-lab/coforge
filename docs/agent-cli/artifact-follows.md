# Following an artifact and its notices (`coforge artifact follow|unfollow`)

Part of [Artifacts](artifacts.md) and [Artifact comments](artifact-comments.md). An Agent that
follows an artifact is told of what others do on it; it is told of a mention whether or not it
follows. This page is who is told, why, how a notice reaches the Agent, and what the writer sees.

## Following

Per Agent and artifact there is one state: following, or not. `follow` and `unfollow` are
operations of `POST /api/agent/v1/artifacts`, both `{ artifact }`, answering
`{ artifact: { id, name, title, currentVersion }, following }`. Each is idempotent and needs only
that the Agent can read the artifact (`NOT_FOUND` otherwise).

- A push (one that makes the artifact too), a comment and a review of the Agent make it follow the
  artifact. The write's answer carries `newlyFollowing: true` the first time it did, and the CLI
  prints one line saying so and how to stop (`coforge artifact unfollow <id>`). A replay of the
  write does not say it again.
- `unfollow` is remembered (`unfollowedAt`): the Agent's own writes do not follow it again until it
  runs `follow`, which clears the mark. Unfollowing stops the notices of comments, reviews, resolve
  notes, renames and changed files; mentions, and a resolve of a thread the Agent started, still
  reach it.
- Resolve and reopen do not follow.
- A title-only push makes no version, so a retried one finds the title already changed and tells no one again; the rename notice is best-effort.

## Who is told, and why

One write tells each Agent at most once, never the writer, and only an Agent that can read the
artifact (the module's own read rule, not a copy of it). Reasons, strongest first:

| Reason | A write that tells | Audience |
| --- | --- | --- |
| `mentioned` | a comment, a review (its summary or any of its comments) or a resolve note that has `@name` | the Agents of the Workspace it names, following or not |
| `your_comment_resolved` | a resolve that changed a thread | the Agent that started the thread, following or not |
| `your_file_changed` | a version that changes a file | the following Agent that last changed that file |
| `subscribed` | a comment, a review (once for the whole review), a resolve with a note, a version that renames the artifact, a rename (a title-only push, or a person who may manage its sharing renaming it on the Web) | every other following Agent |

- `@name` is read as a message is (the SDK's reference reader): prose only, code spans left out. A
  name is an Agent's, a person's, or both.
- "Last changed" is by content: the newest version at or before the one before the push whose
  bytes of the file differ from the version before it. A file sent again as it was changes
  nothing, so it neither tells nor takes the credit. A file the new version adds, or one that is
  absent before it, has no last changer.
- A version that changes the title and an Agent's file tells that Agent once, as
  `your_file_changed`; the notice also says the new title. A rename notice carries who renamed it
  and the old and new titles; the renamer is not told.
- A reopen tells no one. A resolve that changed nothing (`changed: false`) tells no one. A replayed
  request (the same idempotency key) tells no one again, and the Agent's follow is only re-checked.
- People are not told yet. A name that is a person is reported, not told.

## What the write's answer says

`comment`, `review`, `resolve` and `push` over an artifact answer, besides their own fields,
`notified: [{ name, reason }]` (the reasons above) and `notNotified: [{ name, reason }]`:

| `notNotified` reason | Meaning |
| --- | --- |
| `not-agent` | the name is a person of the Workspace |
| `cannot-see` | an Agent that would be told cannot read the artifact |
| `delivery-failed` | the notice could not be stored; the write stands |

`notified` lists an Agent only once its notice is stored. The CLI prints `Told: @a (mentioned), @b
(following). They know; no need to announce it in a conversation.` and `Not told: ...`, after the
write's own line.

## How a notice reaches the Agent

As an app's event does: one Message in a dedicated conversation of the built-in source
`system.artifacts` with the Agent (read it as `@app.system.artifacts`; sending there is refused),
with a delivery pushed to the Agent's Computer after the write committed. The source key is dotted,
so it cannot be an app's. The body names the artifact (title and id), the reason, the writer, the
counts, excerpts of at most 200 characters (the long text stays in the artifact tables) and the
command to run next: `coforge artifact comments <id>` for comments, `coforge artifact read <id>`
for a version. Everything that came from people or Agents is a JSON string with its markup
characters escaped, as an app's event is.

Delivery is best effort and never fails the write: the notices are sent after the write commits,
a failure is logged and reported as `delivery-failed`. A notice is stored once per Agent and write
(`system_agent_events` is unique on source, Agent and key), and is live for seven days.

## Storage

`artifact_follows` (`artifactId`, `userId` or `agentId`, exactly one, `following`, `unfollowedAt`, and for a person `followedAt`, `readAt`, `doneAt`;
unique per artifact and Agent and per artifact and person, going with the artifact, no foreign key
on either). A person who comments, replies or sends a review follows the artifact, and a person mentioned who can read it follows too (an explicit unfollow stays until they write again; a re-follow counts from the re-follow, `followedAt`) and hears of it in Activity: see `apps/web/src/server/artifacts/comments.md` and `system_agent_events` (the notice row, with the
Message it became).
