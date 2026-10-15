# R4 勘查结论（ZCode 派 Explore 只读跑，2026-09-29）

用来写 R4 brief 的现状图。**只记事实**；不含设计提案。

## 1. fork 写入与接地

- 写入方：`CausalExperiencesStore`（`causal_experiences.py:1334`）。`submit_fork_draft(payload, *, influence_grounding=None) -> ForkDraft`（`:1620`，只校验、不落盘，强制 `status=draft`）；`upsert_fork_node(payload, *, idempotency_key, _allow_terminal_status=False) -> dict`（`:1419`，拒 `status=draft`，身份是 `{workspace_id, canonical_anchor_key}`）。
- `ForkDraft` 只有一个字段 `revision: ForkNodeRevision`，且要求 `status == "draft"`（`:728`）。
- `ForkNodeRevision`（`:561`）：`seven_sections` 七键**全部非空**（`_validate_seven_sections` `:356`）；`anchor` 判别式 `{ao, session_state, interaction_edge}`；`contemporaneous_basis` 用 `_check_contemporaneous_isolation`（`:546`）要求 `source_sequence < anchor_sequence`；`branches` 每项规范成恰好四键 `{branch_id, evidence_status, ao_sequence, guidance}`（`:397`）。
- `InfluenceGrounding`（`:435`）：`view_revision_id`、`position_kind`（`block`｜`edge`｜`cut`，`:75-80`）、`position_ref`、`semantic_summary_snapshot`、`content_hash`、`grounded_at`；`influence_position_key`（`:487`）。
- **缺口**：`position_ref` 是不校验的不透明字符串，没有类型化字段、没有代码把它对回真实 `block_id`／`claim_id`。测试里写作 `"block:42"`、`"edge:7"`。
- 反向索引 `intervention-index.json` 的读接口 `query_intervention_history(view_revision_id, position_key, principal_labels)`（`:1727`）只吃**精确** `position_key`，不能给一组位置。

## 2. `causal_clusters.py` 的相似边

- `VerifiedSimilarityEdge`（`:254`）两端硬性要求 `{fork_node_id, revision_id}`（`validate_endpoint` `:120`），比较也按 `fork_node_id` 对；**装不下 `view_revision_id`／`subgraph_id`**。
- 写入方是 `CausalClusterStore.submit_similarity_edge`（`:615`），**调用方只有测试**（`tests/test_causal_clusters.py`）。
- 全仓**没有**任何「跨任务 block 对 block」的相似边代码；`causal_clusters.py` 里 `block_id` 零命中。
- 结论（事实层）：想复用它做子图对子图需要新端点模式，等于换一种边。

## 3. 历史视图存哪

- `TrajectoryIndexService` 自己的 JSON 只存**队列**，不存视图（`to_dict` `:397`）。
- 冻结视图（含 `retrieval_subgraphs`）唯一的完整存放处是注入的 `ViewSupersedeIndex`（`influence_view.py:1729`），接口 `latest`／`history`／`to_dict`，键是 `(session_id, purpose)`，`purpose ∈ {post_run_index, failure_diagnosis}`；**没有按 purpose 跨 session 枚举的读接口**。
- `IndexJob`（`:105`）只有 `job_id`／`session_id`／`task_run_id`／`priority`／`outcome_status`／`enqueued_at`。
- 生产侧没有任何 `ViewSupersedeIndex`／`TrajectoryIndexService` 的路径约定，只有测试里 `tmp_path` 的用法。

## 4. 投影登记

- `ProjectionRegistry` 有 `register`／`search`（仅活动卡）／`get(card_id)`／`promote_to_verified`／`handle_acl_change`／`withdraw_superseded`／`removed_records`／`to_dict`／`from_dict`。
- `_supersede_locked`（`:659`）只保留每个 `(session_id, purpose)` 的最新修订；**没有**取历史（已撤下）修订卡片集合的接口；历史只散在 `removed_records()` 的行里，且 `RemovalRecord` 不带 `purpose`。
- `_labels_for(session_id, acl_labels)`（`:620`）靠注入的 `session_acl`；无标签返回空。
- `_embedding_stub`（`:140`）= `{provider: "stub", dimensions: 0, digest: content_hash}`；`_real_vector`（`retrieval_facade.py:537`）拒维度 0，永远进不了 hybrid 档。`_cards_from_revision` 只遍历 blocks 与 claims，**`retrieval_subgraphs` 不产生投影卡片**。

## 5. 检索门面

- 三个适配器：`ForkBranchAdapter`（`:775`）、`InfluenceProjectionAdapter`（`:1011`）、`SegmentAtomAdapter`（`:1276`）；`CorpusAdapter` 协议在 `:458`。
- `RetrievalCard` 字段见 `:186`；`RetrievalProfile` 在 `:314`（默认 6/4/2，`coerce_profile` `:356` 管总和 ≤ 12）；配额在 `_lane_cards`（`:1594`）逐适配器给 `limit`。
- 门面公开方法只有 `retrieve`（`:1533`）与 `expand_claim_neighborhood`（`:1624`）。
- **没有任何东西**把检索卡片与子图关联（`retrieval_facade.py` 里 `subgraph` 零命中）。
- 生产接线：只有 `tests/test_retrieval_facade.py` 与 `benchmark/causal_memory/l1_locomo_hitk.py:97-103` 构造过门面；`session.py` 里 `causal` 零命中。没有任何生产调用方传 `embedder=`。
- 在线围栏（`retrieval_facade.py:36-42`）：在线代码不许调 `materialize_strength(None)`、`CitationLedger.events()`、`CausalBridgeStore.list_bridges`、`ProjectionRegistry.to_dict`。

## 6. 全仓「不存在」清单

1. 子图检索／子图对子图相似：不存在。
2. 卡片到子图的映射、`subgraph_id` 进 `source_pointer`／`InfluenceProjection`：不存在。
3. `failure_marked`／`is_failure` 的消费方：不存在（只有定义、校验与测试）。
4. 诊断侧检索入口：不存在。诊断侧只有回调座位：`DiagnosisFn`（`evaluation_loop.py:60`）拿的是 `_brief_view` 拼的字典（`:338`），里面**没有语料、没有子图**；`DiagnosisBrief`／`DiagnosisOutcome`（`handoff_envelope.py:196`／`:257`）也没有子图引用。
5. 接进 session 子树的真实 embedder：不存在（只有门面构造参数，测试注入）。
6. `InfluenceGrounding.position_ref` 与真实 block／claim 的类型化连接：不存在。
7. `HybridRetrievalFacade`／`TrajectoryIndexService`／`ViewSupersedeIndex`／`ProjectionRegistry`／`CausalExperiencesStore`／`CausalClusterStore` 的生产构造：不存在。

## 7. 测试落点

`tests/test_retrieval_facade.py`(29)、`tests/test_influence_view.py`(22)、`tests/test_influence_projection.py`(16)、`tests/test_trajectory_index.py`(14)、`tests/test_causal_bridges.py`(15)、`tests/test_fork_revision_lifecycle.py`(13)、`tests/test_causal_experiences.py`(11)、`tests/test_evaluation_orchestrator.py`(11)、`tests/test_handoff_envelope.py`(10)、`tests/test_citation_ledger.py`(9)、`tests/test_causal_clusters.py`(8)、`tests/test_outcome_utility.py`(5)、`tests/test_evaluation_loop.py`(3)、`tests/test_skill_trajectory_mode.py`(6)。没有子图检索的测试文件。
