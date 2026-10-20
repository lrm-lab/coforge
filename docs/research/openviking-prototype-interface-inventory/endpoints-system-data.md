# Endpoint inventory: system, data, and memory (sections 6–6.3)

Part of [OpenViking prototype public-runtime interface inventory](README.md).

## 6. Endpoint inventory

Prefixes come from source `openviking/server/app.py` (`include_router`) and each router's `APIRouter(prefix=...)`. Official catalog is `docs/zh/api/01-overview.md` unless marked **source-only**.

**Disposition:** `unclassified` for every row.

### 6.1 System and health

| Method | Path | Official? | Family |
| --- | --- | --- | --- |
| GET | `/health` | yes | health |
| GET | `/ready` | yes | health |
| GET | `/api/v1/system/status` | yes | system |
| POST | `/api/v1/system/wait` | yes | system |
| POST | `/api/v1/system/consistency` | yes | system |
| POST | `/api/v1/system/backend/sync-status` | yes | system |
| POST | `/api/v1/system/backend/sync-retry` | yes | system |
| GET | `/api/v1/system/sync/{sync_path}` | yes | system |
| POST | `/api/v1/system/sync/{sync_path}/retry` | yes | system |
| GET | `/metrics` | yes | metrics |
| GET | `/` | source-only | studio redirect when bundle present |
| GET | `/studio` | source-only / ops docs | studio |
| GET | `/studio/{path}` | source-only / ops docs | studio |

### 6.2 Resources, filesystem, content, find/search

| Method | Path | Official? | Family |
| --- | --- | --- | --- |
| POST | `/api/v1/resources/temp_upload` | yes | resources |
| POST | `/api/v1/resources` | yes | resources |
| GET | `/api/v1/fs/ls` | yes | filesystem |
| GET | `/api/v1/fs/tree` | yes | filesystem |
| GET | `/api/v1/fs/stat` | yes | filesystem |
| GET | `/api/v1/fs/attrs` | yes | filesystem |
| POST | `/api/v1/fs/attrs/set_tags` | yes | filesystem |
| POST | `/api/v1/fs/mkdir` | yes | filesystem |
| DELETE | `/api/v1/fs` | yes | filesystem |
| POST | `/api/v1/fs/cp` | yes | filesystem |
| POST | `/api/v1/fs/mv` | yes | filesystem |
| GET | `/api/v1/content/read` | yes | content |
| GET | `/api/v1/content/abstract` | yes | content |
| GET | `/api/v1/content/overview` | yes | content |
| GET | `/api/v1/content/download` | yes | content |
| POST | `/api/v1/content/write` | yes | content |
| POST | `/api/v1/content/batch-write` | yes | content |
| POST | `/api/v1/content/set_tags` | yes | content |
| POST | `/api/v1/content/reindex` | yes | content |
| POST | `/api/v1/search/find` | yes | search |
| POST | `/api/v1/search/search` | yes | search |
| POST | `/api/v1/search/recall` | yes, deprecated | search |
| POST | `/api/v1/search/grep` | yes | search |
| POST | `/api/v1/search/glob` | yes | search |

### 6.3 Memory, skill, session, compile / evolution

| Method | Path | Official? | Family |
| --- | --- | --- | --- |
| GET | `/api/v1/skills` | yes | skill |
| POST | `/api/v1/skills` | yes (`resources` router) | skill |
| POST | `/api/v1/skills/find` | yes | skill |
| POST | `/api/v1/skills/validate` | yes | skill |
| GET | `/api/v1/skills/{skill_name}` | yes | skill |
| PUT | `/api/v1/skills/{skill_name}` | yes | skill |
| DELETE | `/api/v1/skills/{skill_name}` | yes | skill |
| POST | `/api/v1/sessions` | yes | session |
| GET | `/api/v1/sessions` | yes | session |
| GET | `/api/v1/sessions/{session_id}` | yes | session |
| PATCH | `/api/v1/sessions/{session_id}/config` | yes | session |
| GET | `/api/v1/sessions/{session_id}/tool-results` | yes | session |
| GET | `/api/v1/sessions/{session_id}/tool-results/{tool_result_id}` | yes | session |
| GET | `/api/v1/sessions/{session_id}/tool-results/{tool_result_id}/search` | yes | session |
| GET | `/api/v1/sessions/{session_id}/context` | yes | session |
| GET | `/api/v1/sessions/{session_id}/archives/{archive_id}` | yes | session |
| DELETE | `/api/v1/sessions/{session_id}` | yes | session |
| POST | `/api/v1/sessions/{session_id}/commit` | yes | session / memory extract |
| POST | `/api/v1/sessions/{session_id}/extract` | yes | memory extract |
| POST | `/api/v1/sessions/{session_id}/messages` | yes | session |
| POST | `/api/v1/sessions/{session_id}/messages/batch` | yes | session |
| POST | `/api/v1/sessions/{session_id}/used` | yes | session |
| GET | `/api/v1/agent-evolution/experiences/trajectories` | yes | evolution |
| GET | `/api/v1/agent-evolution/experiences/outcomes` | yes | evolution |
| POST | `/api/v1/compile` | yes | compile |
| GET | `/api/v1/compile/capabilities` | yes | compile |
| GET | `/api/v1/compile/submissions/{key}` | yes | compile |

There is no separate `/api/v1/memory/*` collection. Official `docs/zh/api/16-memory.md` treats memory as session commit/extract plus filesystem/search over `viking://~/memories`.
