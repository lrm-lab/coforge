# R6a-fix brief：给卡片解析补 principal 门（决策 #123）

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（已有 `988148ad8`、`12f783d19`、`c63995f8e`、`145adc72b`、`63c915d5a`、`3cb319824`、`ef21efb8c`、`32218e516`、`e298e0158`、`8f6b4efdc`、`17d6310ba`、`f9ec022f9`）。**追加新提交；不要 rebase／amend；不要 push；不引新依赖；不动 `benchmark/`。**

设计依据：`CONSENSUS.md` 决策 **#116／#117**（因果检索一律按 owner 标签过滤，fail closed）、**#123**（按卡片 id 解析的入口一律过 principal；理由见 `impl/decisions-20260929.md`）。

## 问题（我实测过，不是推测）

同一份 `views.json`／`projections.json` 上换一个 ctx：

- `facade.retrieve(query, tuple(acl_principals(intruder_ctx)))` → **0 张卡**（投影适配器的标签门守住了）
- `facade.expand_claim_neighborhood(card_id=<owner 的 claim 卡片>)` → **entities=2、edges=1**（没有任何门）

MCP 工具 `expand_causal_neighborhood` 今天因此只用 `_ctx`（`mcp_endpoint.py` 里那个下划线变量就是它）。今天没有可达的跨用户路径（会话 URI 由调用方 ctx 推出），但 #117 的口径是「一律过滤」，所以按 fail-closed 补上。

## 要做的

1. **`InfluenceProjectionAdapter.expand_claim_neighborhood`**（`retrieval_facade.py:1182`）加一个 `principal_labels` 参数，**默认空序列 `()`**——默认即「什么都不可见」，不是「不过滤」。解析出卡片后（`_resolve_claim_card`，`:1321`）做一次集合求交：不可见时抛**同一个** `ValueError("unknown card id ...")`，**不要**另给一个「无权访问」的错误（那会泄漏该 id 存在）。求交复用既有原语（`_labels_visible` / `_principal_set`，`:822-829`），不要新造比较。
2. **`HybridRetrievalFacade.expand_claim_neighborhood`**（`:2047`）透传这个参数，同样默认空序列。
3. **MCP 工具**：`expand_causal_neighborhood` 传入 `tuple(acl_principals(ctx))`（别再丢掉 `_ctx`）。
4. **既有调用点与测试**：`tests/test_retrieval_facade.py` 等凡是要拿到路径的用例，显式传该卡片的可见标签（例如 `("user:...",)` 或它自己造标签）。这些测试因此成为这道门的文档；**不要**为了让旧断言继续通过而放宽默认值。
5. 序列化里仍不得出现 `subtask` 字样；不改 `retrieve` 的既有行为；不动 `search`／`find`。

## 测试

- 同一会话、同一卡片 id：owner 的标签 → 返回路径；**不相交的标签 → 抛 `unknown card id`**（断言错误文案与「不存在」完全相同，不泄漏存在性）。
- 默认调用（不传 `principal_labels`）→ 抛 `unknown card id`。
- MCP 工具层：换一个 ctx 调 `expand_causal_neighborhood` → 抛错，且 `retrieve_causal_cards` 仍返回 0 张（两条一起断言，钉住「读侧两道门都关着」）。
- 跑：`uv run pytest tests/test_retrieval_facade.py tests/server/test_mcp_causal_read.py tests/test_influence_projection.py tests/test_subgraph_retrieval.py -q -o addopts=''`。已知基线（不改、如实报告）：`test_influence_projection.py::test_acl_change_without_revalidation_callback_warns_once`。

## 交付要求

- 提交到 `feat/causal-subgraph-retrieval`，`fix(session): ...` 风格，不要 push。
- 回复报：新 commit 短哈希；改动的方法签名；哪些既有测试被改成了传标签（列出条数）；MCP 工具现在的行为；以及任何你只能自己选一处的地方。
