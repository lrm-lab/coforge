# R3 brief：检索子图 + 失败标记写进冻结 view

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（已有 `988148ad8`、`12f783d19`、`c63995f8e`、`145adc72b`）。**追加新提交；不要 rebase／amend；不要 push；不引新依赖；不动 `benchmark/`（除非签名必须，先报告）。**

设计依据：`skill-node-design-grill/CONSENSUS.md` 叙述 91–94、99、101–103；决策 #101、#103、#104、#107、#108、#110、#111；`CONTEXT.md` 术语「检索子图」「失败标记」「失败子图」。

## 背景

今天没有任何「子图」概念。影响图只有 block 与 claim（`influence_view.py`）。设计要的是：commit 之后提取影响图时，**由模型**把动作划成**检索子图**，和失败标记一起写进冻结 view。这一波只做数据模型 + 校验 + 冻结 + 序列化；子图检索（子图比子图、3 份帽、接地 fork、写 fork）是 R4，不要在这一波做。

## 要做的

1. **新记录类型 `RetrievalSubgraph`**（名字你定，但**不许出现 `subtask` 字样**，尤其不许有 `subtask_id` 字段）。字段至少要有：
   - 子图 id：在本 revision 内唯一；**不得内嵌 `session_id`、`task_run_id`、`revision_id`／`view_id`**（沿用 R2b 的取向：给模型看的东西不带内部 id）。
   - 该子图划定的 block（`block_id` 元组）与其内部 influence 边（`claim_id` 元组）。
   - 失败标记：**显式的、由提取模型写入的**标记，外加失败结果的证据引用（`InfluenceEvidenceRef` 元组）。带标记时证据必须非空；不带标记时证据必须为空。
2. **挂到 `InfluenceViewRevision`**：新增字段（默认空元组，保持既有构造点不炸），进 `to_dict`／`from_dict`，进**冻结修订的相等比较**，并且**进 `content_hash`**——`compute_content_hash` 今天只吃 blocks/claims/coverage，加上子图。子图不同的两份修订，hash 必须不同。
3. **草案侧写入入口**：`InfluenceViewDraft` 上加一个追加子图的方法，走 `validate_view` 同一套 `Violation` 机制。冻结之后不可改（冻结修订本身不可变就行）。
4. **校验规则**（都用既有 `Violation` 形状，新增 code）：
   - 子图引用的 `block_id`／`claim_id` 必须在同一 revision 里存在 → 否则 violation。
   - 每条 claim 的两端都必须落在该子图的 block 里 → 否则 violation。
   - 子图 id 在同一 revision 内重复 → violation。
   - 子图内 block 数超过 **12** → violation（决策 #104「子图内 block 不超过 12」）。这是我按 #104 读出的施加点，写进报告里等我确认，不要改设计。
   - 带标记但证据为空、不带标记但证据非空 → violation。
5. **不许从块角色推标记**：`influence_view.py` 里有 `ROLE_CONCLUSION = "conclusion"` 与 `BLOCK_ROLES`。**失败标记绝不能由「子图里有没有 conclusion 块」推导出来**，也不能靠关键词猜（`CONTEXT.md` 术语「失败标记」的 `_Avoid_` 明写这三条）。要加一条测试把这个钉住：一个含 conclusion 块、但没有显式标记的子图，校验通过且**不算**失败子图（`failure` 侧判 false 的访问器／属性要能被断言）。
6. **不做进行中提取**（决策 #110／#111／#112）：这一波**不要**新增任何「任务运行中提取子图」的入口，**不要**新增 Memory Agent 面向的子图提取工具，**不要**为子图去读实时 AO 台账。子图只由 commit 之后的提取写入。若发现代码里已有任何进行中提取的钩子，报告，不要动。
7. **确定性 fallback 视图不写子图**：`build_minimal_fallback_view`（以及 `_with_diagnosis_root_sink` 造的合成 root／sink 块）不是提取模型划的，子图保持空。fallback 视图本来就不许晋升（ADR #72），别顺手给它造一个切分器。

## 测试

在 `tests/test_influence_view.py` 加（或新建 `tests/test_retrieval_subgraphs.py`，你选一致的做法）：

- `to_dict`／`from_dict` 往返，含失败标记与证据。
- `content_hash`：加／改子图后 hash 变；同样的子图重复算 hash 相同。
- 上一条里 5 类 violation 每类至少一条断言（合法输入不报、非法输入报对应 code）。
- 含 conclusion 块但无显式标记 → 不算失败子图（见上）。
- 序列化结果里不出现 `subtask_id`（以及任何 `subtask` 字样）——一条简单的字符串断言。

## 交付要求

- 只改 OpenViking；不顺手重构无关代码；不跨波做 R4 的事（不做子图对子图的相似、不做 3 份帽、不写 fork）。
- 跑：`uv run pytest tests/test_influence_view.py tests/test_influence_projection.py tests/test_retrieval_facade.py tests/test_causal_experiences.py tests/test_trajectory_index.py -q -o addopts=''`。已知基线 3 个失败（`test_influence_projection.py::test_acl_change_without_revalidation_callback_warns_once`、`test_trajectory_index.py::test_missing_projection_registry_warns_once_and_still_indexes`、`test_trajectory_index.py::test_supersede_without_revalidation_callback_warns_once`），不改、如实报告。
- 提交到 `feat/causal-subgraph-retrieval`，`feat(session): ...` 风格，不要 push。
- 回复报：新 commit 短哈希；新类型名与字段清单；`content_hash` 改在哪、旧数据是否受影响；新增的 violation code 清单；测试条数与结果；以及**任何让你觉得两处设计对不上、你只能自己选一处**的地方（例如「含 conclusion 块」与「显式标记」的关系），明确写出来让我去设计对话里确认，不要自己下结论。
