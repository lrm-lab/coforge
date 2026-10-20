# Endpoint inventory: tasks, administration, and other surfaces (sections 6.4–6.6)

Part of [OpenViking prototype public-runtime interface inventory](README.md).

### 6.4 Task, watch, pack, snapshot, observer, stats

| Method | Path | Official? | Family |
| --- | --- | --- | --- |
| GET | `/api/v1/tasks` | yes | task |
| GET | `/api/v1/tasks/{task_id}` | yes | task |
| POST | `/api/v1/tasks/{task_id}/cancel` | yes | task |
| GET | `/api/v1/watches` | yes | watch |
| GET | `/api/v1/watches/{task_id}` | yes | watch |
| PATCH | `/api/v1/watches` | yes | watch |
| PATCH | `/api/v1/watches/{task_id}` | yes | watch |
| DELETE | `/api/v1/watches` | yes | watch |
| DELETE | `/api/v1/watches/{task_id}` | yes | watch |
| POST | `/api/v1/watches/trigger` | yes | watch |
| POST | `/api/v1/watches/{task_id}/trigger` | yes | watch |
| POST | `/api/v1/snapshot/commit` | yes | snapshot |
| GET | `/api/v1/snapshot/log` | yes | snapshot |
| POST | `/api/v1/snapshot/restore` | yes | snapshot |
| GET | `/api/v1/snapshot/show` | yes | snapshot |
| GET | `/api/v1/snapshot/diff` | yes | snapshot |
| GET | `/api/v1/snapshot/ignore` | yes | snapshot |
| PUT | `/api/v1/snapshot/ignore` | yes | snapshot |
| DELETE | `/api/v1/snapshot/ignore` | yes | snapshot |
| POST | `/api/v1/pack/export` | yes | pack |
| POST | `/api/v1/pack/import` | yes | pack |
| POST | `/api/v1/pack/backup` | yes | pack |
| POST | `/api/v1/pack/restore` | yes | pack |
| GET | `/api/v1/observer/queue` | yes | observer |
| GET | `/api/v1/observer/vikingdb` | yes | observer |
| GET | `/api/v1/observer/models` | yes | observer |
| GET | `/api/v1/observer/lock` | yes | observer |
| GET | `/api/v1/observer/retrieval` | yes | observer |
| GET | `/api/v1/observer/filesystem` | yes | observer |
| GET | `/api/v1/observer/system` | yes | observer |
| GET | `/api/v1/stats/memories` | **source-only** | stats |
| GET | `/api/v1/stats/sessions/{session_id}` | **source-only** | stats |

### 6.5 Account, user, group, key, ACL, administration

| Method | Path | Official? | Family |
| --- | --- | --- | --- |
| GET | `/api/v1/acl` | yes | acl |
| PUT | `/api/v1/acl` | yes | acl |
| DELETE | `/api/v1/acl` | yes | acl |
| POST | `/api/v1/acl/grant` | yes | acl |
| POST | `/api/v1/acl/revoke` | yes | acl |
| GET | `/api/v1/admin/configuration` | yes | admin |
| PATCH | `/api/v1/admin/configuration` | yes | admin |
| GET | `/api/v1/admin/accounts/{account_id}/configuration` | yes | admin |
| PATCH | `/api/v1/admin/accounts/{account_id}/configuration` | yes | admin |
| GET | `/api/v1/admin/agent-evolution` | yes, deprecated | admin |
| PUT | `/api/v1/admin/agent-evolution` | yes, deprecated | admin |
| GET | `/api/v1/admin/accounts/{account_id}/settings` | yes, deprecated | admin |
| PATCH | `/api/v1/admin/accounts/{account_id}/settings` | yes, deprecated | admin |
| GET | `/api/v1/admin/accounts/{account_id}/memory-templates` | yes | admin |
| GET | `/api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}` | yes | admin |
| PUT | `/api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}` | yes | admin |
| DELETE | `/api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}` | yes | admin |
| POST | `/api/v1/admin/accounts` | yes | admin / account |
| GET | `/api/v1/admin/accounts` | yes | admin / account |
| POST | `/api/v1/admin/migrate` | yes | admin |
| DELETE | `/api/v1/admin/accounts/{account_id}` | yes | admin / destructive |
| POST | `/api/v1/admin/accounts/{account_id}/users` | yes | admin / user |
| GET | `/api/v1/admin/accounts/{account_id}/users` | yes | admin / user |
| GET | `/api/v1/admin/accounts/{account_id}/users/{user_id}/settings` | yes | admin / user |
| PATCH | `/api/v1/admin/accounts/{account_id}/users/{user_id}/settings` | yes | admin / user |
| DELETE | `/api/v1/admin/accounts/{account_id}/users/{user_id}` | yes | admin / user |
| PUT | `/api/v1/admin/accounts/{account_id}/users/{user_id}/role` | yes | admin / user |
| POST | `/api/v1/admin/accounts/{account_id}/users/{user_id}/key` | yes | admin / key |
| POST | `/api/v1/admin/accounts/{account_id}/groups` | yes | admin / group |
| GET | `/api/v1/admin/accounts/{account_id}/groups` | yes | admin / group |
| DELETE | `/api/v1/admin/accounts/{account_id}/groups/{group_id}` | yes | admin / group |
| GET | `/api/v1/admin/accounts/{account_id}/groups/{group_id}/members` | yes | admin / group |
| PUT | `/api/v1/admin/accounts/{account_id}/groups/{group_id}/members/{user_id}` | yes | admin / group |
| DELETE | `/api/v1/admin/accounts/{account_id}/groups/{group_id}/members/{user_id}` | yes | admin / group |
| GET | `/api/v1/privacy-configs` | yes | privacy |
| GET | `/api/v1/privacy-configs/{category}` | yes | privacy |
| GET | `/api/v1/privacy-configs/{category}/{target_key}` | yes | privacy |
| GET | `/api/v1/privacy-configs/{category}/{target_key}/versions` | yes | privacy |
| GET | `/api/v1/privacy-configs/{category}/{target_key}/versions/{version}` | yes | privacy |
| POST | `/api/v1/privacy-configs/{category}/{target_key}` | yes | privacy |
| POST | `/api/v1/privacy-configs/{category}/{target_key}/activate` | yes | privacy |

### 6.6 Assets, WebDAV, MCP, OAuth, bot, console, debug, user-settings

| Method | Path | Official? | Family |
| --- | --- | --- | --- |
| POST | `/api/v1/openviking-assets/resolve` | yes | assets |
| POST | `/api/v1/openviking-assets/preflight` | yes | assets |
| OPTIONS/PROPFIND/GET/HEAD/PUT/DELETE/MKCOL/MOVE | `/webdav/resources` and `/webdav/resources/{resource_path}` | yes | webdav |
| GET/POST/DELETE | `/mcp` | **source-only** (`mcp_endpoint.py`); OAuth guide mentions it | mcp |
| GET | `/.well-known/oauth-protected-resource` | official OAuth guide | oauth |
| GET | `/oauth/authorize/page` | official OAuth guide | oauth |
| GET | `/oauth/authorize/page/status` | official OAuth guide | oauth |
| GET | `/api/v1/auth/oauth/pending/{pending_id}` | **source-only** | oauth |
| POST | `/api/v1/auth/oauth-verify` | **source-only** | oauth |
| GET | `/bot/v1/health` | yes | vikingbot |
| POST | `/bot/v1/chat` | yes | vikingbot |
| POST | `/bot/v1/chat/stream` | yes | vikingbot |
| POST | `/bot/v1/feedback` | yes | vikingbot |
| POST | `/bot/v1/compile` | yes, retired | vikingbot |
| GET | `/bot/v1/compile/{task_id}` | yes, retired | vikingbot |
| POST | `/bot/v1/compile/{task_id}/cancel` | yes, retired | vikingbot |
| GET | `/api/v1/admin/bot/capabilities` | **source-only** (`bot_studio.py`, `include_in_schema=False`) | vikingbot admin |
| GET/POST/PATCH/DELETE | `/api/v1/admin/accounts/{account_id}/bot/connections[/{connection_id}]` | **source-only** | vikingbot admin |
| POST | `/api/v1/admin/accounts/{account_id}/bot/connections/{connection_id}/credentials` | **source-only** | vikingbot admin |
| POST | `/api/v1/admin/accounts/{account_id}/bot/connections/{connection_id}/verifications` | **source-only** | vikingbot admin |
| GET | `/api/v1/admin/accounts/{account_id}/bot/connections/{connection_id}/conversations` | **source-only** | vikingbot admin |
| GET | `/api/v1/admin/accounts/{account_id}/bot/connections/{connection_id}/messages` | **source-only** | vikingbot admin |
| POST/GET | `/api/v1/admin/accounts/{account_id}/bot/onboarding-runs...` | **source-only** | vikingbot admin |
| GET | `/api/v1/console/dashboard/summary` | **source-only** | console |
| GET | `/api/v1/console/tokens` | **source-only** | console |
| GET | `/api/v1/console/context-commits` | **source-only** | console |
| GET | `/api/v1/console/audit` | **source-only** | console |
| GET | `/api/v1/debug/health` | **source-only** | debug |
| GET | `/api/v1/debug/vector/scroll` | **source-only** | debug |
| GET | `/api/v1/debug/vector/count` | **source-only** | debug |
| GET | `/api/v1/user-settings/add-locations` | **source-only** | user-settings |
| PATCH | `/api/v1/user-settings/add-locations` | **source-only** | user-settings |
| DELETE | `/api/v1/user-settings/add-locations` | **source-only** | user-settings |

Official `docs/zh/guides/11-oauth.md` documents MCP OAuth discovery. Extra OAuth JSON routes and all console/debug/user-settings/bot-studio routes are marked experimental until G3 classifies them. Default disposition for unclassified/source-only routes is deny.
