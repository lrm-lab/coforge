# R6a 独立复核（ZCode，2026-09-29）

提交 `f9ec022f9` `feat(server): expose causal card reads on the MCP tool surface`，未 push。

## 交付物核对

8 个文件：`retrieval_wiring.py`（新，87 行）、`mcp_endpoint.py`（+95）、`trajectory_index_hook.py`（+11：`_session_dir` 提升为公共的 `session_directory`，保留私有别名）、`server/app.py`（+7：工具计数 16→18 的注释）、`agent-plugins` 两处 skill 文档、`tests/server/test_mcp_causal_read.py`（新，321 行）、`tests/unit/test_mcp_tool_annotations.py`（+2）。

- `search`／`find` 的函数体没改（只有 import、插在旁边的两个新工具、计数日志）——我看了 diff，确认是纯插入。
- 两个工具名字与签名如简报：`retrieve_causal_cards(query, session_id, limit=None)`、`expand_causal_neighborhood(card_id, session_id)`；都带只读注解；`profile` 没有暴露给模型。
- 门控在 `_open_causal_facade` 里，**在加载会话之前**；关着抛 `FailedPreconditionError`，不是空列表。
- fork store 根＝请求方的 user 根（`canonical_user_root(ctx)` 经 `viking_fs._uri_to_path`），会话目录复用 `session_directory`，`views.json` 只加载一份给两个适配器共用，`projections.json` 用 `session_acl_callback(session)`——与 #121／#116 一致。
- 没有接 `content_resolver`（原始 AO 正文不进卡片也不进 BM25 文档）。

## 我复跑

- `tests/server/test_mcp_causal_read.py` → **6 passed**。
- `tests/server/ ＋ tests/unit/test_mcp_tool_annotations.py` 在 HEAD 是 **53 failed / 724 passed / 964 errors**；我把**同一命令**在 base `e8a8babf4` 上跑了一遍 → **53 failed / 650 passed / 973 errors**。失败数完全一致（53），通过数 +74（本波新增用例），错误数不升反降。**失败与错误都是这台机器的环境基线**，不是这次改动带进来的。
- 根因确认：抽一条 error 看到 `Raises FileNotFoundError if no config file is found` —— 本机没有 `ov.conf`，`OpenVikingService` 起不来，与 cursor 的说法一致。

## 我的探针（`/tmp/probes/exp_r6a_tools.py`，13 条断言全过）

用真实因果写入（AO 台账＋`maybe_index_session_trajectory`＋不调模型的提取提供方）跑两个工具：

- **门先跑**：causal 关着时抛 `FailedPreconditionError`，且 `sessions.session` 的调用记录是**空**——会话没有被加载，门在构造之前。
- **owner 读**：拿到 2 张卡（block 投影＋claim 投影），claim 卡片 id 是不透明的 `claim-card-0e3048c6`；载荷里**没有**原始 AO 正文哨兵、没有 `subtask` 字样。
- **展开**：claim 卡片 id → 返回路径（entities／edges）。
- **门的位置差别**：同一份文件上换 ctx，`retrieve` 得到 **0 张**，而 `expand_claim_neighborhood` 仍然交出 **entities=2／edges=1**。

## 结论与已开的口子

R6a 本波交付的东西是对的、可用，且**只增不改**。上面最后一条是**纵深防御缺口**，不是可达漏洞：MCP 工具只收 `session_id`，会话 URI 由调用方 ctx 推出（`service/session_service.py:213` 传 `session_uri=None`），而唯一传 `session_uri=` 的生产路径是 Phase 2 的队列提交（URI 来自入队消息，不由请求方控制），所以跨用户读不到别人的会话目录。但 #117 的口径是「一律过滤」，修起来只是解析后加一次集合求交，因此已按 **#123** 派发 `R6a-fix`。
