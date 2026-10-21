# AI workbench

The **AI workbench** at `/w/<workspace>/pi-chat` opens independent native Pi
conversations in the current user's cloud Computer. It supports new chats,
search, rename, deletion, stopping a turn, earlier-message paging, Markdown,
thinking returned by the model, complete SDK tool arguments/results (including
structured details such as edit diffs and patches), and tool
duration. It does not reset or reuse an ordinary Agent's session.

## Execution and data

The Web application authenticates each Server Function, verifies current
Workspace membership and ownership of the selected cloud Computer, and signs
the command and scope with the deployment's cloud-cluster secret. The host
checks the signature and a 30-second timestamp window before executing it.
Credentials and host addresses are never returned to the browser.

The existing host HTTP listener forwards chat commands over `docker exec` stdio
to the Computer binary's internal `__pi-chat` mode in the user's container.
This mode uses the Pi SDK directly and opens neither a Daemon connection nor
another TCP listener. Each User/Workspace has its own worker and working
directory under the Computer state directory's `pi-chat/<workspace>/<user>`.
The worker removes inherited `COFORGE_*` capabilities before loading Pi. A
local SQLite exclusive lock admits one writer per scope even after a host
restart; replacement workers cannot touch a previous worker's sessions.

Pi uses that container's existing Pi model/settings/auth configuration
(`PI_CODING_AGENT_DIR` or Pi's default). Model Factory DeepSeek needs no new
provider integration when it already works in that environment. This mode
does not inherit an individual Agent's runtime overrides or platform identity.
The chosen model is displayed in the conversation. Coding tools act inside
the user's cloud Computer; this is not an additional filesystem sandbox.

Pi's native `.pi-sessions` JSONL files remain authoritative for model context
and transcript. The sibling `.chat-index` holds titles, status and accepted
request IDs. History reads native entries, including entries preceding a
compaction, instead of Activity summaries. Data remains on the existing
Computer volume; this feature adds no PostgreSQL migration. Deleting a chat
removes its native transcript and index record; files created by its tools
remain in the working directory. Content-free accepted request IDs are retained
after deletion so delayed retries cannot recreate the chat or replay its tools.

The page reads updates every 700 ms while its selected session runs. Closing
the page does not cancel a turn. Reopening reads the worker/native history.
An accepted request ID is persisted before execution; retries reuse it and
never automatically replay tools. A worker restart marks unfinished runs
interrupted. Users explicitly send a new message to continue.
Empty native sessions are saved before accepting the first request, so fixing
model credentials after a preflight failure allows the same chat to continue.

## Deployment

Deploy the Web change through the normal Web track. Update the host Computer
binary and rebuild/update cloud Computer images through their existing release
tracks so both sides provide `__pi-chat`. Publishing this code alone does not
update running images. Existing Agents and their sessions are unaffected.

The Web backend uses `COFORGE_PI_CHAT_ORIGIN` when configured, otherwise the
existing `COFORGE_CLOUD_DESKTOP_ORIGIN`. For the checked-in staging topology the
latter points to the existing host at `10.110.158.143:6090`. Web and host use
the same existing cluster secret (`COFORGE_CLOUD_CLUSTER_TOKEN` on Web,
`COFORGE_CLUSTER_TOKEN` on the host). Keep the host origin on the private
network or use HTTPS. Never put the secret in a URL or browser environment.

With no origin/cluster secret the page shows an unavailable state. With an old
host/image it shows a connection error and a retry action. Roll back by
reverting the Web/Computer versions; the additive session files can remain on
the volume. No Agent session or database backfill is needed.

## Limits

- Four concurrent turns per worker; 64 workers per host.
- Workers expire after 30 minutes without a request; active work is stopped
  during worker cleanup. Host shutdown also closes its workers' input streams.
  Cleanup gets 30 seconds before worker exit; unfinished sessions recover as
  interrupted. A stuck docker-exec client is terminated after another 5 seconds.
- One request accepts at most 100,000 message characters and a 512 KB HTTP body.
- History loads 50 messages per page; a worker response has a 32 MB safety bound.
  Exceeding that bound is an explicit request failure, never silent truncation.
- Tool output is the complete result returned by Pi. Pi's own tool limits,
  full-output files, provider context limits and compaction still apply.
- Attachments, editing/retrying past turns, model switching, and importing an
  existing Agent's history are not part of this version.

## Validation

Run the `pi-chat-*` tests under `packages/agent/test`, `packages/computer/test`
and `apps/web/test` through `mise run test:file -- <paths>`. They exercise
native SDK tool execution and reload, worker stdio lifecycle, signature
validation, scope authorization, session separation and accepted-send
deduplication. They use local model fixtures, not a paid provider or a live
user's cloud Computer.

UI acceptance follows [the repository policy](agents/testing.md); no UI unit
tests are added. Before deployment acceptance:

- [ ] Verify the navigation and list/detail flow at desktop and mobile sizes,
  in both themes, including direct links and returning to the list.
- [ ] Start two chats; verify independent context, actual model display,
  Markdown/code rendering, and drafts retained when switching conversations.
- [ ] Expand long thinking/tool arguments/results and verify complete content,
  duration, scroll behavior, and earlier-message loading.
- [ ] Run an edit and expand its result; verify both the diff and patch remain
  visible after switching chats and reloading the page.
- [ ] Fail the first send with missing model credentials, repair the credentials,
  and verify a new message continues the same chat without replaying the failure.
- [ ] Stop, rename, cancel deletion, confirm deletion, and reload the page.
- [ ] Disconnect/reconnect while sending; retry the same message without
  duplicate tool execution. Switch Users/Workspaces and verify isolation.
- [ ] Check unavailable configuration, an old host/image, offline Computer,
  model authentication failure, worker restart and keyboard/IME behavior.

## Upstream contracts

CoForge already pins Pi SDK 1.3.0 (MIT) and Bun 1.4.3. This feature reuses both.
The existing Computer binary carries the worker; it adds no installed product.
Host process/memory use and native-session storage grow with active chats;
the bounds above limit worker/turn concurrency. Existing transport and
Activity remain unchanged.

- [Pi SDK 1.3.0: sessions, streaming, cancellation and Bun support](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/sdk.md)
- [Pi session format](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/session-format.md)
- [Bun subprocess API](https://bun.com/docs/runtime/child-process)
