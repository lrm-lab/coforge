# 跨树相似性用已验证边连接，簇为中心式可重叠视图，效用与晋升以簇为条件

诊断 agent 需要参照其他轨迹树上的相似路径，但 embedding 余弦不可信、且相似性不具传递性（A~B、B~C 不保证 A~C）。决定：相似性关系是一等对象 verified_similarity_edge——连接两个具体 fork-node revision，带四维判定 provenance（任务/决策类型、锚点时状态、失败模式、行动与 skill 角色）与四值 verdict，由 agent 提议、服务端按 Q26 模式验证后原子提交；跨树簇 causal_experience_cluster 采用中心式可重叠规则（成员必须与 center 有已验证正向边），合并/拆分只创建 successor 簇，禁止连通分量自动扩张。统计随之升级：utility 以 (cluster_id, branch_pattern / skill_revision, evidence_status) 记录——这正是原始需求"skill 对不同 context 的效用统计"的可计算形态；proposal 的生成条件仍为已验证簇内反复出现、带独立真实正向效用的分支模式。Q11-C 移除独立 Evaluator 尾门；后续 Q13-C/ADR-0022 决定合规 proposal 经服务端完整性校验后自动进入 Agent Evolution，并原子产生 `published_active_skill_revision`。active 只表示在线资格，不预判效用或排名。

## Consequences

- embedding 只做召回，语义裁决必须由 agent 逐维判定并留痕；dissimilar 判定作负样本仅用于离线检索改进，不进运行时召回。
- 候选提议每 run ≤5、浅层草稿；跨树相似案例是 fork 升级的增强证据而非前置条件——这同时解了"选点需要检索、检索需要 context"的鸡生蛋问题（冷启动不需要检索）。
