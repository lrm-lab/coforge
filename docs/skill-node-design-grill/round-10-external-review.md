# Round 10 外部评审存档：L2/L3 合并与否

背景：设计者质疑 L2（Influence View）与 L3（Fork 因果记忆）分层是否过度设计，要求与 cursor CLI 讨论后给利弊分析。评审进行了两轮：第一轮 cursor-agent 登录态失效（authInfo 仅存账号资料、无 token），改派 ZCode 独立子 agent（全新上下文、不携带主 agent 预判）完成评审（见下文）；随后设计者提供 API key，cursor CLI（默认模型 grok-4.7）对同一题目独立完成评审，原文见 [round-10-cursor-raw.md](./round-10-cursor-raw.md)。**两轮评审裁决一致：不合并对象模型，走中间路线。**

## cursor CLI 评审与子 agent 评审的差异点

- 完全收敛：五面承重墙（身份粒度 / 信任三层 / ACL 可见性 / 生命周期频率 / 检索特征）、中间路线 M1（接口统一）/ M2（grounding 快照）/ M3（索引定位重述）、最终裁决。
- cursor 独有贡献（子 agent 与主 agent 均未覆盖）：**M4'——影响投影的引用账隔离**。投影命中进入 provisional 检索结果后，任务侧可能对其形成 exposure 甚至结构化 citation；若不划界，索引命中会沿"被看见→被引用→排名上升"回流进 fork_node_id 聚合与 citation/utility 账本（制造 Q66 曾防的自证循环的索引版）。做法：投影命中只记**索引级 exposure**（仅供离线召回质量评估）；只有经过 grounding、成为 ForkRevision 或 Memory Hint 来源之后，才允许进入 in-task/cross-task reference strength 与 outcome utility。已并入 Q121-A。
- 两轮评审均指出 CONSENSUS.md 叙述条目（1–71）与决策总账表（#1–#80）编号错位（如叙述#61=总账#68=Influence View 层），引用时需双标。

## 第二轮：设计者四论点评审（cursor，原文见 round-10-cursor-raw-2.md）

设计者提出子任务级检索、future path 并图、跨任务边改分支泛化、多根因干预语义四论点。cursor 裁决与主 agent 交叉核对一致：**四个论点的共同事实偏差是把 AIG 的一次性导航图当成长期因果记忆候选载体**（论文无多层记忆、图用完即弃、失败语义在边不在节点）。逐点裁决：①改造后采纳（子目标+依赖模式查询现有 projection，读时 Claim 邻域展开，拒绝 subtask_id → Q122-A）；②拒绝合并、采纳反向索引（grounding 目标位置 → Fork/Branch 干预史，READ_VERIFY 可见 → Q123-A）；③拒绝（泛化已由簇+簇条件效用表达，图内多分支会走私相似性传递 → Q124-A）；④拒绝节点根因字段与 cause_set，采纳有界子集配对 replay 作为 supporting evidence（→ Q125-A，可先按 C 分期落地）。


---

**引用约定**：CONSENSUS.md 存在两套编号——第一节叙述条目 1–71、第二节决策总账表 #1–#80，二者错位（如叙述#61 = 总账#68 = Influence View 层）。为免歧义，下文引用统一写作 `总账#N（叙述#M，对应 Qxx）`，关键短语均为原文摘录。

## 一、合并方案的 steelman：合并真正能简化什么

**S1. 状态机与校验管道数量的压缩（实质与表面混合）**
现状有两套生命周期：L2 的 `InfluenceViewDraft → 最多 3 轮 critic/refiner → 冻结 InfluenceViewRevision`（含 fallback、coverage_manifest、projection 通道晋升/撤下），L3 的 `ForkDraft → provisional → validated|invalidated`。合并后一条 draft→frozen→validated 流水线，服务端迁移校验器、审计日志种类、幂等键设计各少一套——这部分是**实质**简化。但对象字段集是两层的并集（block 需要 granularity_reason、单一 participant 约束、coverage；fork 需要七段快照、canonical anchor、branch、guidance、utility 记账），schema 面积基本不降，只是从两个窄类型变成一个宽类型——**宽度本身就是复杂度**，这一半是表面收益。

**S2. grounding 间接引用的 join 成本消除（中等实质，但有更便宜的替代）**
现在消费一个 ForkRevision 要跨层解析 `influence_grounding → 冻结 view 的 block/edge/cut → AO refs`，且 grounding 指针会随 view 被 supersede（Round 10 Q111）而悬空。合并后 fork 直接持有影响结构，审计、检索解释、统计关联各少一跳。但注意总账#68（叙述#61）已规定 "**ForkNode ID 仍由 canonical anchor 派生**"，join 只发生在解释/证据路径；而总账#80（叙述#71）的 summary-first escalation（"`projection → Block/Claim summary → evidence synopsis → selected raw evidence` 渐进下钻"）保证热路径只碰轻量卡片。所以收益集中在离线审计与人读 ergonomics——**中等实质，且可用去规范化快照以十分之一代价获得**（见中间路线 2）。

**S3. 检索侧多 corpus 多配额多 ranker 的运维合并（运维实质、语义有损）**
现状是 Q112 提案的三 corpus 配额（Fork/Branch 6、Block/Claim projection 4、Segment/Atom 2）叠加 verified/provisional 8/4 通道（总账#55/叙述#46 "每次最多 12 个轻量候选，verified 8、provisional 4"）叠加 Q113 "通道跟随 grounding 状态" 规则——每次调 policy 版本、训 reranker、做配额实验都要同步多个旋钮。合并成一个 corpus 一个 ranker，索引管道、embedding 维护、实验矩阵确实少一个维度，**运维上是实质简化**。但 Q102（重定案）已经明确拒绝过这个方向（选项 B "每条轨迹生成 DIV，并只检索 DIV；取消 Fork/Branch 全局入口"），因为两者排序特征不同源（详见失败模式 5）。

**S4. 写入管道与基础设施复用（表面）**
view 构建管道与 fork 提交管道看似重复，但公共部分——outbox、幂等投影、服务端校验框架——按总账#10（"outbox 驱动幂等投影 + 轻量投影 + 双重 ACL；**写入源增加 fork-node 服务**"）和 Round 10 Q110-A（"独立服务端异步索引服务（**与 outbox/aggregator 同模式**）"）本来就是同一套基础设施的两次实例化。合并对象模型并不增加这层复用，不合并也不阻碍它。**设计者感到的"管道重复"来自 policy 实例化了两遍，不是对象模型冗余——表面**。

**S5. 术语与心智负担减半（表面，但正是"感觉冗余"的直接来源）**
L2 一侧的词汇：Influence View、DIV、post_run_index/failure_diagnosis、InfluenceBlock/Claim、influence_grounding、projection、coverage_manifest。合并后词汇表减半，onboarding 与文档维护成本真实下降。但 CONTEXT.md 的存在说明术语负担已被单独治理，且"少一层"的心智简化会换来"一个对象多重身份"的更差心智模型。**表面收益**。

## 二、合并的具体失败模式

**F1. 身份粒度错配：M:N grounding 压不进 1:1 对象身份（对照总账#68/叙述#61、总账#19/叙述#7、总账#13/叙述#16）**
三个粒度事实冲突：fork:anchor 是 1:1——总账#19（叙述#7）规定 "稳定身份 = {workspace_id, anchor_kind, canonical_anchor_key}；同锚点重复诊断**复用** fork_node_id、追加不可变 revision/branch，不覆写"；view:block 是**每轨迹 N 个**且随 commit supersede（Q111 "后续 commit 的 post_run build 产生 superseding InfluenceViewRevision"）；而 fork↔block 是 **M:N**——一个 fork 可被多条轨迹的视图 grounding，一张视图含多个候选锚点，grounding 目标甚至是 `block | edge | cut` 这种**位置**而非节点。合并后只有两条路：(a) 让 block/view ID 参与身份——fork 身份随视图 supersede 漂移，总账#13（叙述#16）的 "共现与效用由**异步 aggregator** 维护全局物化统计（**以 fork_node_id 聚合**，按 revision 区分结论）"、跨树簇成员资格、双维引用强度全部断链；(b) 保留 canonical anchor 身份——合并对象内部仍是两套 ID，"合并"名存实亡。CONTEXT.md 早已把两条路都列为反模式：Influence grounding 的 _Avoid_ 是 "**用 block/view ID 派生 ForkNode ID**"，InfluenceBlock 的 _Avoid_ 是 "**与稳定 ForkNode 身份等同；把所有 block 都当 fork**"。

**F2. 信任层级塌缩：导航级信任冒充证据级信任（对照总账#78/叙述#69/Q99、总账#54/叙述#44/Q77、总账#56/叙述#48/Q81、总账#60/叙述#52/Q85）**
Q99 的定案理由原文："它把 **schema validity、semantic plausibility 和 evidence verification 分成三层**，避免 critic 的'没发现错误'被当成因果证据"——InfluenceClaim 只在 Reader 逐项核验（"source 产生 carried_artifact、target 实际消费、downstream_effect 出现及 alternative source/反例"）后才 supported。Fork 侧是另一套更贵的标准：Q77（总账#54/叙述#44）明确 "**权威提交表示记录及来源被接受，不等于因果结论已验证**"；Q81（总账#56/叙述#48）的五项门槛外加 "**Citation 不改变验证状态**"；Q85（总账#60/叙述#52）要求冻结 ControlContract 的 "**独立对照**"。合并后一个 status 字段要同时表达"reader 核验过一条影响边"与"因果结论过了配对对照实验"——这正是 CONTEXT.md 里 Fork validation status 的 _Avoid_ "把'服务端已接纳记录'和'因果结论已验证'**混成一个状态**" 的加强版重演。论文数据本身就在警告：AIG + 单次 LLM reader（50.40%）**低于**固定 IG（52.00%），"单纯把自适应图 flatten 到一个 prompt，并不比固定 IG 更好"——视图级信任不经过主动遍历核验本就不值钱，更不能冒充验证级信任。fallback 的不对称是两套标准必须并存的直接证据：总账#72（叙述#65）规定 deterministic fallback "可参与 provisional projection 或供 Fork grounding，**但不能单独满足 validated 门槛**"。

**F3. ACL 可见性模型冲突（对照总账#79/叙述#70/Q103 重定案、总账#53/叙述#41）**
L2 的可见性矩阵是："Memory 全局 search **只返回** frozen InfluenceBlockProjection/InfluenceClaimProjection；同 task/evaluation 可按已知 ref 读完整 frozen selected blocks/claims，跨任务命中后须逐 ref ACL 与 evidence escalation；**draft、critic 私有状态和未冻结内容永远不可见**"。L3 投影则全局可发现、走双通道配额。合并对象只能选一个模型：选 fork 级可见性——诊断工作图的摘要全局暴露，制造 Round 10 Q114 已点名的侧信道（"若来源 session 事后收紧 ACL，**已全局可见的摘要构成侧信道**"），且 draft/critic 状态有泄漏面；选 view 级可见性——跨任务检索 verified fork 的核心 L3 能力被砍。Q103 定案理由直接命中："**避免把诊断工作图变成新的全局噪声语料库**"。

**F4. 生命周期频率差导致成本包络互染（对照总账#3、总账#68/叙述#61、总账#72、Q110）**
L3 是 "fork node **按需构造、天然稀疏、无上限**"（总账#3）；L2 post_run 是 "**每条** causal/evaluation 轨迹 commit 后**异步生成**"（总账#68/叙述#61）——Round 10 Q110 已在给这个频率踩刹车："每条 causal 轨迹都跑一次 LLM 构图（Builder/Critic/Refiner），**是持续的真金白银成本**"，方案是独立索引服务、优先级队列、超限降级。合并后每个 block 都要过 fork 级提交校验（叙述#8 的 "服务端验证（AO 存在、ACL、schema、synthetic 标记、配额）"、叙述#44 的 schema/anchor/ref/ACL/provenance/幂等五项）、进入曝光/引用账本、成为 aggregator 统计对象——稠密对象挤进稀疏权威层的全部昂贵机制。反向规避（让合并对象绕过 fork 级校验以省成本）则撞上 Q95 拒绝选项 C 的原文理由："**C 会把模型构造的可变归因结构混入权威事实图**"。两头堵。

**F5. 检索语义与排序特征损坏（对照总账#75/叙述#67、总账#59/叙述#51/Q84、Q102 重定案）**
总账#75（叙述#67）的原话就是反合并命题："**Influence View 提供密集 action/influence 召回，Fork 保留稳定 anchor、branch、guidance、utility 与验证状态，二者不互相替代**"。Q84（总账#59/叙述#51）的双 ranker 特征不同源：verified 侧 "以语义相关、evidence quality、**outcome utility**、新鲜度为主"，provisional 侧 "以语义相关、直接适用性、judgment 一致性和衰减后的 in-task/cross-task **reference strength** 为主"。block 没有 branch、guidance、utility、adoption——这些是 L3 专属字段。合并 ranker 要么抹掉这些特征（Round 9 整套 exposure/citation/adoption/outcome 评价账白建），要么 block 特征全零沉底（Q102 重定案的立论——基础视图 "**尤其覆盖尚未产生 fork 的成功轨迹和冷启动**"——落空）。配额上，合并等价于退回 Round 9 已明确拒绝的 Q79-C（"不设通道配额，合并后统一取 Top 12"）和 Q102-B。

**F6. `cut` grounding 与 Guidance 双重 grounding 的指涉对象丢失（对照总账#68/叙述#61、总账#71/叙述#64/Q107）**
grounding 目标 `block | edge | cut` 中的 **cut 是视图级结构概念**（影响图的割集），不是任何节点——"fork 即节点"的合并模型无处安放它。同时总账#71（叙述#64）规定 Guidance 双重 grounding："semantic basis 引用冻结 Influence View 的 block/claim/cut……factual basis 直接引用 AO/Segment/raw evidence"，且 "**Influence View 引用不得替换事实引用，事实列表也不得替代语义机制**"。合并层删除了 semantic basis 的指涉对象，Guidance 退化为纯事实引用列表，违反该双向约束的另一半。

## 三、中间路线：不合并对象模型，但拆掉"冗余感"

**M1. 只在投影/检索接口层统一（解决度：高）**
统一 projection 卡片 schema（一个卡片类型带 `kind=fork|branch|block|claim|segment` 字段族，L3 专属特征在 block 上声明为 missing 而非填零）、一张分层配额表（顺势落实 Round 10 Q112-A 的 6/4/2）、一份 ranker feature spec、一个 HybridRetriever（Q108 已是三段式雏形："服务端执行 BM25/vector/ACL/配额/初排，主 Memory LLM 决定 expand……完成跨 corpus 最终 rerank"）。运维只调一套旋钮，身份/信任/ACL 全部不动。直接消解 steelman S3。成本：一次 schema 设计。

**M2. grounding 去规范化内容快照（解决度：高）**
influence_grounding 附带内容寻址快照（freeze 时刻的 block/claim/cut 语义摘要 + content hash），消费 fork 的解释路径免跨层 join；view 被 supersede 或来源 ACL 变化时，复用 Q114-A 已定的 needs_revalidation 联动（"Fork grounding 标记 needs_revalidation（沿用变质模型，证据基础失效驱动而非 TTL）"）。与总账#68 "ForkNode ID 仍由 canonical anchor 派生" 完全兼容——快照是解释物不是身份。直接消解 S2。成本：存储冗余与失效联动逻辑。

**M3. 把 post_run 视图从"记忆"降格为"索引"并简化术语（解决度：中高）**
在 CONTEXT.md 与拟议 ADR-0010（Round 10 Q117-A 已列为候选）中重述定位：post_run_index 视图是 **AO 台账的派生索引**——可重建（有 deterministic fallback）、随 session supersede（Q111）、自身不累积 citation/utility（其投影通道状态由所 grounding 的 ForkRevision 派生，即 Q113-A）。心智模型变为：**一层记忆（L3）+ 一个索引（post_run view）+ 一个诊断工作集（DIV）**，术语上把 L2 拆成 Trajectory Index 与 Diagnosis Working View 两个名字。依据是总账#68 原文本来就写着索引语义："Draft 和完整视图不进普通检索；**仅 frozen Block/Claim 轻量 projection 进入 provisional mixed retrieval**"，Q102 的表述也是 "提供比 Fork **更密的 action/influence 表示**"。不需要改任何对象模型，直接针对"又多一层记忆"的错觉根源。

**M4. 基础设施层合并（解决度：中）**
提交校验做成单框架 + per-kind policy 插件；Q100 的 "阶段屏障复用统一 5 并发槽" 已铺路；Q110-A 的索引服务与 aggregator 同模式。消掉 S4 的管道实例化重复，但对语义层冗余感无帮助。

## 四、最终裁决

**不合并对象模型，走中间路线（M1 + M2 + M3 为主，M4 顺手做）。**

理由：

1. **合并的真实收益全部可以更便宜地获得**：join 成本由 M2 消解，双 corpus 运维由 M1 消解，"感觉冗余"的主体由 M3 消解，管道重复由 M4 消解。
2. **合并的成本落在五面承重墙上**，每面都有编号决策把守：稳定跨任务身份（总账#19/#68）、三层信任分离（Q99/总账#78、Q77/总账#54、Q81/总账#56）、可见性矩阵（总账#79）、稀疏/稠密生命周期（总账#3/#68）、检索语义分工（总账#75）。且 Round 9 已经以明确选项拒绝过三个合并变体（Q95-C "把模型构造的可变归因结构混入权威事实图"、Q102-B "取消 Fork/Branch 全局入口"、Q79-C "合并后统一取 Top 12"）。
3. **论文依据指向的方向恰恰是"分层"而非"合并"**：表示阶梯证明增益来自 "图接口 + reader 主动遍历"（55.20%），而把自适应图 flatten 给单次 reader 反而退化（50.40% < 52.00%）；调研文档总评自己写道，让一个结构同时承担 "导航、归因和长期记忆三个角色" 会 "边语义过深且难以验证"——这句话对 HypothesisBridge 成立，对合并后的 L2/L3 对象同样成立。且论文 8.4 明确 "没有测试 ForkCandidate 全局检索、citation 时间衰减……跨任务 utility"，L2/L3 分界的正当性不能从论文外推，合并的正当性同样不能。

**最先做的三件事**：

1. **落实 Q112-A 分层配额 + 统一 projection 卡片 schema 与 ranker feature spec（M1）**——这是 Round 10 已经打开的 frontier，把三 corpus 的运维合并顺势完成，不必等 ADR。
2. **给 influence_grounding 定义内容寻址快照与 supersede/ACL 变化时的 needs_revalidation 联动（M2）**——复用 Q114-A 已定机制，一次定义同时解决 join 成本与指针悬空两个问题。
3. **在拟议 ADR-0010（Q117-A）中写入 M3 的定位重述**：post_run 视图定名为 AO 台账的派生索引、DIV 定名为诊断工作集，明确"系统只有一层长期因果记忆（L3）"——用一次文档重述替换持续的心智税，这直接回应设计者的质疑而不动任何已定案的决策编号。
