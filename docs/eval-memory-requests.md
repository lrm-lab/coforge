# Memory evaluation

The former two-agent OpenViking/Memory Offer runners have been retired. Their dataset, adapter,
grader and report utilities remain under `benchmark/`; historical scores describe that former
configuration and do not measure native workspace memory.

Native memory validation currently covers persistence, local recall/recovery, workspace isolation,
current access checks, review-before-write, optimistic revisions, idempotency, atomic merge,
version restoration, permanent entry deletion and legacy Agent retirement. See the
[memory overview](memory/team-memory.md) and [Agent manual](../apps/web/src/server/agents/manual/topics/memory.md).

The PostgreSQL acceptance suite is `apps/web/test/team-memory.integration.ts`, run against an
isolated schema by the canonical Web integration runner (`TEAM_MEMORY_TEST_DATABASE_URL`). The
local proxy/CLI round trip is `packages/daemon/test/team-memory-forwarding.test.ts`. These tests
establish operational correctness; model-driven retrieval/answer-quality comparisons require a
separate controlled evaluation and are not claimed by this change.
