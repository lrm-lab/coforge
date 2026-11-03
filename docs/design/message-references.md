# Message reference model

How a message names another thing — a person, a channel, a thread, a task — and where that
reference lives. The short version: **identity is a stable id, the display is resolved per reader,
and the reference is a row, not a token in the text.**

This replaces the per-kind token grammar (`<@task:c:…>`, `<@channel:…>`, `<@thread:…>`,
`<@agent:…>`) for everything written from v2 on. Tokens remain readable for messages written before
it; nothing new writes them.

## Why the token model is not the long-term shape

The current tokens put all three jobs in one string in the body:

- the **identity** (a task number, a channel name, a peer handle),
- the **display** (`#channel:#N`, `dm:@peer:#N`),
- the **representation** (an inline `<@…>` syntax only our readers understand).

That makes each new reference kind a new grammar and pattern, forces every plain-text consumer
through a parser, makes backlinks (“which messages mention this task?”) a scan, and ties a reference
to a label that may change: a task number is scoped to its conversation, a channel can be renamed,
and a future move between projects must not break old references.

## The model

### Identity

A reference targets an **id**: `Task.id`, `Conversation.id`, `Message.id`, `User.id`/`Agent.id`. It
never targets a number, a channel name or a handle. Numbers and handles are labels the reader sees;
they can change without touching references.

`#channel:#N` and `dm:@peer:#N` stay the writing syntax people use (and Raft's), but they are
resolved to ids at write time. The text is what a person typed; the row is what the system knows.

### Representation

A new table, one row per reference:

```
message_references(
  messageId, workspaceId,
  kind,          -- task | channel | thread | mention
  targetId,      -- Task.id / Conversation.id / Message.id / User.id|Agent.id
  snippet,       -- the text the sender wrote, exactly: `#coforge:#448`
  ordinal,       -- which occurrence of that snippet in the body this row means (0, 1, …)
  createdAt
)
```

- The body stores **human-readable text**: `#coforge:#448`, `dm:@alice:#7`, `task #3`, `@ada`,
  `#design`, `#design:1a2b3c4d`. No `<@…>` tokens are written from v2 on.
- Readers do **not** store or trust character offsets. They parse the body with the shared
  recognizer, take each reference in reading order, and match it to its row by the text fragment
  and the occurrence number. A body with no rows renders as plain text.
- `targetId` is indexed: “messages referencing this task” is one query, and realtime can subscribe
  to a task's references instead of re-reading a conversation window.
- No titles, statuses or names are stored: display is resolved at read time, per reader, from the
  target. A deleted target falls back to the text the sender wrote.

One mechanism covers every kind. A new kind (artifact, app, computer) is a new `kind` value and a
new renderer, not a new grammar.

### Permissions

Resolution is per reader, at render:

- a task in a channel the reader may read shows its title/status and opens;
- a task in a private channel the reader is not in, or a DM the reader is not part of, reads as
  **“a task you cannot view”** — no channel name, number, title or status (a private channel's name
  is itself information);
- an unknown or deleted target reads as the sender's text, never as a broken chip.

The same rule applies to Agent-facing text (`readableBody`) and to the web.

### Writing and editing

- On send (and on edit), parse the body once with the shared grammar, resolve every reference the
  sender may resolve, and write the rows in the same transaction as the message.
- A reference the sender may not resolve stays plain text: no row, nothing to leak.
- An edit replaces the message's rows (a new parse, new fragments and ordinals); a delete
  cascades. Nothing can point at a stale byte position.
- At most one reference per span; overlapping matches follow the recognizer's precedence (message
  and thread references before a task, a prefixed task before a bare `#N`, prose only — code,
  links and HTML are never references).

### Realtime

A rendered message asks for the targets its rows name. When a task changes, the reference re-reads
that task's label; no whole-message re-render and no conversation reread.

## Migration (v2, the end state)

There is no separate v3. The token version already merged ships disabled (`task-ref-tokens` is never
enabled); v2 replaces it:

1. **Schema**: add `message_references` (additive), indexed by `targetId` and by `messageId`.
2. **Write**: parse and write rows plus the readable body; stop writing tokens entirely.
3. **Read**: web and Agent text render from rows; the token reader stays only for messages written
   before v2.
4. **Backfill**: a one-off, idempotent pass converts stored tokens to rows and readable text (tokens
   are unambiguous, so this is safe). Older messages that only ever had plain `#channel:#N` text
   keep that text; they are not guessed into references.
5. **Retire**: once the backfill is done and no client writes tokens, the token patterns move to a
   legacy read-only module. No v3.

## What stays the same

- The written syntax people use remains Raft's: `#channel:#N`, `dm:@peer:#N`, `task #N` / `#N`
  for the current conversation, `@handle`, `#channel`, `#channel:msg`.
- Task numbering stays per conversation (Frank, 11-03). Because references point at ids, moving a
  task to a project later never rewrites a reference or a number.
- Plain-text readers (CLI output, copies, notifications) keep reading readable text; they do not
  need the rows.

## Raft

Only Raft's CLI (`cli.cjs`) is available to compare: it parses references from text at use time
(`createRaftChannelTaskRefRegex`, `createRaftDmTaskRefRegex`, `createRaftBareTaskRefRegex`) and has
no observable storage or rendering contract. The written syntax matches Raft; the structured
storage is our own improvement, not a divergence a reader can see.
