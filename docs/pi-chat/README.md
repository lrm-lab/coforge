# AI workbench

The **AI workbench** at `/w/<workspace>/pi-chat` opens independent native Pi
conversations in the current user's cloud Computer. It supports new chats,
search, rename, deletion, stopping a turn, earlier-message paging, Markdown,
model selection, native steering/follow-up queues, thinking returned by the model,
a collapsible file sidebar with previews, downloads, uploads and chat references,
complete SDK tool arguments/results (including
structured details such as edit diffs and patches), and tool
duration. It does not reset or reuse an ordinary Agent's session.

## Conversation experience

The conversation list groups recent activity by the viewer's local calendar day
and includes search with an explicit no-results state. On phones the list and
conversation occupy the same surface, with a return-to-list action. Switching
conversations preserves unsent drafts, expanded details, loaded history and reading position while
the page stays mounted and its history remains in the Query cache.

Each turn separates the user's message and Pi's latest answer from collapsible
process details. Thinking, intermediate replies, complete tool arguments and
results remain inspectable; tool failures are indicated even while the process
is collapsed. Code fences have language labels, syntax highlighting and copy;
answers and tool results can also be copied. The highlighter loads on demand.
The composer grows with its text. Enter sends, Shift+Enter adds a newline; IME confirmation does not send. Session menus are available in both the list
and conversation header, including Stop and delete for running chats.

While Pi runs, the composer stays editable. Steer is delivered at Pi's next
assistant/tool boundary; Follow-up waits until the current work finishes. The
native pending queue is visible. Take back to edit (Alt+Up) removes still-pending
inputs and returns text to the composer; a saved copy survives lost replies and
reloads until the next accepted send. It cannot undo consumed inputs.
The selector lists models configured in that Computer's Pi installation.
Selection applies to this conversation and does not change global Pi defaults.

Replies follow the latest content while the reader is at the bottom. Scrolling
up pauses following; “Back to latest” resumes it. Loading earlier history keeps
the reading position instead of jumping to the end. Expanding process/tool details
pauses following so the revealed content stays in view.

The interaction reference is [Pi Agent Desktop](https://pi-desktop.app/),
especially its [session sidebar](https://github.com/DLYZZT/pi-desktop/blob/v0.4.1/src/renderer/components/SessionSidebar.tsx).
CoForge uses existing Untitled UI components; no upstream UI source is copied.

File browsing and transfer are described in [Working files](files.md).

## Execution and data

The Web application authenticates every Server Function and rechecks current
Workspace membership and ownership of the selected cloud Computer. Commands use
versioned CoForge RPC on that Workspace Daemon's existing outbound WSS connection.
The server checks the `pi-chat:v1` ready capability and live connection before
publishing; it never connects to the internal host's desktop HTTP origin.

The Daemon owns an independent child running the same Computer binary's internal
`__pi-chat` mode. This child uses the Pi SDK directly and opens no TCP listener or
additional cloud connection. Each User/Workspace keeps the existing worker and
working directory under the Computer state directory's `pi-chat/<workspace>/<user>`.
Inherited `COFORGE_*` capabilities are cleared before loading Pi. A SQLite
exclusive lock admits one writer per scope even after a restart; a replacement
cannot take over a live worker's sessions. Ordinary Agent sessions are separate.

Native message updates, model-provided thinking and tool execution updates are
coalesced over at most 40 ms into changed-message events. The Daemon sends them
through scoped RPC; Web rechecks the authenticated Daemon principal and current
ownership, then publishes only to the owner's existing private user channel.
The browser uses its shared Workspace realtime connection. Streaming does not
wait for a complete model answer. Active process, thinking and tool-output
sections start expanded; the viewer can collapse them and retain that choice.

Pi uses that container's existing Pi model/settings/auth configuration
(`PI_CODING_AGENT_DIR` or Pi's default). Model Factory DeepSeek needs no new
provider integration when it already works in that environment. This mode
does not inherit an individual Agent's runtime overrides or platform identity.
Model/provider names and IDs are public; keys stay in Pi's private configuration.
Coding tools act inside
the user's cloud Computer; this is not an additional filesystem sandbox.

Pi's native `.pi-sessions` JSONL files remain authoritative for model context
and transcript. The sibling `.chat-index` holds titles, status and accepted
request IDs. History reads native entries, including entries preceding a
compaction, instead of Activity summaries. The store prepares and retains one
canonical working directory for creation, lookup and deletion, so a symlinked
Computer directory still reopens its history and deletes the matching JSONL.
Data remains on the existing
Computer volume; this feature adds no PostgreSQL migration. Deleting a chat
removes its native transcript and index record; files created by its tools
remain in the working directory. Content-free accepted request IDs are retained
after deletion so delayed retries cannot recreate the chat or replay its tools.

Live content arrives as events. A ten-second active-session watchdog, subscription
recovery and detected event gaps read native history again. Worker stream IDs and
sequence cursors prevent an older read from erasing newer streamed content.
Failed history/list reads retry every three seconds, including a first load during
Computer downtime. Send mutations are never automatically retried. Closing
the page does not cancel a turn. Reopening reads the worker/native history.
Before accepting a turn, the worker saves its request ID, message and native
history boundary in a private checkpoint beside the index. After a restart,
unfinished turns automatically continue from committed native history; accepted
input missing from that history is delivered once. A committed final answer
settles without another model call. Explicit Stop is persisted before abort
and never resumes automatically. Worker shutdown preserves continuation intent.
If a tool has no committed result, or its result reports failure, recovery
keeps the turn interrupted rather than risk repeating an uncertain operation.
Queued inputs retain accepted IDs and durable intent. After a worker restart,
uncertain inputs stay visible and block automatic continuation, even after take-back.
Inspect native history before explicitly sending again. New sends preserve earlier
interrupted inputs; late native input hooks receive the same treatment. Stop cancels
pending inputs. Older interrupted chats without a checkpoint still need a new message.
Empty native sessions are saved before accepting the first request, so fixing
model credentials after a preflight failure allows the same chat to continue.

## Deployment

Deploy Web through the normal Web track, then rebuild/update the selected cloud
Computer image through its existing release track. Both Web and that Computer's
embedded Daemon need the new RPC contract. Publishing code alone does not update
running images. Replacing the Computer container also releases any legacy
host-launched worker's lock; its persistent volume and native sessions survive.
Docker needs no engine restart. Controls require `pi-chat-controls:v1`; files require `pi-chat-files:v1`;
an older Computer keeps basic chat and prompts for an update. Model switching reads the configured Pi agent directory. Keep
provider credentials on a private persistent volume, set `PI_CODING_AGENT_DIR`
to that directory, and preserve existing model defaults when adding a provider.

Web uses its existing Centrifugo API and Redis configuration. Pi Chat requires
neither `COFORGE_PI_CHAT_ORIGIN` nor the desktop origin nor a new network tunnel.
An offline Computer or one without `pi-chat:v1` is refused immediately. The
legacy signed host adapter remains available to an older Web during rollback;
the current Web never falls back to it. Roll back Web and the Computer image
together; there is no database migration or session backfill.

## Limits

- At most 20 additional inputs per admitted run, including already-consumed inputs.
- Four concurrent turns per worker; at most four workers per Workspace Daemon.
  Workers live until the Daemon stops. Shutdown closes their input, preserving
  continuation intent; a stuck worker is killed after its 30-second cleanup
  grace plus five seconds.
- Commands accept at most 100,000 message characters and 512 KB encoded input.
  Replies and event bodies have a 32 MB safety bound and cross WSS in 256 KB
  chunks, without changing the shared transport limit. Oversized reads fail
  explicitly; oversized live observations are repaired from paged history.
- Live relay buffering is volatile and bounded to 64 observations / 32 MB.
  Redis stores only content-free pending reply scopes and reply chunks for
  30 seconds, never a command mailbox or canonical transcript. Closing a browser
  does not stop Pi; reconnect reads native history rather than replaying tools.
- History loads 50 messages per page; a worker response has a 32 MB safety bound.
  Exceeding that bound is an explicit request failure, never silent truncation.
- Tool output is the complete result returned by Pi. Pi's own tool limits,
  full-output files, provider context limits and compaction still apply.
- Editing/retrying past turns, context usage controls,
  and importing an existing Agent's history remain follow-up work.

## Validation

Run the `pi-chat-*` tests under `packages/agent/test`, `packages/computer/test`
and `apps/web/test` through `mise run test:file -- <paths>`. Local fixtures verify
native tools, reload, scoped RPC, event/read ordering and deduplication, plus real
tool-boundary steering, follow-up ordering and conversation-only model persistence.

The opt-in `apps/web/test/pi-chat-daemon.integration.ts` runs with an isolated
`PI_CHAT_TEST_REDIS_URL`. It verifies live thinking/partial answers before model
completion, real file tools, request deduplication and native reload after a
worker restart. Its model and WSS adapter are controlled fixtures; Redis and Pi
are real. It writes `.amp/e2e/pi-chat-daemon.json` as repeatable evidence.

UI acceptance and the manual checklist are in [Validation](validation.md).

## Upstream contracts

Pi Chat reuses Pi SDK 1.4.0 (MIT) and Bun 1.4.4 in the existing Computer binary.
Memory and storage grow with active chats within the bounds above. Existing WSS and
Activity contracts remain; Pi Chat has its own RPC and `pi-chat:v1` / `pi-chat-controls:v1` capabilities.

- [Pi SDK 1.4.0: sessions, streaming, cancellation and Bun support](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md)
- [Pi session format](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/session-format.md)
- [Bun subprocess API](https://bun.com/docs/runtime/child-process)
- [Centrifugo Server API and private publication](https://centrifugal.dev/docs/server/server_api)
