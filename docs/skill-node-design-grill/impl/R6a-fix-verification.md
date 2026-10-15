# R6a-fix 独立复核（ZCode，2026-09-29）

提交 `a3977bbe3` `fix(session): fail closed on claim-card neighborhood expansion`，未 push。落实决策 #123。

## 交付物核对

4 个文件：`retrieval_facade.py`（+54/−14，适配器与门面两层）、`mcp_endpoint.py`（+13/−4）、`tests/test_retrieval_facade.py`（+34）、`tests/server/test_mcp_causal_read.py`（+19）。

- `principal_labels` 是**仅关键字**参数，默认 `()`（`InfluenceProjectionAdapter.expand_claim_neighborhood` 与 `HybridRetrievalFacade.expand_claim_neighborhood` 同签名，门面原样透传）。
- 求交复用既有原语 `_principal_set` / `_labels_visible`，判定在 `registry.get` 之后、**在报 kind 之前**：不可见的 block 卡片也只报 `unknown card id`，不泄漏存在性；可见但不是 claim 的卡片才报 kind。文案与「真不存在」逐字相同。
- MCP 工具改成把 `tuple(acl_principals(ctx))` 传进去（那个下划线 `_ctx` 消失了）。

## 我复跑

`uv run pytest tests/test_retrieval_facade.py tests/server/test_mcp_causal_read.py tests/test_influence_projection.py tests/test_subgraph_retrieval.py -q -o addopts=''` → **1 failed, 60 passed**；失败是已知基线 `test_acl_change_without_revalidation_callback_warns_once`。

全量顶层 `tests/*.py` 复跑 → **773 passed / 7 failed / 16 errors**，与前一次逐字相同（无回归）。

## 我的探针（同一支 `/tmp/probes/exp_r6a_tools.py`，改判据后 15 条全过）

上一轮**就是这支探针**在同一条调用上抓到漏口的（当时断言「intruder 拿到 entities=2／edges=1」成立）。现在把同一处改成「必须抛错」，结果：

- owner 带自己的标签 → 仍返回邻域（`entities=2`），说明门没有把合法路径一起关掉。
- intruder 的标签 → `unknown card id 'claim-card-0e3048c6'`。
- **默认不传标签** → 同一条 `unknown card id` 错误（默认即「什么都不可见」，不是「不过滤」）。
- 同一次调用里 `retrieve_causal_cards` 仍是 0 张 —— 读侧两道门都关着。

## 一处要记的边界（不是缺陷）

`(view_revision_id, claim_id)` 这条**兼容入口**按设计不解析卡片 id，因此不套这道门（作者如实报告了）。我 grep 了 `mcp_endpoint.py`：没有任何 MCP 工具暴露这两个参数，模型够不到它。**结论：今天不可达**；将来若要加工具，不能把这条入口透出去。
