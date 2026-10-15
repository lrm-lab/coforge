# R1 验证记录（ZCode 独立复跑）

提交：`988148ad8 feat(session): rank causal retrieval with BM25 and pause the fact lane`（分支 `feat/causal-subgraph-retrieval`，3 文件 +964/−94）。

## 通过项

- `uv run pytest tests/test_retrieval_facade.py tests/test_influence_view.py tests/test_influence_projection.py tests/test_trajectory_index.py -q`：**63 passed, 3 failed**。3 个失败在基线提交 `e8a8babf4` 上逐一复跑，**同样失败**（`test_influence_projection::test_acl_change_without_revalidation_callback_warns_once`、`test_trajectory_index::test_missing_projection_registry_warns_once_and_still_indexes`、`test_trajectory_index::test_supersede_without_revalidation_callback_warns_once`），不是本提交引入。
- 顶层全量 `uv run pytest tests/*.py -q`：**699 passed, 7 failed, 16 errors**；与基线对比失败集合**完全一致**（差异只有 `test_task_tracker::test_terminal_event_waits_for_owned_work[complete]` 一条，隔离复跑在两边都时好时坏，判定为既有 flaky）。errors 全部是 `FileNotFoundError` 的既有环境问题（session task tracking / async commit 等）。
- 整目录 `tests/` 跑不完：3 个收集错误（`test_task_processing_time`、`test_semantic_processor_permanent_storage_error`、`test_opengauss_database_integration` 需要外部服务），且有测试会挂住超过 15 分钟——按 CONTRIBUTING 的做法用聚焦命令，不用全量。
- 设计点核对（读 diff）：`FACT_LANE_PAUSED = True` 默认暂停、暂停时不调用 segment_atom 的 search、`DEFAULT_SEGMENT_ATOM_QUOTA = 2` 与 `CARD_KINDS`/`FACT_KINDS`/`CARD_CHANNELS` 未改；`rank_mode` 默认 `bm25`、`_RankPlan` 负责"没有真实向量就退回 BM25"、分数写进 `score_breakdown`（`bm25`/`lexical`/`rank_tier`），非空 query 的 0 分文档不进结果；`expand_claim_neighborhood` 建邻接前滤掉非 influence，skip 种子只放两端 block、自身边不返回，双向走与 12 block 上限保留。

## 缺陷（已派 R1b 修复）

`openviking/session/bm25.py` 的 `tokenize` 用 `\w+`，CJK 连续汉字落成**一个 token**，部分重叠算不出来：

```
tokenize('这次发布必须蓝绿') -> ['这次发布必须蓝绿']
tokenize('蓝绿发布')        -> ['蓝绿发布']
BM25Index([...]).scores('这次发布必须蓝绿') -> [1.394, 0.0, 0.0, 0.0]
```

与 `round-12-questions.md` Q127 A 档的期望不符（那里要求「只共享『绿』这个片段」也能算重叠，含「蓝绿发布」的 fork 要排前面）。新增测试全是英文，所以没覆盖到。

## 待定参数（已要求标注）

混合档权重 `HYBRID_BM25_WEIGHT = 0.25` / `HYBRID_VECTOR_WEIGHT = 0.75` 在设计记录里没有出处（#95／叙述 86 只规定"合成名次"）。已要求 R1b 加 policy 版本常量标明它是待定参数，并在回复里说明取值理由。
