# Agent and workspace memory

Agents keep their own memory in Markdown files and selectively publish verified knowledge to
workspace team memory. Both are available through `coforge memory`; detailed commands and conflict
handling are in the [Agent manual](../../apps/web/src/server/agents/manual/topics/memory.md).

## Local memory

Local files remain authoritative and portable with the Agent workspace. `MEMORY.md` is the short
core index; `notes/active-context.md` holds current work; `notes/knowledge/` stores sourced facts,
decisions, preferences and reusable experiences with revision history. Keyword search handles
English terms and Chinese character pairs. A bounded summary accompanies fresh sessions; providers
that report compaction receive a smaller recovery block with the next real input. No extra model
turn starts solely to maintain memory.

When the existing System Cleaner is configured and enabled, successful local writes request a
size check at the next idle boundary. Large active knowledge collections receive a bounded-review
hint alongside the existing startup-file hints; archived knowledge and history stay retained.
The [manual](../../apps/web/src/server/agents/manual/topics/memory.md) defines the limits, cooldown
and five-entry maintenance batches. Startup excerpts link to paginated local listings and search;
full evidence remains available by key.

## Workspace memory

`coforge memory <operation> --scope team` uses the current Agent's authenticated workspace.
Reads are optional. An Agent chooses whether to share useful verified knowledge and decides how
to reconcile related entries before a write. Nothing automatically uploads local notes, private
messages, environment variables or conversation transcripts.

Team memory defaults to on. A Workspace owner or admin can enable or disable it in Settings →
Experiments. The backend checks the switch on every operation; disabling it blocks team reads and
writes while keeping existing entries and history. Local memory is independent of this switch.

The Web/backend stores entries, versions, workspace revisions and idempotency receipts in the
existing PostgreSQL database. A trigram index and lexical ranking provide bounded search. There is
no separate vector service, OpenViking engine or dedicated Memory Agent. Ordinary work continues
when team memory is unavailable. Team memory is reference data, never authority or instructions.

Mutations require an opaque server-issued review token bound to the Agent, exact command, requestId and workspace revision, expiring after ten minutes; changes additionally carry an entry revision.
A stale writer rereads before retrying. Merge updates its destination and archives sources in one
transaction, and only combines entries with the same applicability. History records source,
writer, reason and merged references. Only the original author or an Agent with admin authority
can permanently clear an entry and its versions. Workspace deletion cascades all native memory.

History pages contain previews within a 12,000-byte response budget. Full historical evidence is
available one version at a time through `get --revision`, without loading every version into context.
Entries can cite structured Workspace-readable tasks, messages and artifacts. Exact version
relationships record replacement or disagreement. Search omits a replaced version while its
replacement is active and effective. Historical reads still work, with current evidence access.
In the Web team-memory detail and version pages, the decision relationships view shows nearby
versions, replacements, conflicts and readable evidence. Select a node to highlight its links
and open the exact recorded memory revision or its evidence.

When Web enables `COFORGE_TEAM_MEMORY_RECALL=true`, an Agent opening, viewing or claiming a single task
can receive up to five current memory excerpts from the task's Project and the Workspace.
The task request keeps working when recall fails or exceeds its 400 ms budget.

Set `COFORGE_TEAM_MEMORY_REVIEW=true` on Web to enable the review queue. A public task
marked done records one draft for that exact Task revision. Workspace members can also submit new
memories and corrections from the editor. In the review queue, open readable evidence and the
cited memory revision, compare a correction with its proposed text, and publish, edit, set aside
for verification, or dismiss a suggestion. Reopening a Task or withdrawing its shareable evidence
invalidates its draft. A reviewed write and its decision commit together.

The daily sweep handles one project or the unscoped Workspace entries per batch. Each batch
examines up to 64 non-fixed entries and records up to five new suggestions for duplicates or
unavailable evidence. The review page can start a batch manually. Logs record the scan ID,
inspected and suggested counts, and failures. Each committed approval records one acceptance
with the originating scan ID, so operations can count accepted suggestions per batch.

## Upgrade and retained data

Staging Web enables both task recall and memory review. Its container health check requires both
environment flags to be `true` and the Web readiness endpoint to respond.

Stop existing dedicated Memory Agent processes, then deploy Web/backend migrations before updating Computers. Migrations archive registered legacy
Memory Agents, revoke their API keys and leave their channel memberships; ordinary Agents and
historical messages remain. Reserved protocol fields are never reused, and a new Computer rejects
a legacy dedicated-memory launch rather than silently granting ordinary tools.

Historical OpenViking tables and migrations remain to preserve retained records and foreign keys;
there is no active route, model extraction, lifecycle sweep or automatic conversion into native
team memory. External prototype data is not imported or deleted by this change. Operators who
previously ran a prototype retire its external service under their existing data-retention policy.
