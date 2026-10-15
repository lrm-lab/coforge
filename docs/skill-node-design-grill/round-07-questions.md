# Round 7（griller: kiro / gpt-5.6-sol，经中间人转达）——三项增补设计的收口

设计树状态：Round 6 的 AO 台账、按需 fork node、Q26 propose 写入、七步 replay、proposal→evaluator→Evolution 链路均继续成立；本轮只为三项增补设计补齐编排、可审计相似性与跨树簇协议。

❓ **Q37** - **评估编排是否以"fork node 权威提交成功"为唯一触发点，并固定失败分流？**
确认端到端顺序：①agent 经 Q26 propose 提交，服务端验证（schema/ACL/锚点/证据/配额）并**原子提交权威 fork node revision**后才发出 evaluation_orchestration_requested——触发点是服务端权威提交，不是 agent 提议；②编排第一步始终由 daemon 执行七步 replay 判定，evaluator 不参与不重做；③eligible → 配对 replay；ineligible → 持久化 ineligible job + structured guidance append；④replay 结果/归因报告成为 proposal 证据输入 → evaluator 审批 → Evolution 发布；⑤同一 revision 的重复编排以 fork_node_id + revision_id + orchestration_policy_version 幂等，新 revision 才触发新编排。

➡️ 推荐答案：确认。

---

❓ **Q38** - **全 agent 驱动的候选提议如何设预算，未成 fork 的候选留下什么？**
一次确定：单次 diagnosis_run 最多几个候选（anchor / session-state / interaction-edge）？每候选几份草稿？草稿是否浅层（锚点 + 目标/状态/失败摘要 + 少量 evidence refs + 选点理由，**不生成完整七段**）？升级门槛（agent 给出可审计理由即可提议 fork，跨树相似案例是增强证据而非前置条件）？被否决/检索无果/验证失败的候选——丢弃还是留为不可检索的 diagnosis-run provenance？

➡️ 推荐答案：每次 run ≤5 候选、每候选 1 份浅层草稿；未成 fork 的候选**不得伪造 fork revision**，但写入受 ACL 保护、不可检索的 diagnosis-run provenance（锚点、草稿 hash、处置原因、预算消耗）。

---

❓ **Q39** - **草稿、检索与语义判断的审计记录存哪，相似/不相似如何判定？**
确认：①成功 revision 的不可变 provenance = 草稿 context + 检索器/embedding/index 版本与查询快照 + 候选排序分数 + 实际查看的候选 + 每个相似性判断及理由；②未成 fork 候选存 diagnosis-run provenance；③语义判断逐维：任务/目标与决策类型、锚点时状态/约束/环境、失败模式/因果机制、行动路线与 skill **角色**（skill URI 相同非充分条件，不同 skill 也不自动否定）；④每条判断记录 judged_by 模型版本、prompt/policy 版本、逐维 criteria、verdict（consistent / analogous / insufficient / dissimilar）、confidence、理由、证据 revision/hash、时间、diagnosis_run_id；⑤dissimilar 候选作为负样本仅用于离线检索改进，不进运行时召回/簇连接/效用正证据。

➡️ 推荐答案：确认。保存范围以"agent 实际评估过的有界候选集"为准，不复制整个索引语料；相似性至少要求目标/决策情境与状态或因果结果实质对应，skill 只作辅助维度。

---

❓ **Q40** - **跨树簇是"中心式、可重叠的已验证关系视图"，而非连通分量？**
相似性非传递（A~B、B~C ⇏ A~C）。确认：①新对象 causal_experience_cluster：cluster_id、center_fork_node_id、成员 fork_node_id[]、成员依据 revision refs；相似性 edge 为独立一等对象 verified_similarity_edge[]；②每条 edge 连接两个具体 fork-node revision，带 Q39 判定 provenance，规范化 endpoint pair 去重；③**中心式规则**：成员必须与 center 有已验证正向 edge；A~B、B~C 不自动令 A、C 同簇；一个 fork node 可属多个簇；④首条正向 edge 提交时以指定 center 铸造稳定随机 cluster_id，永不因成员变动重算；⑤不原地 merge/split：合并创建带 supersedes_cluster_ids[] 的 successor，拆分创建带 split_from_cluster_id 的 successors，旧簇关闭为只读历史视图。

➡️ 推荐答案：选择中心式可重叠簇；edge 是权威关系事实，cluster 只是对已验证边的稳定组织视图；禁止连通分量自动扩张。

---

❓ **Q41** - **cluster、edge 与成员变更是否完全复用 Q26 的 propose→验证→原子提交？**
确认：①agent 只可提 SimilarityEdgePropose 与 ClusterChangePropose（引用双方 fork revision、检索快照、judgment provenance 齐全）；②服务端验证双方存在、ACL 与 workspace 范围、schema、正向判定、endpoint 去重、center/member 规则、配额、内容 hash；③edge + 受影响 cluster membership/successor 关系 + provenance 单事务原子落库，随后才发检索与统计 outbox；④幂等键 = diagnosis_run_id + canonical_endpoint_pair + judgment_hash；同 pair 新判断 = 新 immutable edge revision，不覆写；⑤不能同时读双方证据的 agent 不得建跨树连接；cluster ID 不给任何调用方隐式扩张 session ACL。

➡️ 推荐答案：确认。cluster 维护是 Q26 受控写入模型的直接延伸。

---

❓ **Q42** - **Q7 统计与 ADR-0001 晋升是否升级为"簇条件效用 + 已验证分支模式"？**
确认：①已验证 cluster membership 与 edge 成为统计分桶/适用性证据；共现降为辅助信号，不再直接触发 skill 合并；②utility 记录为 utility(cluster_id, branch_pattern / skill_revision, evidence_status)，优先同簇内真实正向证据；全局 utility 只是跨簇聚合视图，必须展示支持簇数、样本量与异质性，不压过簇条件结果；③proposal 生成条件 = 从已验证簇中提取反复出现的 branch/skill 使用模式 + 独立真实正向效用证据；想象分支最多提供候选假设，不能单独构成晋升依据；④evaluator 仍独占发布批准权，cluster/aggregator 不自动 merge 不自动发布。

➡️ 推荐答案：确认。把"已批准节点簇"精化为"已验证簇中带独立正向效用证据的分支模式"；全局分数只供探索。

---

❓ **Q43** - **draft context 直查 branch 与路径展开 API 的最小契约、排序和上限？**
确认：①draft_context 可直接检索已存 branch 的 context_for_retrieval（不必先命中 fork node），返回轻量候选后由 agent 按 Q39 语义验证；②新增有界 expand_branches / walk_path：输入 branch refs、固定 watermark、方向、max_hops、max_paths、每路径实体上限、include 字段；返回 node-branch 链、结果/效用摘要、provenance refs、redacted 断点；③逐跳 ACL，无权内容截断/脱敏；④排序层级：真实且正向效用 > 真实未记录 > 已验证想象 >（未验证想象——见下）；同层按簇条件 utility；top-k 强制多样化（不同 cluster、不同 source session、不同 skill revision）；⑤预算：每次诊断 ≤12 个轻量 branch 候选、≤3 条参照 path、每条 ≤2 hops / ≤12 实体；replay 候选 skill 只可来自"语义验证通过的相似 context 中真实且有正向效用的 branch 所用 skill revision"，仍受 ≤3 revision 限制；⑥维持既定规则：**未验证想象分支不进跨树持久索引**、不作参照 path 或 replay skill 来源——跨树排序实际只有前三层，未验证想象仅可在当前 run 内作临时反事实草稿。

➡️ 推荐答案：确认 API 与预算；维持"未验证想象不进跨树检索"。

---

## 总账增量

| # | 决策 | 落点 |
|---|---|---|
| 27 | 评估编排 | fork revision 权威提交后触发；daemon 先 replay 判定，ineligible 转 guidance，evaluator 仅审批 proposal。 |
| 28 | Agent 驱动候选 | 每 run ≤5 候选；浅层草稿；未成 fork 留 diagnosis-run provenance。 |
| 29 | 相似性审计 | 草稿、检索快照、判断与正负样本有界持久化；embedding 仅召回，不代替语义裁决。 |
| 30 | 跨树簇 | 中心式、可重叠 cluster + 已验证 edge；相似性不传递；merge/split 创建 successor。 |
| 31 | 簇维护 | 完全走 Q26 propose→服务端验证→原子提交→outbox。 |
| 32 | 统计与晋升 | 簇条件效用；已验证簇内正向 branch 模式生成 proposal；evaluator/Evolution 仍独占发布。 |
| 33 | 路径参照 | draft 可直查 branch；有界 ACL walk_path；真实正向 branch 才可供 replay skill 候选。 |
