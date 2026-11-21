# Memory evaluation

Native memory validation currently covers persistence, local recall/recovery, workspace isolation,
current access checks, review-before-write, optimistic revisions, idempotency, atomic merge,
version restoration, permanent entry deletion and legacy Agent retirement. See the
[memory overview](memory/team-memory.md) and [Agent manual](../apps/web/src/server/agents/manual/topics/memory.md).

The PostgreSQL acceptance suite is `apps/web/test/team-memory.integration.ts`, run against an
isolated schema by the canonical Web integration runner (`TEAM_MEMORY_TEST_DATABASE_URL`). The
local proxy/CLI round trip is `packages/daemon/test/team-memory-forwarding.test.ts`. These tests
establish operational correctness; model-driven retrieval/answer-quality comparisons require a
separate controlled evaluation and are not claimed by this change.

## Offline hybrid retrieval

Run the experiment against a disposable local PostgreSQL database named `coforge_memory_eval`
and a local Nowledge Mem instance serving `Qwen3-Embedding-0.6B-Q4_K_M-imat` on port 14242.
The runner loads a temporary Workspace, calls the real team-memory lexical search, and limits
vector candidates using the same project and effective-version filters. Hybrid search fuses
the two rankings with equal weights and prefers keyword matches when scores tie.
Document embedding and a keyword warmup run before timing. The keyword-only arm runs first for
each question. The hybrid arm runs a fresh keyword query and query embedding in parallel.

With the local database URL exported as `TEAM_MEMORY_EVAL_DATABASE_URL`:

```bash
mise exec -- bun run --cwd packages/coforge-sdk generate
mise exec -- bun run --cwd apps/web db:generate
DATABASE_URL="$TEAM_MEMORY_EVAL_DATABASE_URL" mise exec -- bun run --cwd apps/web db:migrate:deploy
mise exec -- bun scripts/test/isolated-test-run.ts bun apps/web/scripts/eval-team-memory-retrieval.ts \
  apps/web/test/fixtures/team-memory-retrieval.json
```

The checked-in fixture is synthetic. For an observed sample, copy it outside the checkout, set
`dataset` to `observed`, and replace the documents and questions with approved Workspace examples.
Use stable evaluation labels for exact document versions, put replaced entries before their
replacements, and mark admissible answers as `relevant` and obsolete conclusions as `obsolete`.
Preserve an archived document with `status: "archived"` and its activation time with `effectiveAt`.
Queries with a project include its memories and Workspace-wide memories. Include real misses as
well as cases the current search gets right.

The output records recall at five, the share of queries with an obsolete result in the first five,
and p50/p95 latency with counts beyond the existing task recall budget. The reported rankings include
late results, so compare latency separately before making a deployment decision. Obsolete exposure measures
retrieval, not whether an Agent uses an obsolete result in an answer. Synthetic smoke results are
for wiring checks. Use an observed sample to decide whether to test deployment.
