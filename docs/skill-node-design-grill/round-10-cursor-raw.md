L2 与 L3 不该合并成同一套对象。Q102 把运行后视图送进检索之后，冗余感是真实的，但冗余出在投影和术语，不出在身份、信任和生命周期。决策总账止于 #80；正文第 61 条才是影响视图，总账 #61 是另一条（`memory@` 投递）。下面按总账编号引用，并在必要时标出正文条目。

## 1. 合并方案的 steelman

最强的合并不是改个层名，而是做成一种「影响–分叉记录」：影响子图内嵌在分叉修订里，或者分叉状态只是视图上的标注。这样可以拿掉强制的 `influence_grounding` 跳转、第二套可检索语料，以及主张状态与分叉状态两套机器。下面五条都按这个版本评估。

1. **对象种类可以少写几种。** 今天同时存在 InfluenceViewRevision、InfluenceBlock、InfluenceClaim，以及 ForkDraft、ForkRevision、Branch、HypothesisBridge、EvidenceBridge。合成一种记录后，实现上可以少一套表、少一条 outbox 投影、少一种幂等键。幅度是**表面的**。总账 #69 规定块必须是「单 participant、同 Segment、连续 AO」，跨主体关系只能走 Claim；正文第 7 条的锚点却包含 `interaction_edge`（跨 agent 协同决策点），定位类型还包含 `cut`。块、切、锚点、桥的基数不一样，合并后仍要留下 `kind` 字段，类型数从「多种对象」变成「一种对象上的多种判别」，约束一条没少。

2. **状态机看起来能从两套变成一套。** 视图是 draft、最多三轮 critic/refiner、然后冻结，失败则 `construction_mode=fallback`（总账 #72）。分叉是 ForkDraft、provisional ForkRevision、再追加 validated 或 invalidated（总账 #54）。主张另有 hypothesis、supported、contradicted、insufficient（总账 #78）。若合成一个枚举，文档里的机器数量下降。幅度是**表面的**。这三套轴回答的是不同问题：图有没有冻结、主张有没有被证据核验、因果结论有没有独立对照。合成之后状态空间是三者的乘积，合法迁移比现在更难审。只有删掉其中一轴（例如不再单独核验主张）才算实质简化，而那会直接拆掉 Q99。

3. **可以去掉 grounding 的 join。** 正文第 61 条要求每个 ForkRevision 都用 `influence_grounding` 指到冻结视图的 `block | edge | cut`。读一条因果记忆时要再打开视图修订、块和覆盖清单。长期看，这是额外的存储往返、版本对齐和「视图已 supersede、分叉修订仍指向旧块」的运维。幅度是**实质的**，但范围只限于读路径。join 本身是在维持「多张视图可以定位同一个锚点、一张视图可以含多个候选锚点」。用内嵌快照就能去掉热路径 join，不必把两种身份合成一个主键。

4. **检索运维可以从双库变成单库。** Q102 重定案把召回扩成三类语料：Fork/Branch、冻结 Block/Claim 轻量投影、当前 Segment/Atom，「各自配额和 ranker」。总账 #75 据此成立；总账 #55 又要求 verified 8、provisional 4，不足可回填，并保留来源通道和通道内 rank。再叠加总账 #59 的角色化 reranker，索引、配额、特征和审计都要做两遍。合成一个 corpus、一个配额池、一个排序器，运维面会明显变小。幅度在**运维上是实质的，在排序语义上是把复杂度搬家**。投影回答的是「哪个动作影响了下游」，分叉回答的是「哪个稳定锚点带有分支、指导、效用和验证状态」（正文第 67 条：「二者不互相替代」）。一个分数要比较这两种东西，特征设计会比现在的分通道更难解释。Q79 的选项 C（不设通道配额、合并后统一取 Top 12）和 Q102 的选项 B（只检索视图、取消 Fork/Branch 全局入口）都已经被否掉。

5. **实现者的心智负担会下降。** Q95 引入的是 diagnosis-local DIV，且「DIV 本身不进入全局检索」。Q102 又把同层改成通用 Influence View，分成 `purpose=post_run_index` 和 `purpose=failure_diagnosis`，并让冻结投影进入 provisional 混合检索。术语表里于是同时有 IV、DIV、Block、Claim、grounding、projection、ForkDraft、ForkCandidate、ForkRevision。少一层名字，上手成本会真实下降。幅度对**文档和接口命名是实质的**，对不变量是表面的：总账 #77 已经把 Reader 和 Diagnosis 收成同一个活 session，拆开的是阶段能力，不是又一条人工流程。

## 2. 合并的具体失败模式

总账 #61 的原文是「Memory Agent 以 memory@target_agent 定向投递」，不是影响视图。影响视图在正文第 61 条，对应总账 #68：「通用 Influence View 层：post-run 基础 revision + failure-diagnosis subtype；Fork grounding 到 frozen block/edge/cut」。Q81 的五项验证门槛在总账里是 #56，决策总账没有 #81。

1. **稳定锚点身份和按轨迹视图的粒度对不上。** 正文第 7 条把稳定身份定为 `{workspace_id, anchor_kind, canonical_anchor_key}`，「同锚点重复诊断复用 fork_node_id」。正文第 61 条同时写明：「ForkNode ID 仍由 canonical anchor 派生」。术语表对 Influence grounding 的禁用项是「用 block/view ID 派生 ForkNode ID、要求所有 anchor 都严格对应单个 block」；对 Influence block 的禁用项是「与稳定 ForkNode 身份等同；把所有 block 都当 fork」。一次失败诊断的视图里可以有多个候选锚点（Reader report 的职责就是交出候选 anchor）。同一个锚点又会被多条轨迹的 `post_run_index`、派生的 `failure_diagnosis`，以及日后再诊断的新视图分别 grounding。合并后只剩两条路。把身份改成随视图走，总账 #13「依赖稳定 fork 身份」的聚合、总账 #19「稳定锚点复用、revision 追加」会失效，跨任务引用会在每次重建视图时换主键。把视图改成随锚点走，则一张图无法再承载多个候选切面，`interaction_edge` 这种跨 participant 锚点也无法塞进总账 #69 的单主体连续块。`cut` 这种「一组块/边对应一个分叉」的定位也会消失。

2. **导航级信任和证据级信任会被当成同一个位。** Q99 把三件事拆开：schema validity、semantic plausibility、evidence verification，「避免 critic 的没发现错误被当成因果证据」。总账 #78 把主张核验写成「artifact 产生/消费/effect/反例」，状态只有 supported、contradicted、insufficient；正文第 69 条写明「supported 也不自动生成全局 EvidenceBridge」。分叉侧是另一套门槛：总账 #54 的三阶段里，服务端接纳只说明记录和来源被接受；正文第 44 条写「不等于因果结论已验证」。总账 #56 要求 validated 同时满足五项，其中包含至少一条原始 observed branch 和至少一个独立对照。总账 #72 又规定 fallback 视图「仅支撑 provisional」。合并成一个状态位之后，冻结的 fallback 块或一条 supported 主张会在检索和效用里看起来像已验证因果记忆；反过来，视图 critic 上的高严重度 violation 会把已经过对照的分叉修订打回未验证。引用强度只允许影响 provisional 通道内部排名（正文第 41 条），合成之后这条防火墙没有独立字段可挂。

3. **可见性模型不能共型。** 总账 #79：「Memory 只全局搜 frozen Block/Claim projection；完整 view/evidence 按 scope 与 ACL 下钻」。正文第 70 条补充：同 task/evaluation 可按已知 ref 读完整冻结的 selected blocks/claims，跨任务命中后必须逐 ref 做 ACL 和 evidence escalation；draft 和 critic 私有状态永远不可见。Q103 重定案把跨任务默认收成投影卡。分叉则是全局因果记忆入口（总账 #11「检索入口 = fork node + branch」，总账 #44 允许 ForkCandidate 全局 provisional 可检索）。合并后，若跟随分叉的全局可见性，每条轨迹的影响图、`coverage_manifest` 里的遗漏区间（总账 #74）会进入跨任务发现，调用者可以推断源轨迹哪些范围没被读过，这和总账 #66「在线强度、治理、排名只使用 principal 可见事件」的侧信道约束冲突。若跟随视图的同任务全文、跨任务仅投影，跨任务就发现不了应被簇和四维重排使用的分叉（总账 #30、#47），Memory→Diagnosis→Memory 的跨任务参照会断。

4. **写入频率差会淹没因果账本，或者反过来抽空索引。** 正文第 61 条：每条 causal/evaluation 轨迹 commit 后异步生成 `post_run_index`，失败诊断再派生 `failure_diagnosis`。总账 #3：fork node「按需构造、天然稀疏、无上限」。Q102 保留密集视图的理由是覆盖「尚未产生 fork 的成功轨迹和冷启动」。把每张运行后视图都写成 ForkRevision，总账 #13 的 `fork_node_id` 聚合、总账 #32 的簇条件效用、总账 #50 的 exposure/citation/adoption/outcome 会吃进大量从未被选为决策点的索引节点；视图每次重建还会触发总账 #37 那种「证据基础失效」式的 supersede，造成假再验证。只保留按需分叉、不再为每条轨迹建视图，则 Q102 要的密集 action/influence 召回消失，冷启动只剩稀疏锚点。两种生命周期写进同一对象，稀疏权威和密集索引必然牺牲一边。

5. **成本包络不能共用一条失败策略。** 运行后索引允许降级：正文第 65 条写，构建失败、超时或仍有高严重度 violation 时，服务端生成 deterministic minimal fallback，「可参与 provisional projection 或供 Fork grounding，但不能单独满足 validated 门槛」，且不得同步阻塞 task commit。分叉验证走的是另一条经济曲线：总账 #60「ControlContract 冻结独立对照；关键项不满足仅作 supporting evidence」。契约要冻结同一 anchor/state、任务输入、模型与 prompt policy、工具与依赖版本、权限、预算和独立 evaluator。把二者合成一种记录后，要么每次轨迹索引都得跑配对对照，成本和「异步、可 fallback」冲突；要么 fallback 索引也能单独满足总账 #56 的验证门槛，对照契约被绕开。生成权也不一样：总账 #73 规定 L2 是「LLM 解释」加确定性检查/fallback，L3 是「LLM propose+服务端提交」。合并会让建索引的 Builder 拥有写因果记忆的路径，和总账 #77 的阶段门冲突：READ_VERIFY「不能 propose Fork」，SYNTHESIZE_PROPOSE「不能修改 view/report」。

6. **指导的双重依据会被压成一份引用。** 总账 #71：「Guidance 同时保留 Influence View semantic basis 与 AO/Segment/raw factual basis」。正文第 64 条写明，视图引用不得替换事实引用，事实列表也不得替代语义机制。视图一旦成为分叉记录的内嵌字段，实现上最容易只留一组 refs。语义机制和权威复核从此无法分栏审计，hindsight 与当时依据的隔离（正文第 6 条的双字段）也会失去「机制解释指向哪一层」的锚。

论文侧同样不支持合并。调研文的结论是：在确定性 Interaction DAG 之上做查询相关的影响视图，验证后的结论才晋升为 EvidenceBridge/ForkRevision；并明确不把 mutable per-trace graph 变成全局长期图。它还写明，若让全局假设边同时承担「导航、归因和长期记忆」，边语义会过深且难以验证。论文没有评估跨任务检索、引用衰减、replay 或技能晋升，因此不能用来证明把长期层折进影响图是安全的。

## 3. 中间路线

对象模型保持两层，只处理「看起来像两套记忆」的部分。

1. **只在投影和检索接口合并。** 存储仍是三类语料，响应合成同一种卡片信封：`kind`、通道、通道内 rank、状态标签、来源指针。这和总账 #40 的 typed retrieval facade、总账 #75 的混合检索、Q102 的 `expand(typed_ref, relation)` 同向。调用方和运维看到一个搜索入口，配额和 ranker 继续按 corpus 分开。解决度大约覆盖检索侧冗余感的七成，不触及身份、状态机和 ACL。统一 TopK 不在这条路线里统一 TopK 不在这条路线里。Q79 选项 C（不设通道配额、合并后统一取 Top 12）和 Q102 选项 B（只检索视图、取消 Fork/Branch 全局入口）都已经否决。接口上只合成同一种卡片信封：`kind`、通道、通道内 rank、状态标签、来源指针。存储仍是三类语料，配额和 ranker 继续按 corpus 分开。这和总账 #40 的 typed retrieval facade、总账 #75 的混合检索、Q102 的 `expand(typed_ref, relation)` 同向。解决度大约覆盖检索侧冗余感的七成，不触及身份、状态机和 ACL。

2. **在 grounding 处做去规范化内容快照。** ForkRevision 的 `influence_grounding` 除了 view revision 与 `block | edge | cut` 的身份，再冻结当时的摘要、覆盖范围指针和 content hash。常规消费读快照即可，不必为了展示机制再 join 整张视图。视图以后 supersede 不改写这条修订；新结论追加新 ForkRevision，并指向新快照。解决度对 join 成本和「读分叉还要打开另一层」的体感是高的，大约去掉热路径跳转的大部分。它不减少语料数量。快照也不能取代总账 #71 的 factual basis，核验事实时仍按总账 #80 回到 AO/Segment/raw。

3. **把 `post_run_index` 从「记忆」降为「轨迹索引」，并收紧记账边界。** Q102 的 purpose 本来就叫 index。术语和检索契约应把它写成索引叠加层：冻结 Block/Claim 投影仍可进入 provisional 召回，提供密集动作与影响命中，尤其是还没有分叉的成功轨迹和冷启动。这些命中不进入 `fork_node_id` 聚合，不进入 citation、utility、簇和 verified 通道，也不能单独满足 validated。`failure_diagnosis` 继续作为诊断工作视图，服务于 Reader 和 grounding。这样总账 #11（因果入口仍是 fork node + branch）和总账 #75（投影参与混合检索）可以同时成立。解决度最高：它对准的是 Q102 之后才出现的「两套记忆」感，同时保留论文支持的那张导航地图。第二套库还在，但不再冒充因果记忆。

4. **给影响投影单独的引用账，不并入分叉的四层价值信号。** 投影一旦出现在 provisional 结果里，任务侧就可能对它形成 exposure 甚至结构化 citation。总账 #50 的 exposure、citation、adoption、outcome 以及 7 天 / 90 天半衰期，都挂在 ForkCandidate 及其 Hint 来源上。若不划界，索引命中会沿着「被看见、被引用、排名上升」进入总账 #13 的 `fork_node_id` 聚合。做法是：投影命中只记索引级 exposure，供离线评估召回质量；只有经过 grounding、成为 ForkRevision 或 Memory Hint 来源之后，才进入 in-task / cross-task reference strength 和 outcome utility。解决度中等偏高。它不减少对象种类，但堵住中间路线第 3 条最容易漏掉的记账口；和第 3 条一起做才完整。

三条主路线的分工是：第 3 条划清语义，第 2 条去掉读路径跳转，第 1 条去掉接口上的双入口体感。第 4 条防止索引命中回流进因果账本。四者一起做，仍然保留两套对象和两套状态机。

## 4. 最终裁决

**走中间路线，不合并 L2 与 L3 的对象模型。**

分层承担四种无法对齐的不变量。锚点身份跨任务稳定，块身份相对单张视图。主张核验只提供导航证据，分叉验证要过 ControlContract。视图同任务可全文、跨任务只有投影，分叉则可全局发现。运行后索引每条轨迹都可降级生成，分叉按需稀疏且验证昂贵。Q95 到 Q102 的演变说明，冗余感主要来自冻结投影进入了 provisional 检索，使索引层看起来像另一套记忆。正文第 67 条已经写了关系：视图提供密集召回，分叉保留稳定锚点、分支、指导、效用和验证状态。该收的是名字、快照、响应信封和记账边界，不是这两套主键。

最先做的三件事：

1. **改检索契约和术语，不改表结构。** 把 `purpose=post_run_index` 固定称为轨迹索引。投影可以出现在 provisional 混合结果里，并带索引标签。禁止这些命中进入 fork 聚合、引用强度、效用、簇和 verified 通道。`failure_diagnosis` 继续称为诊断影响视图，只作为工作界面和 grounding 来源。
2. **给 `influence_grounding` 加冻结快照。** 字段至少包括 view revision id、`block | edge | cut` 定位、摘要和 content hash。ForkNode 主键继续只由 `{workspace_id, anchor_kind, canonical_anchor_key}` 派生。消费分叉时默认读快照；要核验事实时仍走 summary-first，回到 AO/Segment/raw（总账 #80）。
3. **合成单一检索响应信封，并把投影引用隔在因果账本之外。** 卡片带 `kind`、来源通道和通道内 rank。Fork/Branch、影响投影、Segment/Atom 继续分配额、分 ranker；verified/provisional 的 8/4 与回填规则保持不变。投影命中只记索引级 exposure；进入 citation、adoption、outcome 之前，必须已经是 ForkRevision 或 Memory Hint 的来源。
