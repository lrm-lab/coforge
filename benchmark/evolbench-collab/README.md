# evolbench-collab evaluation utilities

The OpenViking and dedicated Memory Agent runners are retired with the product mechanism they
exercised. Dataset loading, preparation, adapters, staging, grading and historical report helpers
remain here, with their independent tests. The former `eval` command is removed; historical scores
must not be presented as results for native team memory.

Run package checks and tests with the repository's mise/Bun toolchain. Current native memory
commands and storage behaviour are covered by the [memory manual](../../apps/web/src/server/agents/manual/topics/memory.md)
and the [memory overview](../../docs/memory/team-memory.md). A new dataset/model comparison runner
is outside this change; storage integration tests do not establish answer-quality improvements.
