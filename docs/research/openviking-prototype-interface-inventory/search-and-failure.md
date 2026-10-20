# Search, metadata, health, and failure (sections 4–5)

Part of [OpenViking prototype public-runtime interface inventory](README.md).

## 4. Deterministic search and metadata round-trip

### 4.1 Can causal retrieval be deterministic without modifying OpenViking?

**Yes, for deterministic candidate retrieval, using public APIs only.**

Official `docs/zh/api/06-retrieval.md` and `docs/zh/concepts/07-retrieval.md`:

| API | Intent analysis | Session context | Query expansion | Default limit |
| --- | --- | --- | --- | --- |
| `POST /api/v1/search/find` | no | no | no | 10 |
| `POST /api/v1/search/search` | yes | yes when `session_id` set | default `query_expansion="auto"` | 10 |

Source `openviking/server/routers/search.py`:

- `FindRequest` has no `session_id` or `query_expansion`.
- `SearchRequest.query_expansion` is `Literal["off", "auto"]` with default `"auto"`.
- `mode="list"` rejects context-only fields including `query_expansion`.
- `find()` docstring: "Semantic search without session context."

Therefore the causal Fact Index adapter should call `POST /api/v1/search/find` with:

- `target_uri` locked to the Managed Causal Projection subtree
- `limit` ≤ 10
- no `session_id`
- optional `level` / `tags` / `filter`
- no `image_url` unless later explicitly approved

Do **not** use `POST /api/v1/search/search` or deprecated `POST /api/v1/search/recall` for managed causal candidate recall: those faces default to expansion and session context.

**Not claimed:** bit-identical ranking across embedding-model or index rebuilds. Official ranking is vector similarity plus hierarchical directory walk. Determinism here means "no LLM rewrite, no session memory, fixed target, bounded limit."

OpenViking long-term memory extraction is a session `commit` / `extract` Phase 2 behavior (`docs/zh/api/05-sessions.md`, source `openviking/session/session.py`). The Fact Index adapter must not invoke those endpoints for managed facts.

### 4.2 Stable metadata without modifying OpenViking?

**Partially yes. Use explicit `k=v` tags and the documented `filter`/`tags` search fields. Do not depend on arbitrary extra metadata keys.**

Official write/tag path (`docs/zh/api/12-content.md`):

- `POST /api/v1/content/write` accepts `tags: string[]` in strict `k=v` form and `tag_mode: replace | append`.
- Tags are written on the file's first vector upsert.
- `POST /api/v1/content/set_tags` and `POST /api/v1/fs/attrs/set_tags` are the dedicated tag APIs.
- `find()` / `search()` accept `tags` (AND) and `filter` (metadata filter).

Official sidecar metadata (`docs/zh/concepts/03-context-layers.md`):

- Unknown top-level or nested metadata fields are **silently dropped**.
- Protected OKF metadata on `.abstract.md` / `.overview.md` cannot be changed through the public write API.
- Public API cannot create new L0/L1 sidecars; OpenViking generates them asynchronously.

**Prototype implication:** store canonical fact id / version as explicit tags such as `cm_fact=<id>` and `cm_ver=<n>` (final key names belong to C3). Do not put those identifiers only in YAML frontmatter extras. L0/L1 summaries are retrieval aids and are eventually consistent; watermark-plus-local-delta remains a Causal Memory responsibility, not an OpenViking field.

OpenViking has no documented index watermark. The Fact Index watermark is owned by Causal Memory after an adapter search.

## 5. Health, deletion, and failure

| Operation | Official route | Notes |
| --- | --- | --- |
| Process liveness | `GET /health` | unauthenticated; may echo identity if credentials present |
| Readiness | `GET /ready` | unauthenticated; AGFS + VectorDB + API key manager |
| System status | `GET /api/v1/system/status` | authenticated |
| Delete account | `DELETE /api/v1/admin/accounts/{account_id}` | official admin; HTTP 202 in source |
| Delete user | `DELETE /api/v1/admin/accounts/{account_id}/users/{user_id}` | official admin; HTTP 202 in source |
| Delete file/dir | `DELETE /api/v1/fs` | data-plane destructive |
| Delete session | `DELETE /api/v1/sessions/{session_id}` | user-scoped |
| Delete skill | `DELETE /api/v1/skills/{skill_name}` | user-scoped |

Account deletion is the typed cleanup primitive CoForge should use for Workspace deletion, not a generic data-plane proxy. Classification remains **unclassified** until G3.
