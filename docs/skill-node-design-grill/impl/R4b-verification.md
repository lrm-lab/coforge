# R4b 验证记录（ZCode 独立复跑）

提交：`ef21efb8c`（`feat(session): write one ordinary fork for each failure subgraph`）、`32218e516`（`fix(session): reject invisible query sessions and ambiguous revision ids`）。未 push。

## 我复跑的结果

`uv run pytest tests/test_subgraph_forks.py tests/test_subgraph_retrieval.py tests/test_fork_revision_lifecycle.py tests/test_causal_experiences.py tests/test_influence_view.py tests/test_retrieval_facade.py tests/test_influence_projection.py tests/test_trajectory_index.py -q -o addopts=''`
→ **128 passed / 3 failed**，3 条与基线一致。`tests/test_subgraph_forks.py` 新增 12 条。

## 逐条核对（读代码）

- 新模块 `openviking/session/subgraph_forks.py`（356 行，诊断侧，未挂 Memory 工具面）：`failure_subgraphs_owed_forks`（按元组序只留 `is_failure`）、`default_failure_grounding_position`、`write_failure_subgraph_fork`（单子图、单份 fork，无批量）。
- 落盘走 `submit_fork_draft` → `persist_provisional_draft` → `upsert_fork_node`（`causal_experiences.py:1684` 新增，与 `commit_provisional` 同一段写盘，差别只在**不跑 `ServerChecks`**、幂等键由调用方给）。状态是 `provisional`。
- 拒绝路径齐备：未打标记、不在该修订上、id 不唯一 → `ValueError`；`failure_evidence_refs` 为空 → 不造锚点；接地位置不在子图内、`cut`、缺冒号 → 拒绝；`seven_sections` 缺键 → 拒绝。
- 确定性做得好：`content_hash` 用冻结修订的，`grounded_at`／`created_at` 用该修订的 `frozen_at`——作者的理由是墙上时钟会让同一次重放变成幂等冲突，这个判断我认同。
- 幂等键 = `{op, view_revision_id, subgraph_id}`。这个自定义键是**必要**的：`_provisional_idempotency_key`（`:1239`）只含 `diagnosis_run_id + anchor + content_hash`，而 provisional 的 `content_hash` 是空串；两份子图若共享同一个失败 AO，就会同键不同 payload 直接冲突。所以不能简单改成调 `commit_provisional`。
- 第 7 条（查询侧 ACL）已落：`querying session ... has no ACL labels` / `... is not visible to the principal` 两种都拒绝，不返回空。
- 第 8 条已落：`_revision` 拆成 `is not in the supersede index`（0 个）与 `is not unique in the supersede index`（≥2 个），仍 fail closed。

## 我亲手跑的行为探针（`/tmp/probes/exp_r4b_acl.py`）

**跨 workspace 写入确认成立。** 源 session 是 `hist-sess`（ACL 映射到 `team-a`），我让写入的 `workspace_id="team-foreign"`：

| 结果 | 值 |
|---|---|
| fork 写入结果 | `provisional`，`workspace_id = team-foreign`，锚点的源 session 仍是 `hist-sess` |
| 干预索引记录 | `security_labels: ['team-foreign']` |
| 诊断命中里 principal `team-a` 看到的接地 fork | **0 份**（自己团队的失败，自己看不到） |
| 诊断命中里 principal `team-foreign` 看到的接地 fork | **1 份**（外来团队看得到） |

原因链：`persist_provisional_draft` 跳过 `ServerChecks`（`anchor_exists`／`refs_exist`／`provenance_valid`／`acl_allowed`／`acl_hook`），而 `workflow_id` 完全由调用方给；`_index_intervention`（`:1868`）把它原样记成 `security_labels`，而干预历史的 ACL 判断（`:1784`）正是拿 `security_labels` 与 principal 求交。生产上 `commit_provisional` 是被 `evaluation_loop.py:352` 真实调用的，也就是说**另一条 fork 写路径带 ACL 门，这条不带**。

我没自行改这一处：怎么补有三种形状（要求调用方按 `ServerChecks` 形态给证明／在写入侧拿 `session_acl(revision.session_id)` 校验 `workspace_id` 相交／保持信任调用方并只写文档），它们的信任模型与签名都不一样，属于设计决定。**我的建议是第一种**（沿用 `commit_provisional` 已有的证明形态，把「谁证明 ACL 通过」留在调用方），因为它是这个仓库已有的模式，且不需要把 ACL 回调注入一个新的写模块。

## 另一处边界情况（不是缺陷，设计未写）

两份失败子图若 `failure_evidence_refs[0]` 指向同一个 AO，锚点身份相同，就会落到**同一个 fork 节点**上、成为该节点的两条 revision，而不是两个 fork 节点。这是既有「同锚点复用 fork 节点」规则的结果，作者明确写出来、没有另造身份。设计 #106 说「各写一份普通 fork」，没说这种情况算一份还是两份。列进待确认。
