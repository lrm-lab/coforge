# R6 派发前勘查：读侧接线点到底在哪（ZCode，2026-09-29）

**一处重要更正**：我之前把 R6 的工具面写成「本仓库 `agent-plugins/`」。实测**不是**——`agent-plugins/` 只是一个把 JSON-RPC 转发给服务端 `/mcp` 的代理（`agent-plugins/servers/mcp-proxy.mjs:33` → `servers/shared/mcp-proxy-core.mjs:192-219`，`tools/list` 直接合并服务端结果，`tools/call` 只在本进程有 `localToolProvider` 时才拦截，而 `agent-plugins` 的入口**没有传**这个 provider）。**真正的工具面在服务端 `openviking/server/mcp_endpoint.py`**：`mcp = FastMCP(...)`（`:245`），工具都是 `@mcp.tool(...)` 装饰的普通 async 函数，进程内通过 `get_service()` 执行。所以 R6 加工具是改服务端 Python，加完还要改 `mcp_endpoint.py:2027` 那条硬编码的「16 tools: …」日志串与 `agent-plugins/skills/openviking-memory/SKILL.md` 的文档。

## 现有读路径（没有任何 causal 门面）

MCP：`find`（`mcp_endpoint.py:339` → `:372 service.search.find`）、`search`（`:392` → `:446 assemble_context` 或 `:516 service.search.search`）。REST：`routers/search.py:347`／`:452`／`:518`。服务层：`service/search_service.py:139 find`／`:91 search` → `storage/viking_fs/_semantic.py:192`／`:374` → `retrieve/hierarchical_retriever.py:101` → 向量后端 `viking_vector_index_backend.py:1601`。回给模型是 `mcp_endpoint.py:576 _format_search_result`（项目符号列表）。

## 三个必须先知道的约束

1. **`ctx` 到处都在，principal 却不**。`RequestContext` 在每个进入点都在作用域里（MCP `_get_ctx()` `:114`，`find` 在 `:351` 取、`search` 在 `:426` 取；REST 走 `Depends(get_request_context)`），但 `acl_principals(ctx)`（`storage/acl.py:192`）**在 `mcp_endpoint.py` 里没有被 import**，今天只有 `viking_vector_index_backend.py:31,2908` 在用。新读路径要自己 import 它，把 principal 传进门面的 `principal_labels`。
2. **只有 `search` 带 session id**。MCP `search` 有 `session_id: Optional[str]`（`:396`，`:513-515` 用它 load session）；`find`（`:340-381`）与 `POST /find` **没有**。因果读是按 session 取 `views.json`／`projections.json`／fork store 的，所以在 `find` 上做要么加参数，要么不做。
3. **门面构造点**。唯一同时握有 `ctx`、可选 `Session` 与 `viking_fs` 的层是 `service/search_service.py`（`self._viking_fs` 在 `:51`，`session` 在 `search` 里）；备选是 `storage/viking_fs/_semantic.py:192`／`:374`（那里 `_uri_to_path` 与 `acl_manager` 是原生的）。会话目录的解析今天唯一的生产实现是 `trajectory_index_hook.py:65 _session_dir(session)`（`ao_ledger_recorder.py:294` 有一份重复）。

## 与写入侧的对接现状（R5c 之后）

`views.json`、`trajectory-index.json`、`projections.json` 都会在 causal 模式下按会话目录落盘（R5a／R5c）；`CausalExperiencesStore`（fork store，`causal_experiences.py:1334`）**生产上仍然没有构造点**，`subgraph_forks.py` 与 `evaluation_loop.py` 在 `openviking/`、`openviking_cli/` 里都没有 import 者。也就是说 R6 若接 fork 通道，得先给 store 一个生产根目录。

## 开关与先例

`resolve_skill_trajectory_mode` / `is_causal_mode_enabled`（`openviking_cli/utils/config/memory_config.py:259-299`）走进程单例 `get_openviking_config()`；今天**只在写入侧被查**（`trajectory_index_hook.py:278`、`ao_ledger_recorder.py:472`、`causal_bridges.py:972`、`causal_clusters.py:482`、`causal_experiences.py:1358`），读侧一次都没查。工具按配置分流的先例是 `mcp_endpoint.py:513 if session_id and service.search.is_intent_enabled()`。

## 结论：R6 的落点清单

1. 新工具：`mcp_endpoint.py` 里 `find`／`search` 旁边加 `@mcp.tool`，用 `get_service()` ＋ `_get_ctx()`；带上 `session_id` 参数。
2. 记数：`mcp_endpoint.py:2027` 的 16 工具日志串；`agent-plugins/skills/openviking-memory/SKILL.md` 与 `references/optional-tools.md` 的文档。
3. 门面构造：`service/search_service.py`（`ctx` ＋ `Session` ＋ `_viking_fs` 齐）；适配器要的 `views.json`／`projections.json`／`session_dir` 都已存在，fork store 需要新给根目录。
4. principal：在构造点 import `acl_principals` ＋ `AclAction`，把 `tuple(acl_principals(ctx))` 当 `principal_labels` 传进去（与 #116 的标签空间一致）。
5. 开关：读侧也要查 `is_causal_mode_enabled`；缺席时保持今天的行为不变。
6. 诊断侧接线（`write_failure_subgraph_fork` 的调用者）按 #119 落在 Phase 2 的提取路径，与提取模型的调用点是同一个地方。
