# R6a brief：把因果检索接到服务端 MCP 工具面（读侧，只增不改）

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（已有 `988148ad8`、`12f783d19`、`c63995f8e`、`145adc72b`、`63c915d5a`、`3cb319824`、`ef21efb8c`、`32218e516`、`e298e0158`、`8f6b4efdc`、`17d6310ba`）。**追加新提交；不要 rebase／amend；不要 push；不引新依赖；不动 `benchmark/`。**

设计依据（**已定案，按此实现**）：`CONSENSUS.md` 决策 **#93**（自主监听：每消息完整三段式检索）、**#96／#97**（混合检索的通道与配额；fact 空位不回填）、**#98**（Memory Agent 用卡片 id 展开邻域；诊断 agent 不用这个工具）、**#116–#122**（2026-09-29 实现期代定，理由见 `impl/decisions-20260929.md`），落点勘查见 `impl/R6-recon.md`。

**这一波只做读侧**：工具面 ＋ 门面构造。不做诊断侧接线（#122）、不调提取模型（#119 是下一波）、不改 `search`／`find` 的语义。

## 背景：门面早就写好了，只是没有生产构造点

`HybridRetrievalFacade`、`InfluenceProjectionAdapter`、`SegmentAtomAdapter`、`ForkBranchAdapter`、`RetrievalSubgraphAdapter` 今天**只在测试与 `benchmark/` 里构造**。写入侧已经会把文件落到会话目录（R5a／R5c）：`views.json`、`trajectory-index.json`、`projections.json`。

已核对的库 API（照用，不要另造）：

- `HybridRetrievalFacade(fork_branch, projection, segment_atom, *, rerank=None, acl_filter=None, feature_version=None, seed=None, fact_lane_paused=..., embedder=None, retrieval_subgraph=None)`（`retrieval_facade.py:1921`）
- `facade.retrieve(query, principal_labels, profile=None) -> RetrievalResult`（`:1955`；fact 通道暂停期间**不会**调 `segment_atom.search`，也不会回调 fact 空位）
- `facade.expand_claim_neighborhood(*, card_id=None, max_entities=...) -> AssembledPath`（`:2047`；只走 influence 边，不入库）
- `InfluenceProjectionAdapter(registry, views=None, content_resolver=None)`（`:1088`）、`SegmentAtomAdapter(session_dir, session_id)`（`:1344`）、`ForkBranchAdapter(root, store=None, *, session_dir, session_id)`（`:858`）、`RetrievalSubgraphAdapter(views, forks, *, session_acl, session_dirs)`（`:1573`）
- 标签回调：`openviking/session/session_acl.py` 的 `session_acl_callback(session)`（R5c）
- 读侧 principal：`tuple(acl_principals(ctx))`（`openviking/storage/acl.py:192`），与写入侧标签同一空间（#116）

## 要做的

### 1. 门面构造（新模块，建议 `openviking/session/retrieval_wiring.py`）

```python
def build_retrieval_facade(*, session: Any, ctx: Any, viking_fs: Any) -> HybridRetrievalFacade
```

- 会话目录解析**复用既有实现**（`trajectory_index_hook._session_dir` 的等价逻辑）；若需要，把它提成公共函数再两处共用，**不要造第二份解析**。
- 各适配器的来源：`views.json` → `ViewSupersedeIndex`（`InfluenceProjectionAdapter` 的 `views` 与 `RetrievalSubgraphAdapter` 共用）、`projections.json` → `ProjectionRegistry(path, session_acl=session_acl_callback(session))`、台账 → `SegmentAtomAdapter(session_dir, session_id)`。
- **fork store 的根**（#121）：该会话 owner 的 user 根（`canonical_user_root(ctx)` → `viking_fs._uri_to_path(..., ctx=ctx)`，见 `core/namespace.py:151`）；`CausalExperiencesStore(<user root>)` ＋ `ForkBranchAdapter(<user root>, store, session_dir=..., session_id=...)`。
- `session_dirs={session_id: session_dir}` 传给子图适配器；`session_acl` 用同一个回调。
- **文件不存在不得报错**：没有做过因果写入的会话要能构造出门面并返回空结果（`ViewSupersedeIndex`／`ProjectionRegistry` 对缺失文件是宽容的，照它们的语义走，别自己加严格断言）。

### 2. 两个 MCP 工具（`openviking/server/mcp_endpoint.py`）

放在 `find`／`search` 旁边，用 `get_service()` ＋ `_get_ctx()`：

- `retrieve_causal_cards(query, session_id, limit=None)` → 走 `facade.retrieve(query, tuple(acl_principals(ctx)), profile=None)`，返回 `result.to_dict()`（统一信封）。**不要把 profile 暴露给模型**——角色由服务端选（这一波用默认 profile）。
- `expand_causal_neighborhood(card_id, session_id)` → 走 `facade.expand_claim_neighborhood(card_id=card_id)`，返回 `path.to_dict()`。

两条共同要求：

- **调用期门控**（#120，沿用 `mcp_endpoint.py:513` 的 `is_intent_enabled` 先例）：`is_causal_mode_enabled(config, session_id=session_id)` 为假时抛一个**有类型的**错误（不要静默返回空——静默会让模型以为「查过但没有」）。用哪个异常类你来定，报告即可。
- session 的加载照 `search` 的写法（`:513-515`：`service.sessions.session(ctx, session_id)` ＋ `await session.load()`）；拿不到 session 时同样要有类型的错误。
- 不要改 `_format_search_result`，不要动 `search`／`find`／`recall` 的参数与行为。
- 输出里不得出现 `subtask` 字样；不得出现原始 AO 正文（沿用既有策略）。

### 3. 记数与文档

- `mcp_endpoint.py:2027` 那条硬编码的「16 tools: …」日志串要跟着改（工具数会变成 18）。
- `agent-plugins/skills/openviking-memory/SKILL.md` 加一段说明这两个工具**只在因果模式可用**；`agent-plugins/skills/openviking-memory/references/optional-tools.md` 里按该文件的既有分类补条目。**只写工具文档，不要改提示词策略。**

### 4. 不要做

- 不加诊断侧工具（#122）；子图检索与 fork 写入都不暴露给模型。
- 不调任何模型；不碰 Phase 1／Phase 2 与 `trajectory_index_hook.py` 的既有行为。
- 不改 `search`／`find` 的返回结构，也不把 causal lane 折进去（#120）。
- 不动 `benchmark/`；不引新依赖。

## 测试

新增 `tests/server/test_mcp_causal_read.py`（或你认为合适的位置）。仓里已有现成harness：`tests/server/test_mcp_search_modes.py:1-71` 用 `set_service(stub)` ＋ `mcp_endpoint._mcp_ctx.set(CTX)` 直接调工具函数，照它写。至少覆盖：

- 因果开关关着 → 有类型的错误，且**没有**去碰门面。
- 开关开着、会话有真实因果写入（用 `maybe_index_session_trajectory` 造：临时目录＋台账＋`MemoryConfig(skill_trajectory_mode="causal")`，见 `tests/test_session_acl.py` 的做法）→ owner 拿到卡片；**换一个用户的 `ctx` 拿到空**（这是 #116 的关键断言）。
- 展开工具：用上一步结果里的卡片 id 拿到邻域；别人的卡片 id → 报错或空（按库里 `expand_claim_neighborhood` 的既有语义，如实报告是哪种）。
- 没做过因果写入的会话 → 空结果、不抛。
- 序列化里没有 `subtask`。
- 一条「`search` 的行为没有被改」的断言（例如 `search` 仍未新增任何与因果相关的参数／不会返回因果卡片）。

## 交付要求

- 只改 OpenViking；不顺手重构；不跨波做诊断侧。
- 跑：`uv run pytest tests/server/ tests/test_retrieval_facade.py tests/test_session_acl.py tests/test_trajectory_index_hook.py tests/unit/test_mcp_tool_annotations.py tests/unit/test_mcp_tool_error_results.py -q -o addopts=''`。已知基线失败（不改、如实报告）：`test_trajectory_index.py::test_missing_projection_registry_warns_once_and_still_indexes`、`test_trajectory_index.py::test_supersede_without_revalidation_callback_warns_once`、`test_influence_projection.py::test_acl_change_without_revalidation_callback_warns_once`（若这条命令跑到它们的话）；`tests/session/test_session_commit.py` 在本环境有 `FileNotFoundError: /local/_system/runtime_config/cluster.json` 的 fixture 基线错误。
- 提交到 `feat/causal-subgraph-retrieval`，`feat(server): ...` 或 `feat(session): ...` 风格，不要 push。
- 回复报：新 commit 短哈希；两个工具的名字与签名；门面的构造点与 fork store 的根怎么定；门控抛的是哪个异常；展开工具在「别人的卡片 id」上的行为；`search`／`find` 是否逐字未改；测试条数与结果；以及任何你只能自己选一处的地方。
