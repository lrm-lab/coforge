# Automatic team maintenance

A successful Agent write may return one compact size hint when this Project has at least 64
unprotected active entries or 128 KiB of observed active content. Inspection reads at most 65
entries through an index, never the whole library; a partial measurement is labelled. Protected
(`pinned`) entries, archives and history are excluded. Hints are limited to one per Workspace
per 24 hours and go only to that writer, without startup prompt injection or another Agent.

Finish the person's task first. Run `coforge memory maintenance --scope team` to start the batch.
It returns at most five previews and a two-minute `maintenanceToken`; rereading the batch never
renews its deadline or allowance. Read the complete sources with `get` before proposing changes.
Keep explicit long-term memories, decisions, uncertainty and different applicability intact.

Every automatic `update`, `merge` or `archive` must carry `--maintenanceToken <token>` and the
normal reviewed operation's `--reviewToken <token>`. The server permits at most five changed
entries, counting merge sources, and rejects expired budgets, another Agent, a different Project,
protected entries, creation, restoration and permanent deletion. Replayed writes consume no extra
allowance. Preserve sources and versions; archive only verified duplicates or obsolete facts.
Stop for new work or when either bound is reached. A partial cleanup is acceptable.

This is a bounded instruction to the acting Agent, not a deterministic semantic merger. The server
cannot establish that a fact is obsolete; the Agent must inspect evidence. A disabled Workspace
blocks batch reads and writes too. Older Computers keep ordinary memory access but receive no
maintenance hints until upgraded. Size alone is never grounds to discard important knowledge.
