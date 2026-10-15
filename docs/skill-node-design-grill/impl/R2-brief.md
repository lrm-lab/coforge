# R2 brief：fork／branch 卡片带七段与分支动作摘要；展开工具按 claim 投影卡片 id 取参

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（已有 `988148ad8`、`12f783d19`）。**追加新提交，不要 rebase／amend 已有提交；不要 push。不要动 `benchmark/`。**

设计依据：

- `skill-node-design-grill/CONSENSUS.md` 叙述 104（诊断子图命中里的 fork 带七段与分支摘要）、105（进行中混合检索的 fork 卡片带七段与分支摘要）、决策表 #113、#114、#98；叙述 11／17（branch 检索入口 = 父状态摘要 + 动作序列 + 结果/失败模式 + guidance 摘要）。
- `CONTEXT.md` 的「邻域展开」。
- `round-13-answers.md`：Q144-B、Q133-B、Q131-A。

主文件：`openviking/session/retrieval_facade.py`（19→27 个测试在 `tests/test_retrieval_facade.py`）。

## 任务 1：fork／branch 卡片带正文（#113／#114）

今天 `RetrievalCard` 没有任何文本字段，fork 卡片只有 `fork_node_id` + `revision_id`（`payload_ref = fork:<id>@<rev>`），branch 卡片多 `branch_id`、`evidence_status`。要改的是：

- 给卡片信封加一个承载正文的字段（例如 `text` / `retrieval_text`，形状你定，但要能序列化进 `to_dict`／`from_dict` 且进 content 比较）。
- **fork 卡片**：带七段快照，取自 `ForkNodeRevision.seven_sections`（`SEVEN_SECTION_KEYS`：`session_title`、`current_state`、`task_and_goals`、`key_facts_and_decisions`、`files_and_context`、`errors_and_corrections`、`open_issues`）。
- **branch 卡片**：带该分支的**动作摘要**。注意：分支记录（`branches[]` 那几个 dict）今天只有 `branch_id`、`ao_sequence`、`guidance`、`evidence_status` 这类字段，**没有现成的动作摘要文本**。优先做法：用 `ao_sequence` 去 AO 台账取 synopsis，拼一个**确定性、长度有界**的短述（例如按序拼前 N 条 synopsis）。若该分支的 AO 在台账里取不到，退回写 `branch_id` + `evidence_status`，并在回复里说明。**如果你判断必须改 schema 才能做，先不要改，报告出来。**
- **不带**：guidance 全文、原始 AO 原文。claim/block 投影卡片保持今天的轻量形状（摘要 + 卡片 id + 状态 + 来源指针）。
- 排序用不用这段正文你定（今天 fork/branch 的排序 blob 可以不变），但要求：卡片上带得到，且 `score_breakdown` 的解释性不变。
- 测试：fork 卡片带七段、branch 卡片带动作摘要；guidance 全文与 AO 原文**不在**卡片上（用 `in` 断言反例）；投影卡片形状不变。

## 任务 2：展开工具按 claim 投影卡片 id 取参（#98 / Q131-A）

现在的公开面是 `expand_claim_neighborhood(view_revision_id, claim_id, max_entities=12)`——要求调用方知道内部 id。设计定的调用面是**只给卡片 id**：

- 公开一个按卡片 id 的入口（例如 `expand_claim_neighborhood(card_id="claim-card-17")`），服务端自己解析出这张卡片所属的冻结 view revision 与 claim id，再走今天那条路（只走 influence、skip 不进邻接、双向、12 个 block 上限、预算检查、不落对象）。
- 现有 `(view_revision_id, claim_id)` 形式保留为内部／兼容方法（现有测试在用），不要删。
- 卡片 id 未知，或那张卡片不是 **claim 投影**（是 block 投影、fork、branch 等）→ 明确报错，不要猜、不要退化。
- 注释里写清：这个入口只给 Memory Agent 用（诊断 agent 不用它是 agent 侧围栏的事，OpenViking 这边只提供入口）。
- 测试：用预召回返回的 claim 投影卡片 id 直接展开成功；未知卡片 id 报错；非 claim 卡片报错；skip 过滤仍生效（含"种子是 skip"那种）。
- 顺带确认：解析卡片 id 需要的那张表（`ProjectionRegistry` 之类）今天是否已能从卡片 id 反查 view revision + claim id；若没有，加一个最小的反查，并在回复里点明加在了哪里。

## 边界（本轮不做）

检索子图与失败标记（#101／#108）、诊断子图检索（#102／#103／#104／#106／#107）、`TrajectoryIndexService` 挂 session commit（#110／#111）、coforge 侧工具围栏。不要顺手做。

## 交付要求

- 只改 OpenViking；不加新依赖；风格与既有文件一致；不顺手重构无关代码。
- 跑：`uv run pytest tests/test_retrieval_facade.py tests/test_influence_projection.py tests/test_causal_experiences.py -q -o addopts=''`。已知基线有 3 个失败（`test_influence_projection.py::test_acl_change_without_revalidation_callback_warns_once`、`test_trajectory_index.py::test_missing_projection_registry_warns_once_and_still_indexes`、`test_trajectory_index.py::test_supersede_without_revalidation_callback_warns_once`），不要修，如实报告。
- 提交到 `feat/causal-subgraph-retrieval`，`feat(session): ...` 风格，不要 push。
- 回复报：新 commit 短哈希、改了哪些文件、卡片新字段的形状与一个例子、branch 动作摘要的来源（台账拼接还是退回写法）、卡片 id 反查加在哪、测试结果。
