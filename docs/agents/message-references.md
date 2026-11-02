# Message reference recognition

The one send-time recognizer of a message body's references, in
`apps/web/src/lib/message-references.ts`. It reads the Markdown syntax tree the renderer reads —
the same dialect (`parseMessageSyntax`) over the same input (`messageSource(body)`) — so only what
the renderer shows as prose is ever a reference: nothing under code, a code block, a link (a GFM
autolink included), a link reference, a definition or HTML is read.

Each prose `text` node is read left to right against one ordered set of alternatives:

1. a mention, `@handle` (`MENTION_PATTERN`);
2. a thread reference, `#name:shortid` (`THREAD_REFERENCE_PATTERN`): one top-level message of that
   channel, named by a unique 6–12 hex prefix of its id or by the whole id;
3. a task reference, `task #N` (`TASK_REFERENCE_PATTERN`);
4. a bare `#N` (`BARE_TASK_REFERENCE_PATTERN`): one of the conversation's tasks, otherwise a
   channel of that name;
5. a channel reference, `#name` (`CHANNEL_REFERENCE_PATTERN`).

The earliest match wins, and at the same position the earlier alternative wins. A match is
consumed whether or not it resolves, which is what gives each reference its precedence: a thread
reference's `#name` is never also a channel, and the `#N` of `task #N` is never also a channel.
A bare `#N` therefore carries its own fall-through: it is read with the whole `#name` run it
starts, and resolves to the task N, else the channel that run names. When the run is longer than
the number (`#132-plan`), a channel with that whole name comes first, so a channel name that
starts with digits still reads whole; failing that, the number is still the task. Only the
channel reading needs the whole run written exactly: in `#5-\_b\_` the escapes rule out a
channel, but the `#5` is written exactly and is still the task.

An unresolved thread reference — no such channel, no such message, or a prefix two messages
share — stays text as a whole: its `#name` is consumed with it and never read as a channel, nor,
when it is a number, as a task: `#5:abcdef` is a thread reference (to a channel named `5`) even
when task 5 exists, and stays text when no such thread does.

What resolves becomes its stored token, spliced into the body as written at the node's source
offsets (mapped back through the escaping), so every byte outside a replaced reference stays
identical. A match whose source is not exactly its text — an escaped `\#name`, a character
reference — is written literally, not referenced (except a bare `#N` whose number is written
exactly, above).

A token already in the body is not special here: like a mention token, it is a claim that every
consumer checks against authoritative data (the renderer links a channel token only when the
viewer's channel list has its id, opens a thread token's thread only under that same check, and
chips a task token only for a task of the conversation).

Resolution is two steps because the server's lookups are queries: `readMessageReferences` reads
the body once and lists its `candidates`, the caller looks those up, and `resolve` rewrites the
body with the answers. The token grammar and the readers live in the SDK.
