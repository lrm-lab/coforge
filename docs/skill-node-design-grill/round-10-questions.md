# Round 10（griller: ZCode / GLM-5.3，接替 kiro 收尾）——post-run 索引经济性、混合检索配额与投影治理

背景：Round 9 全部 Q50–Q108 已由设计者答复并同步入 CONSENSUS/CONTEXT（kiro 于 2026-09-24 10:34 额度耗尽，同步已完成、待定项审计未做）。本圆由接手 griller 完成审计后重新计算 frontier：Q102（重定案）把 L2 从"仅 diagnosis-run 工作层"扩展为"每条轨迹 commit 后异步生成可检索 post_run_index 视图"，Q108 定了三段式混合检索——这两项决定打开了以下从未拷问过的分支。

❓ **Q109** - **post_run_index 视图采用什么覆盖策略？**

Q97 只为 diagnosis 视图定了"查询相关稀疏覆盖 + coverage_manifest"。post_run 视图是 query-neutral 的：没有失败目标也没有诊断 query。

- A. 有界目的性覆盖：以 "task 目标 + observed outcome" 作为组织 query，覆盖与任务执行路径相关的 AO/Segment 子集，必须带 coverage_manifest（含 omitted ranges 与理由）；不追求全轨迹覆盖。结构沿用 Q97（无环、root→sink 弱连通、skip 标注）。
- B. 全覆盖：把轨迹全部 AO/segment 都变成 block——即 Q97-A 明确避免的"昂贵日志重写"。
- C. 固定滑动窗口摘要（如只索引最后 N 个 AO）。

➡️ 推荐 A。post_run 视图的价值是"比 Fork 密、比日志便宜"，全覆盖会把它变成第二份台账；固定窗口则丢掉任务早期的因果链。

---

❓ **Q110** - **post_run 索引管道归谁所有，成本与留存如何治理？**

Q92 只给 EvaluationOrchestrator 授予了评测状态机的所有权；常规轨迹的异步索引不是评测迭代。每条 causal 轨迹都跑一次 LLM 构图（Builder/Critic/Refiner），是持续的真金白银成本。

- A. 独立服务端异步索引服务（与 outbox/aggregator 同模式）：workspace 级预算与速率上限；队列优先级 = evaluation 任务 > 失败轨迹 > 成功轨迹；预算耗尽/超限时降级为 deterministic fallback view 或延迟入队（不做就明确没有 projection，不伪装）；被 supersede 的旧 view revision 与 projection 只留审计、退出索引。workspace 可暂停索引。
- B. 由 EvaluationOrchestrator 顺带驱动所有索引（评测器变成全局索引器）。
- C. 不设预算，轨迹 commit 即同步建图。

➡️ 推荐 A。索引是基础设施不是评测逻辑；B 会让 orchestrator 的状态机耦合吞吐压力，C 会在高流量 workspace 直接拖垮 commit。

---

❓ **Q111** - **多 commit 会话中 post_run 视图如何演化？**

一个 session 可能多次 commit；"每条轨迹 commit 后生成"字面执行会产生一串互相重叠的视图。

- A. 以 session（或 task run）为视图主体：后续 commit 的 post_run build 产生 superseding InfluenceViewRevision，旧 revision 保留为历史证据但 projection 退出索引；diagnosis 派生仍可引用任意历史 revision。
- B. 每个 commit 独立一份视图，全部保持可检索。
- C. 只有 session 结束（.done）才生成一份。

➡️ 推荐 A。与 Fork revision 的 supersedes 模型、簇的 successor 模型一致；B 会让同一 session 的重叠视图瓜分检索配额。

---

❓ **Q112** - **三类 corpus 的配额如何与既有的 12 候选 / 8-4 通道合成？**

Q79 定了"每次最多 12 个轻量候选、verified 8 / provisional 4"；Q102（重定案）又定了三类 corpus "各自配额和 ranker"。两句话没有合成规则：12 是全局总帽还是每 corpus 各 12？Segment/Atom 属于 Interaction lane（Q63 独立预算）还是也进这 12？

- A. 分层配额：Interaction lane 维持独立候选预算（SearchPlan 内 seed 展开，不占 12）；causal-memory lane 内 12 为查询级总帽，默认 Fork/Branch 6、InfluenceBlock/Claim projection 4、Segment/Atom 引用展开 2，role profile 可调但总帽不变；verified/provisional 8-4 通道切分只在有状态语义的对象上生效（Fork/Branch/Bridge），事实类 corpus（Segment/Atom）与 projection 按各自规则进榜并带来源标签。
- B. 每 corpus 各 12，总量最多 36。
- C. 取消 corpus 配额，全部合并按统一分数取 Top 12。

➡️ 推荐 A。B 会撑爆上下文；C 抹平 corpus 身份，违背 Q50/Q102 的 typed 原则。具体数字（6/4/2）可再调，规则本身需要先定。

---

❓ **Q113** - **Influence projection 是否永远停在 provisional 通道？**

CONSENSUS #61 说 frozen Block/Claim projection 进入 provisional 混合检索。当一个 block/claim 成为 validated ForkRevision 的 influence_grounding 后，它还是 provisional 吗？

- A. 通道跟随 grounding 状态：被 validated ForkRevision grounding 的 block/claim projection 可进入 verified 通道，并携带该 ForkRevision 的 provenance 标签；未被 grounding 或只被 provisional/invalidated revision 引用的保持 provisional。projection 本身仍不因此变成证据原件。
- B. projection 永远 provisional，无论 grounding 状态。
- C. projection 单独走第三条通道。

➡️ 推荐 A。否则一个已被因果验证支撑的影响结构在排序上永远压不过未验证对象，verified 通道的语义（"通过相应验证门槛"）也得不到延伸；B 会让长期运行后 provisional 通道被高质量内容挤占。

---

❓ **Q114** - **来源 ACL 变化时，已发布的 projection 如何处理？**

Q94 治理了"在线聚合只用 principal 可见事件"，但 projection 卡片本身含语义摘要——若来源 session 事后收紧 ACL，已全局可见的摘要构成侧信道。

- A. projection 继承来源 AO/Segment 的安全标签；ACL 变更事件经 outbox 触发受影响 projection 的再投影/撤下（redact 或退出索引），引用该 projection 的 Fork grounding 标记 needs_revalidation（沿用变质模型，证据基础失效驱动而非 TTL）；下钻路径上 redacted 节点仍是断点。
- B. projection 一经发布不再更新，ACL 只在下钻时生效。
- C. projection 不带任何来源内容，只放 ID。

➡️ 推荐 A。与既有"逐 ref 重验 ACL"和变质模型同构；B 等于承认摘要层漏权限；C 违背 projection 承载语义摘要的定义。

---

❓ **Q115** - **worker 并发上限的账本一致性确认**

文档中现存三个数字：Round 7 决策"并行子诊断 ≤3 个一次性 worker"、Q65/Q69"每次评测迭代统一最多并发 5 个一次性子 agent（含 sub-diagnosis worker 共用槽位）"、Round 8 dossier 再诊断"预算 ≤4 候选 / 1 path / ≤首诊 50%"。

- A. 确认统一规则：Memory→Diagnosis→Memory 评测迭代内统一并发 5（Q69/Q100 阶段屏障复用）；独立诊断 run（非评测迭代）沿用 ≤3 sub-diagnosis worker；dossier 增量再诊断预算规则不变。CONSENSUS 第一节第 22 条的 "≤3" 补注"评测迭代内由统一 5 席取代"。
- B. 全部场景统一 5。
- C. 维持三处数字不改，按上下文各自解释。

➡️ 推荐 A。三个数字本来针对三个层级（评测迭代/诊断 run/增量再诊断），不冲突但文档从未说明层级关系；B 会悄悄扩 Round 7/8 已定的预算。

---

❓ **Q116** - **非评测（普通任务）中 Memory Agent 的检索与投递由什么触发？**

Q92 的状态机只覆盖评测迭代。普通群聊任务里 Memory 何时检索、何时 memory@ 投递没有被问过。

- A. workspace 策略化：默认 = 显式触发（用户/任务 agent `@memory` 或任务开始信号）+ 评测迭代内的 orchestrator 驱动；不做自主持续监听。每次触发创建有 TTL 的 MemoryTaskState，超期过期。
- B. Memory 对频道每条消息都自主检索并择机投递。
- C. 只允许评测模式使用 Memory，普通任务不接。

➡️ 推荐 A。B 的成本与打扰不可控，且与"MemoryTaskState 按 task/run 隔离"的粒度不匹配；C 浪费已建成的消费侧机制。

---

❓ **Q117** - **Round 9 的哪些决策集群立 ADR？**

Round 1–8 已有 9 个 ADR（0010 之前）。Round 9 的不可逆决策尚未立档。候选集群：

- A. 立四个：0010 Influence View 层与 post-run 索引（#61/#65/#67/#72/#73，含本圆 Q109–Q111 的细化）；0011 Hypothesis/EvidenceBridge 分型与假设图治理（#36/#42/#43/#47/#50）；0012 ForkRevision 三阶段生命周期与 Memory→Diagnosis→Memory 评测循环（#44/#48/#49/#58）；0013 Memory 消费侧记账：Hint/Disposition/Followthrough/效用与 ACL-safe 聚合（#53–#57/#59）。
- B. 只立一个大 ADR 覆盖 Round 9 全部。
- C. 暂不立 ADR，直接进入实施。

➡️ 推荐 A。四个集群各自满足"难逆转 + 无上下文会费解 + 真实取舍"；B 会让单份 ADR 失焦；C 违背既有"不可逆决策必须立档"的节奏。

---

## Q116=B 之后打开的 frontier（自主监听模式）

设计者选择 B：Memory 对频道每条消息自主检索并择机投递。该模式与 Q55（Memory 是群聊成员）、Q57（MemoryTaskState 按 task lineage/run 隔离）兼容，但成本、打扰与预算三个维度从未定过：

❓ **Q118** - **自主监听下，什么消息才触发完整检索？**

- A. 两级门控：每条消息先过服务端廉价相关性过滤器（确定性规则 + 轻量相似判定，决策可审计），判定"任务相关新信息/状态变化"才触发三段式完整检索（服务端预召回 + 主 Memory LLM explore）；消息风暴时限频合并（如同一 task lineage 每 N 分钟至多一次完整检索），被过滤消息只进 MemoryTaskState 的滚动上下文。过滤器阈值 workspace 可配。
- B. 每条消息都跑完整三段式检索，由 Memory Agent 自己判断何时停止。
- C. 固定周期检索（如每 10 分钟），与消息节奏无关。

➡️ 推荐 A。B 在活跃频道下 LLM explore 成本失控，且大多数寒暄/确认消息毫无检索价值；C 会错过任务关键时刻。

---

❓ **Q119** - **自主投递的节流与打扰控制？**

- A. 每任务投递治理：同一 task lineage 对同一 target agent 的未决（未 disposition）Hint 数上限（默认 2）、冷却窗口、同 provenance Hint 去重（只刷新 TTL 不重发）；target agent 可声明偏好（如 defer-all、按 hint 类型过滤）；用户可要求静默；超时未处理只记 exposure（沿用 Q89）。
- B. Memory 判断有价值就投递，不设上限。
- C. 所有 Hint 投递前需用户确认。

➡️ 推荐 A。B 的打扰会摧毁目标 agent 对 memory@ 通道的信任，defer-all 也无从谈起；C 把自主模式退化回人工模式。

---

❓ **Q120** - **普通任务中 Memory 检索的预算与权限归属？**

评测迭代有 task/evaluation 父级总上限（Q58）；普通任务没有这个父级。

- A. workspace 级 Memory 服务预算独立记账（与 post_run 索引预算分开，见 Q110）；capability = 频道成员身份 ∩ 各来源 session ACL（沿用逐 ref 重验）；检索沿用 Memory retrieval profile 与配额；无 evaluation 父级时以 workspace 上限为父级，耗尽即本任务停止主动检索（可被 @memory 显式唤醒一次）。
- B. 每次触发无上限，直到模型自己判断停止。
- C. Memory 的消耗计入被投递目标 agent 的预算。

➡️ 推荐 A。B 在自主模式下等于无治理；C 会让目标 agent 为没要过的检索买单，激励扭曲。

---

## L2/L3 合并质疑（外部评审后立案，全文见 round-10-external-review.md）

设计者质疑 L2（Influence View）与 L3（Fork 因果记忆）分层过度设计、感觉合并更好。经双重独立评审（独立子 agent + cursor CLI/grok-4.7，裁决一致，见 round-10-external-review.md 与 round-10-cursor-raw.md）：合并的真实收益（少一套状态机、消除 grounding join、检索侧单 corpus、术语减半）全部可由更便宜的中间路线获得；而合并撞五面承重墙——fork:anchor 1:1 稳定身份 vs fork↔view M:N 粒度错配（总账#19/#68）、Q99 三层信任分离塌缩（总账#78 + #72 fallback 不对称）、可见性矩阵冲突（总账#79，加剧 Q114 侧信道）、每轨迹稠密 vs 按需稀疏的成本包络互染（总账#3/#68）、检索排序特征不同源（总账#75"二者不互相替代"）。

❓ **Q121** - **是否合并 L2 与 L3 为一层？**

- A. 不合并对象模型，走中间路线：M1 检索/投影接口统一（统一卡片信封 schema：kind、通道、通道内 rank、状态标签、来源指针；分层配额表；单份 ranker feature spec——与 Q112-A/Q113-A 同一件事）；M2 influence_grounding 附带内容寻址冻结快照（view revision id + block/edge/cut 定位 + 摘要 + content hash）+ supersede/ACL 变化时 needs_revalidation 联动（复用 Q114-A）；M3 定位重述——post_run 视图是 AO 台账的派生**轨迹索引**、DIV 是诊断工作集，系统只有一层长期因果记忆（L3），写入拟议 ADR-0010；M4'（cursor 补充）投影命中的引用账隔离——投影命中只记索引级 exposure（仅供离线召回质量评估），不进入 citation/utility/fork_node_id 聚合/簇/verified 通道；只有成为 ForkRevision 或 Memory Hint 来源后才进入因果账本。
- B. 合并 L2/L3 为一个对象模型与一层生命周期。
- C. 只做 M3 文档定位重述，检索接口与 grounding 快照维持现状。

➡️ 推荐 A。B 的每条收益都有十分之一成本的替代（M1–M4'），且 Round 9 已三次以明确选项拒绝合并变体（Q95-C/Q79-C/Q102-B）；C 解决不了 join 与双 corpus 运维的真实摩擦。M4' 若缺位，索引命中会沿"被看见→被引用→排名上升"回流进因果账本，重演 Q66 防过的自证循环。

---

## 设计者四论点评审后立案（cursor 二审 + 主 agent 交叉核对，原文见 round-10-cursor-raw-2.md）

设计者提出：①子任务级 causal 检索更具泛化性；②fork future path 可并入 influence graph 或让其引用；③跨任务边可改为图节点多分支的泛化能力；④多根因失败下单节点干预无效，fork 可记录"改哪些 action 解决哪些任务/子任务"。评审澄清的事实前提：AIG 论文没有多层记忆——其图是单条失败轨迹上一次归因内现建、用完即弃的导航接口；节点记录动作（role/step_refs/input/output/authorship），失败传播写在边（downstream_effect），责任是 Reader 的输出而非节点字段；L0–L4 是本设计后加的。四个论点的共同偏差是把这张一次性导航图当成了长期因果记忆的候选载体。

❓ **Q122** - **子任务级召回要不要新身份？**

- A. 不铸造 `subtask_id`。检索查询允许是"子目标 + 依赖模式"（想要的 artifact、effect——正好匹配 InfluenceClaim 的 carried_artifact/downstream_effect 签名），打到现有 Block/Claim projection；命中后只在同一冻结视图内沿 Claim 做有界邻域展开（复用既有 path/entity 预算），"子任务因果链"是读时拼出的邻域、不落成对象。跨任务命中仍按对方 task_id 记 cross-task（Q88-B 不动）；投影命中只记索引级 exposure（M4'）、不写相似边、不进 utility。
- B. 引入稳定 `subtask_id`，跨任务合并同一子任务的 citation 与 utility。
- C. 检索只允许整段 Fork context，禁止用子目标查询 block/claim。

➡️ 推荐 A。设计者的粒度直觉成立但身份结论不成立：fork 锚点本来就是细粒度（ao/session_state/interaction_edge），block/claim projection 已是 action 级，缺口在查询形状不在身份模型；B 重演 Q90 拒绝的内容合并、且"同一子任务在不同锚点状态/失败机制下正确动作可以相反"，按子任务身份合并会跳过四维重排反而降低泛化；C 丢掉 #75 已买下的密集召回。

---

❓ **Q123** - **future path 与影响图如何关联？**

- A. 不把分支写入影响图（干预语义 ≠ 观察归因语义，合并重演 Q121 信任塌缩）。对已是 influence_grounding 目标的 `block | edge | cut` 建**反向索引**：READ_VERIFY 阶段可读对应 Fork/Branch 的轻量摘要与该分支自己的验证状态，单独一栏标为"干预史"；不改变 Claim 状态、不进 citation/utility；视图 supersede 或 ACL 变化走既有 needs_revalidation。
- B. 真实/想象分支成为 Influence 节点的出边，与 Claim 共用一套状态。
- C. 不做反向索引。

➡️ 推荐 A。正向引用已有（grounding），缺的只是反方向"读到一个块时看不见这里发生过哪些已提交分叉"；诊断看到干预史会改变探索策略，成本只是一层索引。B 把 synthetic observation 写进本应落回原始 AO 的证据地图。

---

❓ **Q124** - **跨任务泛化记在哪里？**

- A. 维持现状语义：泛化 = 已验证相似边上的簇 + 簇条件 branch_pattern 效用（#30/#32）。影响图节点不挂其他任务的分支，相似边不改写成图内多分支；诊断需要时经 Q123 反向索引只读联结。
- B. 把跨任务迁移改记为 Influence 节点的多分支 path。
- C. 用 cross_task_reference_strength 直接代表泛化能力。

➡️ 推荐 A。B 从后门放进 #30 明令禁止的相似性传递（图内路径会被读成跨任务相似），且 block 无跨任务稳定身份、aggregator/簇成员资格断链；C 把引用强度当效用，#37 已分栏。

---

❓ **Q125** - **多根因要不要新的原因集合？**

- A. Block 不加失败原因字段（失败传播仍在 downstream_effect，责任定位仍是 Reader 候选 anchor，修理仍是完整 Branch——branch 本身可编码多处改动，cut grounding 可定位块集合）。仅当分支已过 replay 投资六门槛且 diff 含 ≥2 处可分离改动时，允许在同一 ControlContract 下对**最多 2 个预声明子集**做配对 replay，结果记为该 branch 的 supporting evidence（subset_sufficient / not_sufficient），不能单独满足 validated 门槛，不新造 cause_set。
- B. 新增多锚点 cause_set 身份，并在节点上记录根因。
- C. 不做子集实验：干预证据只保留整支分支相对基线的充分性；"修好子任务但任务仍失败"由 forecast contract 的 partial_match 表达。

➡️ 推荐 A（可分期：先按 C 落地，F 组实验显示误判"多处改动缺一不可"成瓶颈时再启用子集 replay）。真实的窄缺口是"必要性归因"——多改动分支被验证充分后，不知道删掉一部分是否仍充分；B 是无对照的叙事当必要性，且撞 #19 单锚点身份。
