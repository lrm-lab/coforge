# R4b brief：每个失败子图各写一份普通 fork（写）＋ R4a 暴露的两处小修

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（已有 `988148ad8`、`12f783d19`、`c63995f8e`、`145adc72b`、`63c915d5a`、`3cb319824`）。**追加新提交；不要 rebase／amend；不要 push；不引新依赖；不动 `benchmark/`（除非签名必须，先报告）。**

设计依据：`CONSENSUS.md` 叙述 95–99、103 与决策 #105、#106、#107、#108、#112；`CONTEXT.md` 术语「失败子图」「失败标记」「影响定位（接地）」；round-13 `round-13-questions.md` 的 Q145／Q146／Q147／Q148 原文。

这一波做**写**：把「带自己失败结论的检索子图各写一份普通 fork」变成服务端能力。**不改** R4a 已经交付的检索形状，**不进**混合检索（R6）。

## 要做的

1. **列出该 revision 上欠 fork 的失败子图**：给定一个冻结修订，返回 `is_failure` 为真的子图（顺序确定：按 `retrieval_subgraphs` 元组序）。这是 #106／#107 的「逐个」依据。
2. **写一份 fork**：门面外或诊断侧的写入口（放在 `CausalExperiencesStore` 一侧，或你选一个一致的位置），签名自定，职责是：给定
   - 目标冻结修订 + 该修订上的**一个**失败子图 id，
   - 诊断模型给的 `seven_sections`（七键都要）、`branches`、以及可选的 guidance（guidance 随分支保存，`branches` schema 本来就带 `guidance` 键），
   - 接地位置：`position_kind`（`block`／`edge`）与 `position_ref`，用 R4a 已经在用的那套 `kind:id` 解析约定，
   写入**一份普通 fork**：
   - `influence_grounding` = `{view_revision_id: 该冻结修订, position_kind, position_ref, semantic_summary_snapshot, content_hash, grounded_at}`；
   - 走既有 `CausalExperiencesStore.submit_fork_draft(...)` → `upsert_fork_node(..., idempotency_key=...)` 那条路，**不要另造写盘路径**；
   - anchor 从 `failure_evidence_refs[0]` 派生（`InfluenceEvidenceRef` 有 `ao_id`、`source_session_id`、`source_sequence`，够 `anchor_kind="ao"` 用）；`contemporaneous_basis` 要满足既有 `_check_contemporaneous_isolation`（`source_sequence < anchor_sequence`）。**若某个必填字段拿不到，报错并报告，不要猜、不要造默认值。**
   - 提供一个**派生默认接地位置**的辅助（从失败证据的 AO 落到该子图内覆盖它的 block）；推导规则你定，报告里写明——设计没规定失败结果的接地落在 block 还是边。
3. **必须拒绝的情形**：
   - 子图未打失败标记（#107：没有失败结果的不写 fork）；
   - 接地位置不在该子图内（复用 R4a 的位置解析，`cut` 与解析不出的都算不在内）；
   - 把一个修订上多份失败合成一份 fork，或把两份失败 fork 绑成一组同次返回（#105／#106 明写不做）；
   - 任务级结论单独再写一份 fork（#107：任务级「发布失败」不单独再发起一次检索）。
4. **幂等**：同一个（冻结修订，失败子图）重复写 → 走既有 idempotency 语义（同 key 幂等命中），**不要**产生第二份 fork；两份不同失败子图 → 两份不同的 fork，各自有独立身份。
5. **不许出现**：新 fork 种类、`cause_set`、`subtask_id`；也不要把这个写入口挂到 Memory Agent 的工具面（#112：Memory 不触发 diagnosis）。它是诊断侧的后置步骤。
6. 序列化／落盘的 fork 里不出现 `subtask` 字样（加一条断言测试）。

## 顺带（R4a 暴露，我判定该补，若你认为不该补就只报告不动）

7. **查询侧 ACL 对齐（fail closed）**：`RetrievalSubgraphAdapter.retrieve_historical_subgraphs` 今天只对**历史候选**过 `session_acl`，发起查询的那份 revision 不过（我实测：session 无标签也能发起并拿到命中）。按在线路径既有姿态补齐——当前修订的 session 拿不到标签或对 principal 不可见时，报错拒绝，不返回空结果。理由：`session_acl` 缺失时候选本来就全被滤掉、结果必为空，所以这条补上不会让任何配置从「能用」变「不能用」，只是把静默空结果变成显式拒绝。加一条测试。
8. **`_revision` 的报错要说清是「找不到」还是「不唯一」**：`retrieval_facade.py` 里 `_revision` 在跨 purpose 找到 0 个或 ≥2 个时都抛同一句 `is not in the supersede index`。我实测两个 session 用同一个 `revision_id` 时会命中后者，报错信息误导。分成两句，仍 fail closed（不许挑一个）。加一条测试。

## 测试

新建 `tests/test_subgraph_forks.py`（或你认为更合适的位置），至少覆盖：一份失败子图写出一份 fork；两份失败子图写出两份独立 fork（不合成、不同次返回）；未打标记 → 不写（报错）；接地在子图外 → 报错；`cut` → 报错；重复写同一份 → 幂等且只有一份；任务级结论不产生额外 fork；序列化无 `subtask` 字样；第 7、8 条各一条。

## 交付要求

- 只改 OpenViking；不顺手重构；不跨波做 R5／R6 的事。
- 跑：`uv run pytest tests/test_subgraph_forks.py tests/test_subgraph_retrieval.py tests/test_fork_revision_lifecycle.py tests/test_causal_experiences.py tests/test_influence_view.py tests/test_retrieval_facade.py tests/test_influence_projection.py tests/test_trajectory_index.py -q -o addopts=''`。已知基线 3 个失败（`test_influence_projection.py::test_acl_change_without_revalidation_callback_warns_once`、`test_trajectory_index.py::test_missing_projection_registry_warns_once_and_still_indexes`、`test_trajectory_index.py::test_supersede_without_revalidation_callback_warns_once`），不改、如实报告。
- 提交到 `feat/causal-subgraph-retrieval`，`feat(session): ...` 风格，不要 push。第 7／8 条若与前六条混在一起难看清，可以分成两个提交。
- 回复报：新 commit 短哈希；写入口签名与 anchor／接地的派生规则（明确标出哪些是实现侧选择）；幂等键怎么定的；测试条数与结果；以及任何让你觉得两处设计对不上、只能自己选一处的地方。
