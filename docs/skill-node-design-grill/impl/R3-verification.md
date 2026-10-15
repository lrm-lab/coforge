# R3 验证记录（ZCode 独立复跑）

提交：`63c915d5a`（`feat(session): freeze model-drawn retrieval subgraphs with explicit failure markers`），分支 `feat/causal-subgraph-retrieval`，2 文件 +519/−3。未 push。

## 我复跑的结果

`uv run pytest tests/test_influence_view.py tests/test_influence_projection.py tests/test_retrieval_facade.py tests/test_causal_experiences.py tests/test_trajectory_index.py -q -o addopts=''`
→ **89 passed / 3 failed**，3 条失败与基线一致（`test_acl_change_without_revalidation_callback_warns_once`、`test_missing_projection_registry_warns_once_and_still_indexes`、`test_supersede_without_revalidation_callback_warns_once`）。`tests/test_influence_view.py` 新增 10 条（12 → 22）。

## 逐条核对（读代码，不看自述）

- `RetrievalSubgraph`（`influence_view.py:703`）字段 `subgraph_id` / `block_ids` / `claim_ids` / `failure_marked=False` / `failure_evidence_refs=()`。记录上没有 `session_id`、`task_run_id`、`revision_id`、`view_id`。
- `is_failure`（`:730`）只返回 `failure_marked`；docstring 写明结论块不算。测试 `test_conclusion_block_without_marker_is_not_a_failure_subgraph`（`:761`）钉住这条。
- `compute_content_hash`（`:765`）第 4 个参数 `retrieval_subgraphs`，规范 JSON **始终**带这个键（空元组也带）。`freeze` 传的是冻结时的元组。
- 旧数据：`from_dict` 缺键 → 空元组，且**不重算**已存 `content_hash`。测试 `:609-611` 覆盖（丢掉键后 `content_hash` 与原件相同）。
- 5 个 violation code 都在 `_retrieval_subgraph_violations`（`:1359`），全部 `severity="high"`，所以 `freeze` 会拒：`subgraph_unknown_member`、`subgraph_claim_endpoint_outside`、`duplicate_subgraph_id`、`subgraph_block_limit`、`subgraph_failure_evidence`。
- `build_minimal_fallback_view` 与 `_with_diagnosis_root_sink` 不写子图；测试 `:805` 覆盖（两份视图 `retrieval_subgraphs == ()`）。
- 全仓（`openviking/session/`、`tests/test_influence_view.py`）除断言外无 `subtask` 字样；`test_retrieval_subgraph_serialization_omits_subtask_wording`（`:788`）断言序列化文本里没有。

## 我自己发现、需要记下来的两点

**1. `add_retrieval_subgraph` 目前没有任何生产调用方。** 全仓只有 `influence_view.py:864` 的定义。也就是说这一波给的是**能力**：冻结修订能装、能校验、能算 hash、能往返，但今天**没有东西会在 commit 时真的写入子图**——那是 R5（`TrajectoryIndexService` 挂到 session commit）的事。不要把「R3 完成」读成「子图已经在写」。

**2. `content_hash` 的口径变了。** 因为规范 JSON 多了一个键，同样内容的视图在 R3 之后新冻结，摘要与 R3 之前不同。唯一消费影响图 `content_hash` 的地方是 `trajectory_index.py:464 _content_hash_registered_locked`（判断「同一 session+purpose 的这一份内容是否已索引」），它比较的是同一代码版本内新算出来的摘要，所以幂等性本身不受影响；受影响的情况只有「R3 之前落盘、之后重新索引」，会被当成新内容——最多多一条索引记录，不丢数据。我确认了磁盘上没有任何已落盘的 view／轨迹索引数据（`find` 无命中），所以没有实际存量要迁移。

## R3 自报、我确认属实的设计张力

Cursor 主动报了两处需要设计确认的地方（不是它自己决定的）：

1. **失败子图看结论块还是只看显式标记。** 叙述 94／#103 说含 `conclusion` 块即失败子图；叙述 99／#108 与 `CONTEXT.md`「失败标记」的 `_Avoid_` 说标记由提取模型写入、不要只用 conclusion 角色。R3 按 #108＋CONTEXT 实现：`is_failure` 只读 `failure_marked`。需要定 #108 是否已取代 #103，还是两条要同时成立（必须既有标记又有 conclusion 块）。
2. **「子图内 block 不超过 12」加在写视图时还是检索返回时。** 决策表 #104 只写「最多返回 3 份、不足不回填」，12 出现在叙述 95 同一句里。R3 做成冻结前的 `subgraph_block_limit`；若 12 只约束检索交回的历史子图，写时拒绝会比决策表更严。
