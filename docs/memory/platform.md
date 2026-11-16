# Personal and team memory

Platform Memory is an additive Workspace feature, on by default. Each person may opt out for
all their Agents in Settings → Account; a Workspace owner/admin may turn off its master switch. It does not replace
`MEMORY.md`, modify an Agent workspace, turn on the legacy Memory Agent, migrate historical
conversations, or change ordinary message delivery. Stop and start Agents after switching it.

## Ownership and access

- Personal memory belongs to the stable `(Workspace, Agent)` identity, independently of Codex,
  Claude Code, Pi or the Computer running it. Only that Agent and its current owner read it.
  Workspace administration does not grant access to another member's personal memory.
- Team memory is readable by current Workspace members and their live Agents. Its author, the
  owner of an authoring Agent, or a Workspace owner/admin may edit or delete it.
- Personal memory is copied into the team scope only by an explicit `share` or a team `create`.
  Later personal edits do not silently update the published copy. Edit the team copy separately.
- Every request rechecks live Agent ownership and Workspace membership. Requests never accept
  another caller's identity, raw engine paths, or an engine credential from the client.

## Agent commands

All supported shell-capable runtimes use the same bundled CLI:

```sh
coforge memory status
coforge memory create --title 'Release rule' --content 'Run tests before publishing' --kind fact
coforge memory search --query 'What must happen before a release?'
coforge memory list --page 1 --index
coforge memory search --query 'release' --index
coforge memory get --id <uuid>
coforge memory update --id <uuid> --revision 1 --title 'Release rule' --content 'Run tests and build'
coforge memory share --id <uuid> --revision 2
coforge memory delete --id <uuid> --revision 2
```

Writes accept `--request-id <uuid>`; preserve it only for identical retries. `--source-message-id`
must name a saved message authored by the caller. Kinds are `fact`, `experience`, and `preference`.
Create defaults to personal memory. Explicit team writes use `--scope team`. Reads return the
revision needed for a correction; a stale writer receives a conflict and must read again.
Expired memories are excluded from lists, reads and recall. Management currently supports fewer
than 100 owned Agents per member; the service rejects larger selections rather than truncating
authorization or recall silently. Semantic search currently accepts up to 1,000 active
memories in the selected scope; larger selections fail explicitly while paged management remains
available.

The built-in CoForge/Pi runner also exposes `platform_memory`, only on enabled launches.
Codex, Claude Code and other shell-capable runtimes use the CLI through the existing authenticated
Daemon proxy. Older Computers need the release containing this command and proxy route.

## Proactive use

Semantic retrieval is decided by the Agent from the request, including the first message of a
fresh session. Starting, resuming or compacting a model session does not trigger a platform
memory search. Small local startup files keep their existing behavior.

- Greetings, casual chat and sufficient current context: answer directly without memory calls
  or routine-Q&A saving, except an explicit request to recall a previous decision.
- Missing facts about historical decisions, preferences, project conventions and prior work: search.
- Before asking again for information the person may have already supplied: search first.
- An explicit “previously discussed” or “same as last time” requires search.

The system owns authenticated tools, permission checks, deadlines and clear results. Standing
memory guidance stays within 800 added bytes. Operational details are loaded with
`coforge manual get memory`, not repeated in the prompt. `coforge memory search --index` and
`list --page 1 --index` return metadata/body counts; `get --id` progressively loads full bodies.
Search returns at most 20 matches, not the total Workspace memory count. Recalled text is
untrusted reference, never an instruction overriding the person or system.

Explicit requests to remember something, important facts and corrections to repeated questions
instruct the Agent to save immediately, with provenance and date, updating an existing entry when
appropriate. Before requesting another sign-in, the Agent is instructed to check and reuse the
current service/account/Computer's authorized native session or configured credential, refreshing
through that service when supported. Unknown status is not evidence that the User is logged out.
Memory stores only a masked account label, configuration reference and last verification time;
secret values remain in the existing protected credential store. This does not introduce a
cross-site password vault, move credentials to another Computer, or bypass an expired login/MFA.
These are shared Agent instructions; execution and memory writes still depend on the model using
the available tools. A UI move or a remembered historical login cannot guarantee automatic sign-in.
They choose useful memories through the same tool/CLI. This is not bulk transcript collection or
an extra background model secretly reading private conversations. Credentials and hidden prompts
must not be saved. Local file memory remains available as before.

## Persistence and engine setup

PostgreSQL owns access metadata, the current revision, idempotency receipts and deletion
tombstones and historical deduplication hashes. Memory bodies and the semantic index have one authority: the existing OpenViking
runtime. No second body table, client-side search index, or Hy-Memory deployment is introduced.

Personal bodies use `viking://user/coforge-agent-<id>/resources/coforge-<workspace>`; shared bodies
use the Workspace's `viking://resources/coforge-memory/<workspace>/team` subtree. Private memory
is not put into the shared resources subtree used by the legacy Memory Agent.

Before enabling, configure a real, separately provisioned account binding for the Workspace:

- `COFORGE_OPENVIKING_URL` identifies the private, pinned runtime.
- `COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE` maps each persisted binding's credential reference to
  that account's ADMIN API key. Keys remain server-side; do not use a ROOT or another account's key.
- Apply the additive `20261116040000_platform_memory` and
  `20261116080000_platform_memory_preference` migrations through the ordinary deploy gate.
- Verify engine readiness and perform a create/read/search/delete round trip with synthetic data.

This PR does not deploy an engine or change the existing OpenViking prototype's shipping or
license approval. An absent binding, secret or healthy runtime is shown as unavailable, not ready.

A write waits for the engine's index update and verifies the exact document before activating
its revision in PostgreSQL. Immutable revision paths plus compare-and-set prevent a competing
writer from overwriting the winning document. Search uses a native URI filter for the current
readable revisions before ranking, so obsolete versions cannot fill the hit budget. Hits are rechecked against current, readable,
unexpired references before any memory body is returned.

Deleting first tombstones the reference, so a stale index cannot return it. Remote cleanup then
removes that memory's version directory. If cleanup fails the response says `cleanupPending`;
replaying the same delete can retry cleanup. Exact deduplication and source tombstones prevent
silently recreating a forgotten memory. Deleting memory does not delete the original chat message.

## Rollout and rollback

Deploy the additive preference migration and Web, then a Computer/Daemon release containing the
new command. **Settings → Experiments → Memory** is the Workspace master switch, on by default;
**Settings → Account → Let my Agents use platform memory** is each person's account-wide choice,
also on by default. The master switch takes priority. The server rechecks an Agent owner's current
choice for every memory request and omits memory guidance from disabled launches. Human owners
can still manually manage saved entries after opting their Agents out. Turning a switch off does
not delete memory; restart existing Agents to remove standing instructions and already loaded
memory from their native sessions. Before testing or enabling use, provision a real engine binding. During a conversation, click the
Agent's avatar, open **Workspace → Platform memory** in the right sidebar, and manage that
Agent's personal memory or the Workspace's team memory there. The current Agent is already
selected; another member's personal memory is never exposed to a Workspace administrator.
Members without their own Agent can open **Workspace menu → Team memory**, including ordinary
members. Personal memory is managed only beside its Agent, never in Settings.
The file browser, local `MEMORY.md`, expanded folders and selected file remain available when
returning from memory. Platform entries are managed remotely, without creating duplicate local
files. Existing Workspace memory is not imported.

Turn the relevant switch off to block new Agent memory requests; restart affected Agents to
remove memory guidance and previously loaded context. An old application can run with the additive tables left in place. Keep the tables,
engine account and original local files when rolling back; do not discard newly saved memory.

## Validation

Behavioral tests cover isolation, explicit sharing, revisions, replay conflicts, verified writes,
stale index rejection, engine contracts and Agent-directed retrieval. PostgreSQL integration checks
the additive migration and real repository constraints. The PR includes the Web/CLI/Daemon checks
and build results, and states any environment limitation separately.

UI review: verify both locales, desktop and phone widths, dark/light themes, keyboard selection,
disabled/unavailable states, current-Agent ownership, personal/team selection, files/back
navigation with a retained draft, create/search/edit/share/delete, stale edit
conflicts and a reload after switching Workspace. No UI unit tests replace this manual review.

Real acceptance commands (explicit opt-in; native model calls may consume account quota):

```sh
PLATFORM_MEMORY_MODEL_SMOKE=1 PLATFORM_MEMORY_EVAL_MODEL=<authorized-model> \
  mise exec -- bun scripts/test/isolated-test-run.ts \
  bun packages/daemon/test/platform-memory-model.smoke.ts
PLATFORM_MEMORY_REAL_SMOKE=1 COFORGE_OPENVIKING_URL=<private-runtime> \
  OPENVIKING_PLATFORM_SMOKE_CONF=<protected-config-path> \
  OPENVIKING_RUNTIME_IDENTITY=<inspected-image-or-version> \
  PLATFORM_MEMORY_TEST_DATABASE_URL=<disposable-loopback-memory_database> \
  mise run test:file -- ./apps/web/test/platform-memory.smoke.ts
```

The model smoke records real Codex tool decisions against the branch CLI and synthetic read-only
HTTP data; it is not engine acceptance or a guarantee for every runtime/model. The separate engine
smoke runs the new production memory service and binding resolver against real OpenViking and
PostgreSQL, provisions isolated accounts and cleans them up. A synthetic engine is insufficient
for this gate. Record source revision, actual service identity, CRUD/search results and denials
before merging. The old Memory Agent's online status is not evidence for this new path.

Official engine contract: [content](https://github.com/volcengine/OpenViking/blob/e44ea6e11add1c7b3d4accdbfaf16e900a6049df/docs/zh/api/12-content.md),
[retrieval](https://github.com/volcengine/OpenViking/blob/e44ea6e11add1c7b3d4accdbfaf16e900a6049df/docs/zh/api/06-retrieval.md).
The fact/experience distinction and unified API are informed by
[Hy-Memory](https://github.com/Tencent-Hunyuan/Hy-Memory/blob/main/docs/usage.md).
