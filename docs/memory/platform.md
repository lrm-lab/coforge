# Personal and team memory

Platform Memory is an additive Workspace experiment, off by default. It does not replace
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

On a fresh enabled launch, the Daemon recalls memory against the queued task or initial prompt.
It selects the first nonempty task input, including recovery messages, before local memory is
prepended. It injects a directory of up to 20 search matches and up to five body previews before
task input. The complete briefing, including its directory and instructions, stays within 6,000
characters. Long bodies remain discoverable rather than being dropped: the directory names each
memory's ID, revision and scope, and reports the unloaded content per entry and in total.
`remainingMemories` counts entries whose bodies are not fully shown. The Agent can progressively
load a complete body with `coforge memory get --id <id>`, browse the full directory with
`coforge memory list --page 1 --index` and subsequent pages, or narrow its search with `--index`.
The CLI's `--index` option returns IDs, metadata and body character counts without printing the
bodies, so browsing does not fill the Agent's context with every memory. The recalled match
count describes this search response, not the total number of memories in the Workspace.
The optional recall has a three-second deadline; an outage never prevents the Agent starting.
Recalled text is untrusted reference, not an instruction overriding the person or system.

Enabled Agents are instructed to search when beginning new tasks, save verified facts or reusable
experience after meaningful work, and distinguish current evidence from historical experience.
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
- Apply the additive `20261116040000_platform_memory` migration through the ordinary deploy gate.
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

Deploy Web and a Computer/Daemon release containing the new command together, then enable
**Settings → Experiments → Memory** for a small Workspace. **Settings → Memory** manages team
memory and the viewer's own Agents' personal memory. Existing Workspace memory is not imported.

Turn the experiment off and restart the affected Agents to stop new memory instructions and
recall. An old application can run with the additive tables left in place. Keep the tables,
engine account and original local files when rolling back; do not discard newly saved memory.

## Validation

Behavioral tests cover isolation, explicit sharing, revisions, replay conflicts, verified writes,
stale index rejection, engine contracts and optional startup recall. PostgreSQL integration checks
the additive migration and real repository constraints. The PR includes the Web/CLI/Daemon checks
and build results, and states any environment limitation separately.

UI review: verify both locales, desktop and phone widths, dark/light themes, keyboard selection,
disabled/unavailable states, personal/team selection, create/search/edit/share/delete, stale edit
conflicts and a reload after switching Workspace. No UI unit tests replace this manual review.

Official engine contract: [content](https://github.com/volcengine/OpenViking/blob/e44ea6e11add1c7b3d4accdbfaf16e900a6049df/docs/zh/api/12-content.md),
[retrieval](https://github.com/volcengine/OpenViking/blob/e44ea6e11add1c7b3d4accdbfaf16e900a6049df/docs/zh/api/06-retrieval.md).
The fact/experience distinction and unified API are informed by
[Hy-Memory](https://github.com/Tencent-Hunyuan/Hy-Memory/blob/main/docs/usage.md).
