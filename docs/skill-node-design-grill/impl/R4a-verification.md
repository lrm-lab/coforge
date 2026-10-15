# R4a 验证记录（ZCode 独立复跑）

提交：`3cb319824`（`feat(session): retrieve historical failure subgraphs for diagnosis`），3 文件 +1019/−3。未 push。

## 我复跑的结果

`uv run pytest tests/test_subgraph_retrieval.py tests/test_influence_view.py tests/test_retrieval_facade.py tests/test_fork_revision_lifecycle.py tests/test_influence_projection.py tests/test_trajectory_index.py -q -o addopts=''`
→ **105 passed / 3 failed**，3 条与基线一致。`tests/test_subgraph_retrieval.py` 新增 10 条。

## 逐条核对（读代码）

- `ViewSupersedeIndex.revisions_for_purpose`（`influence_view.py:1763`）：锁内读 `self._history`，顺序 `session_id` 再登记序，**不调 `to_dict`**；docstring 明写不做 ACL。有测试 `test_online_read_does_not_call_supersede_to_dict`。
- 入口 `HybridRetrievalSubgraphAdapter.retrieve_historical_subgraphs`（`:1592`）／门面 `:2044`：先 `_revision` 解析当前修订，再 `_require_failure_subgraph`（未标记即 `ValueError`），语料只取 `PURPOSE_POST_RUN_INDEX` 且排除自身修订，命中上限 `DIAGNOSTIC_SUBGRAPH_HIT_CAP = 3`。
- `_subgraph_members`（`:1424`）：只取该子图点名的 block／claim，旁路子图的成员进不来。
- `_subgraph_retrieval_text`（`:1443`）：block 的 `summary`／`input`／`output` 加 claim 的 `carried_artifact`／`downstream_effect`；不含 id、role、`relation_type`、失败标记、guidance、原始 AO。占位标为 `SUBGRAPH_TEXT_POLICY_VERSION = "subgraph-text-pending-v0"`。
- `_rank_document_indexes`（`:714`）：非空 query 丢 BM25 为 0 的候选，空 query 保序，同分保序；不 embed。
- `_forks_inside`（`:1684`）：遍历 `ForkBranchAdapter._fork_ids()` 的**每个 fork 节点的每条已落库 revision**（含被 supersede 与 invalidated 的），接地条件为 `view_revision_id` 相等且位置在子图内；fork 标签沿用 `workspace_id` 与 principal 求交。
- 候选 ACL 在进 BM25 语料之前做（`:1614-1616`），无标签即不可见，不占 3 份配额。

## 我亲手跑的行为探针（`/tmp/r4a-probe/exp_r4a.py`，独立于仓库测试）

构造：一份带标签的历史 view（`sess-hist`）＋一份无标签的当前 view（`sess-secret`），四份相似历史子图，以及一份不相关子图。

| 探针 | 结果 |
|---|---|
| 上限 | 4 份候选 → 返回 3 份，无回填 |
| 旁路 | 命中里只有该子图自己的 block／claim |
| 零分 | 主题无关的历史子图（BM25 全 0）被丢掉，只剩 1 份命中 |
| 拒绝 | 未打标记／不在该修订上的子图 id → `ValueError` |
| **查询侧 ACL** | **无标签的 session 照样发起成功并拿到命中（缺口确认）** |

## 需要记下来的三点

**1. 查询侧不过 ACL（已于 R4b 处理）。** 上表最后一行。R4b brief 第 7 条要求按在线路径既有姿态补齐（fail closed），理由：`session_acl` 缺失时候选本来就被全滤掉、结果必为空，所以补上不会让任何配置从「能用」变「不能用」，只是把静默空结果变成显式拒绝。

**2. `_revision` 的报错把「找不到」和「不唯一」混成一句。** `retrieval_facade.py:1647`：跨 purpose 找到 0 个或 ≥2 个都抛 `is not in the supersede index`。我实测两个 session 用同一个 `revision_id` 时命中后者，信息误导。R4b brief 第 8 条要求分成两句，仍 fail closed（不许挑一个）。

**3. 历史语料不要求带失败标记，这是对的。** 我确认语料侧（`post_run_index` 上全部子图）没有 `is_failure` 闸门，只有查询侧有。这与 Q143 的例子一致（第三份历史子图「没有 fork」仍在三份里），也与决策 #104／`CONTEXT.md`「诊断子图命中」的措辞一致（只写「一份历史检索子图」，不要求标记）。**这条不是缺陷，是实现侧忠实照做**，但如果设计本意是「只召回历史失败子图」，那就是设计文本没写清楚——列进待确认。
