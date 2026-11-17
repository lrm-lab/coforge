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

## Workspace memory

`coforge memory <operation> --scope team` uses the current Agent's authenticated workspace.
Reads are optional. An Agent chooses whether to share useful verified knowledge and decides how
to reconcile related entries before a write. Nothing automatically uploads local notes, private
messages, environment variables or conversation transcripts.

Team memory defaults to off. A Workspace owner or admin can enable or disable it in Settings →
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

## Upgrade and retained data

Stop existing dedicated Memory Agent processes, then deploy Web/backend migrations before updating Computers. Migrations archive registered legacy
Memory Agents, revoke their API keys and leave their channel memberships; ordinary Agents and
historical messages remain. Reserved protocol fields are never reused, and a new Computer rejects
a legacy dedicated-memory launch rather than silently granting ordinary tools.

Historical OpenViking tables and migrations remain to preserve retained records and foreign keys;
there is no active route, model extraction, lifecycle sweep or automatic conversion into native
team memory. External prototype data is not imported or deleted by this change. Operators who
previously ran a prototype retire its external service under their existing data-retention policy.
