任务：实现已验证相似边（verified_similarity_edge）与中心式跨树簇（causal_experience_cluster）（切片 S6/6）。

工作目录：/home/zhoujie22/river2_0/OpenViking（已 cd，git 分支 feat/fork-node-foundation；S1-S5b 已提交）

背景（必读）：
1. /home/zhoujie22/river2_0/skill-node-design-grill/round-07-questions.md 的 Q39/Q40/Q41 原文（判定字段、中心式簇规则、受控写入协议）——这是本切片的规格书
2. /home/zhoujie22/river2_0/skill-node-design-grill/docs/adr/0007-verified-similarity-edges-and-clusters.md
3. openviking/session/causal_experiences.py —— 既有 CausalExperiencesStore（fork 存储、causal 模式闸门、幂等模式，参考它的写法保持一致）

实现要求（新文件 openviking/session/causal_clusters.py）：

1. **SimilarityJudgment（dataclass）**：judged_by_model_version、prompt_policy_version、criteria_per_dimension（dict，四维键固定：task_decision_type、anchor_state、failure_mode、action_skill_role）、verdict（Literal: consistent | analogous | insufficient | dissimilar）、confidence（float 0-1）、rationale（str）、evidence_revision_hashes（list[str]）、judged_at、diagnosis_run_id。校验：verdict 四值、confidence 范围、四维键齐全。

2. **VerifiedSimilarityEdge（不可变 dataclass）**：edge_id（uuid）、endpoint_a（{fork_node_id, revision_id}）、endpoint_b（同构）、judgment（SimilarityJudgment）、direction（Literal "undirected"——语义相似为无向；使用时可另记有向引用，本切片只存无向）、created_at、content_hash（canonical json sha256，含 judgment）。endpoint 规范化：字典序排序保证 (a,b) 与 (b,a) 同键。

3. **CausalCluster（不可变 dataclass）**：cluster_id（uuid，首条正向边提交时铸造、永不重算）、center_fork_node_id、member_fork_node_ids（list，含 center）、status（active | superseded | split_closed）、supersedes_cluster_ids（list[str]，默认空）、split_from_cluster_id（str|None）、created_at、closed_at（str|None）。

4. **CausalClusterStore**（目录：与 fork 存储并列 `<root>/causal-experiences/edges/<edge_id>.json`、`<root>/causal-experiences/clusters/<cluster_id>.json`、追加 `edges-index.jsonl` / `clusters-index.jsonl`、幂等复用 .idempotency 模式）：
   - `submit_similarity_edge(payload: dict, *, idempotency_key: str) -> dict`（Q41 服务端校验最小版）：
     a. causal 模式闸门（同 S5 模式，legacy 抛 PermissionError）；
     b. 解析校验 payload → VerifiedSimilarityEdge；
     c. **仅 verdict ∈ {consistent, analogous} 视为正向边**；insufficient/dissimilar 一律持久化为**负样本记录**（存 edges/ 但带 negative: true 标记、不进簇、不可被簇查询召回），幂等逻辑同样适用；
     d. endpoint 去重：canonical pair 已有**正向**边时，同 judgment_hash → deduplicated；不同 judgment → 新 edge revision（edge_id 不同、append，不覆写）；
     e. 幂等键 = sha256(idempotency_key)，内容指纹 = payload hash（同 S5 模式）。
   - `propose_cluster_change(...)`（最小版，只做两件事）：
     - `create_cluster(center_fork_node_id, member_fork_node_ids, initiating_edge_id) -> CausalCluster`：**服务端强制校验**每个 member 与 center 之间必须存在至少一条正向边（查 edges-index），否则 ValueError；cluster_id 铸造并落盘。
     - `add_member(cluster_id, member_fork_node_id, initiating_edge_id)`：校验该 member 与 center 有正向边；校验 cluster status==active；生成**新版本 cluster JSON**（同 cluster_id，version+1，members 追加；历史版本文件保留为 `<cluster_id>.v<N>.json` 或 revisions/ 子目录，选一种并报告）。
   - `merge_clusters(cluster_ids, ...) / split_cluster(...)`：v1 只实现**语义占位**——创建带 supersedes_cluster_ids / split_from_cluster_id 的 successor cluster（active），旧簇 status 置 superseded/split_closed（新版本文件，不改旧文件内容）；成员校验可放宽为"并入成员在任一前驱簇中"。若实现成本高，允许 merge/split 只留接口 + NotImplementedError，报告说明（后续切片补）。
   - 查询：`get_cluster(cluster_id)`（最新版本 + 历史版本列表）、`clusters_for_fork(fork_node_id)`（该 fork 属于哪些 active 簇）、`edges_between(fork_a, fork_b)`。

5. **测试**（tests/test_causal_clusters.py）：
   1. 判定校验：缺一维/非法 verdict/confidence 越界 → ValueError。
   2. 正向边：consistent 与 analogous 都建边；dissimilar/insufficient 存为 negative 标记、不进 edges 正向索引、不参与簇校验。
   3. endpoint 规范化：(A,B) 与 (B,A) 提交 → 同一 canonical pair，第二次同 judgment deduplicated，不同 judgment 生成第二条 edge。
   4. create_cluster：member 与 center 无正向边 → ValueError；有 → 落盘且 clusters_for_fork 命中。
   5. add_member：无正向边拒绝；成功后 get_cluster 成员更新且历史版本保留。
   6. 幂等：同 key 重放 deduplicated；同 key 异内容 ValueError。
   7. legacy 模式 submit 抛 PermissionError。
   8. merge（若实现）：旧簇 superseded、新簇带 supersedes 列表。

约束：SPDX 头；无新依赖；不修改任何现有文件；import 限 stdlib + openviking.session.ao_ledger* + memory_config + causal_experiences 里可复用的工具函数（如 canonical json/hash helper——若它们是私有下划线函数，可以在 causal_experiences.py 中**导出一个公开 helper**（允许对该文件做 ≤10 行的追加修改，报告说明）或复制实现（注明来源），二选一。

验收标准（结尾逐条报告）：
1. `python3 -m pytest tests/test_causal_clusters.py tests/test_causal_experiences.py -q` 全绿。
2. `git status --short` 变更清单（若动了 causal_experiences.py 说明追加内容）。
3. 报告：目录布局、cluster 版本化方案选择、merge/split 实现程度。
