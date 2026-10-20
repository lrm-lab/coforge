# OpenViking prototype public-runtime interface inventory

> **Context 2026-09-22:** Causal Memory is removed ([OpenViking channel memory](../../memory/openviking.md)). The pinned interface inventory and route classification below remain authoritative for the OpenViking gateway; the causal-recall analysis sections are historical.

- **Status:** Stage 1 D3 evidence. Inventory findings are not a second architecture source.
- **Classification:** every route below is **unclassified**. Later G3 work must assign `data-plane | typed-control-only | denied`. Unknown future routes stay denied.
- **Inspection date:** 2026-09-21.
- **Method:** read-only local checkout plus that checkout's official docs. No project data or code was sent to a third party. Official GitHub/docs fetch was not used in this pass.

## Sections

- [Revision, runtime, and auth (sections 1–3)](revision-runtime-auth.md): 1. exact revision and license, 2. runtime compatibility, 3. auth, account, user, and ACL.
- [Search, metadata, health, and failure (sections 4–5)](search-and-failure.md): 4. deterministic search and metadata round-trip, 5. health, deletion, and failure.
- [Endpoint inventory: system, data, and memory (sections 6–6.3)](endpoints-system-data.md): 6. endpoint inventory: 6.1 system and health, 6.2 resources and search, 6.3 memory, skill, session.
- [Endpoint inventory: tasks, administration, and other surfaces (sections 6.4–6.6)](endpoints-control-admin.md): 6.4 task, watch, pack, snapshot, observer, stats; 6.5 account, user, group, key, ACL; 6.6 assets, WebDAV, MCP, OAuth, bot, console, debug.
- [Known gaps and recommended binding (sections 7–8)](gaps-and-binding.md): 7. known gaps and architecture conflicts, 8. recommended prototype binding.
