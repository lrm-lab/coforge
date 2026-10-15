# Round 10 答复（已完成，frontier 清空）

Round 10 全部 Q109–Q125（含 Q116 追问 Q118–Q120）已答复；ADR 0010–0013 已立，CONSENSUS/CONTEXT 已同步。

- **Q116：B。**非评测（普通任务）中，Memory Agent 作为群聊成员对频道每条消息自主检索并择机投递，不要求显式 @memory 触发。该选择打开三个新分支：自主检索的成本门槛（Q118）、投递节流与打扰控制（Q119）、普通任务的预算与权限归属（Q120）。
- **Q109：A。**post_run_index 视图采用有界目的性覆盖：以"task 目标 + observed outcome"为组织 query，带 coverage_manifest，沿用 Q97 结构约束。
- **Q110：A。**独立服务端异步索引服务：workspace 预算与速率上限，优先级 evaluation > 失败轨迹 > 成功轨迹，超限降级 fallback 或明确无 projection，supersede 旧 projection 退出索引，workspace 可暂停。
- **Q112：A。**分层配额：Interaction lane 独立预算不占 12；causal-memory lane 内 12 为查询级总帽，默认 Fork/Branch 6、Block/Claim projection 4、Segment/Atom 2，profile 可调总帽不变；8-4 通道切分只对有状态语义对象生效。
- **Q113：A。**投影通道跟随 grounding 状态：被 validated ForkRevision grounding 的 block/claim projection 可进 verified 通道并带 provenance；其余保持 provisional。与 Q122-A 的 M4' 记账隔离互补。
- **Q114：A。**projection 继承来源安全标签；ACL 变更经 outbox 触发再投影/撤下，引用它的 Fork grounding 标 needs_revalidation；redacted 节点仍是路径断点。
- **Q115：A。**层级规则确认：评测迭代内统一并发 5；独立诊断 run 沿用 ≤3；dossier 增量规则不变；CONSENSUS 第一节第 22 条补注。
- **Q117：A。**立四个 ADR：0010 Influence View 层与 post-run 索引（含 Q121 的 M1–M4' 与定位重述）；0011 Hypothesis/EvidenceBridge 分型与假设图治理；0012 ForkRevision 三阶段生命周期与评测循环；0013 Memory 消费侧记账与 ACL-safe 聚合。
- **Q118：B。**每条消息都跑完整三段式检索（服务端预召回 + 主 Memory LLM explore），不设前置相关性过滤器，由 Memory Agent 自己判断何时停止。设计者明知成本取舍而选此项；既有刹车仅剩 retrieval profile 的停止条件与 Q119 投递节流，若活跃频道成本失控再议。
- **Q119：A。**投递治理：同一 task lineage 对同一 target agent 未决 Hint 上限默认 2、冷却窗口、同 provenance 去重；target agent 可声明偏好；超时只记 exposure。
- **Q120：B。**普通任务中 Memory 检索不设 workspace 父级预算上限，每次触发消耗由模型停止判断与 profile 约束，不因预算耗尽中断（与 Q118=B 配套：检索侧完全自主，投递侧由 Q119-A 节流）。
- **Q121：A。**不合并 L2/L3，走中间路线 M1（检索/投影接口统一）+ M2（grounding 冻结快照 + needs_revalidation 联动）+ M3（post_run 视图定位为派生轨迹索引，写入 ADR-0010）+ M4'（投影引用账隔离）。
- **Q122：A。**不铸造 subtask_id；检索查询支持"子目标 + 依赖模式"（匹配 Claim 的 carried_artifact/downstream_effect 签名）打现有 Block/Claim projection；命中后在同一冻结视图内沿 Claim 做有界邻域展开，"子任务因果链"是读时拼装不落成对象；投影命中只记索引级 exposure（M4'）。
- **Q123：A。**不把分支写入影响图；对已是 influence_grounding 目标的 block|edge|cut 建反向索引（倒排表，outbox 维护），READ_VERIFY 可读对应 Fork/Branch 摘要与验证状态、标"干预史"，不改变 Claim 状态、不进 citation/utility；supersede/ACL 变化走 needs_revalidation。
- **Q124：A。**跨任务泛化维持记在已验证相似边 + 簇条件 branch_pattern 效用上；影响图节点不挂其他任务的分支；诊断需要时经 Q123 反向索引只读联结。
- **Q125：A（可分期）。**Block 不加失败原因字段、不造 cause_set；仅对过六门槛且 diff 含 ≥2 处可分离改动的高价值分支，在同一 ControlContract 下做 ≤2 个预声明子集的配对 replay，记为该 branch 的 supporting evidence（subset_sufficient/not_sufficient）。允许先按 C 落地（整支充分性 + partial_match），实验显示"缺一不可"误判成瓶颈时再启用子集 replay。
- **Q111：A。**post_run 视图按 session/task run 演化：后续 commit 的构建产生 superseding InfluenceViewRevision，旧 revision 保留为历史证据（诊断可引用）但 projection 退出检索；兼顾中途崩溃的 session 至少留有最后一次 commit 的索引。
