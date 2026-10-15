AIG 论文没有多层记忆。它的图是对单条已完成失败轨迹、在一次归因里现建的导航接口：Builder 可改，Critic 最多三轮，Reader 只读并回查原日志，产出是 responsible agent 加 critical step，用完即弃，不进入跨任务账本。节点记的是动作（角色、step refs、input、output、authorship），不记责任。失败传播写在边上：下游继承了什么、该继承如何表现为失败症状。责任是 Reader 的输出，不是节点字段。论文没有反事实分支、跨任务边、效用或长期记忆；L0–L4 是当前设计后加的。四个论点把这张一次性导航图当成了长期因果记忆。

## 论点一：子任务级 causal 检索

「子任务因果检索更泛化」这句，前半截的粒度直觉成立，后半截的身份结论不成立。缺口在查询形状，不在身份模型。

前提先错了。Fork 不是「整段多 agent 轨迹等于一个任务」的摘要。术语表把 Fork 节点定义为按需构造的分叉决策点；叙述第 7 条写明锚点只有 `ao | session_state | interaction_edge`，稳定身份是 `{workspace_id, anchor_kind, canonical_anchor_key}`。Causal context 是诊断时回溯选定的 AO 序列，不是整任务打包。

比「子任务」更细的检索原子已经在。总账 #69 规定 InfluenceBlock 必须是「单 participant、同 Segment、连续 AO」；跨 agent、非相邻影响走 Claim。总账 #75 的原文是「Influence View 提供密集 action/influence 召回，Fork 保留稳定 anchor、branch、guidance、utility 与验证状态，二者不互相替代」。两个任务里相似的动作块，今天就可以靠冻结 projection 被各自命中，不必先变成同一个 Fork。

已付费的泛化也不在「是不是同一个子任务」。叙述第 35 条：跨任务按「任务/决策类型、锚点状态、失败机制、行动与 skill 角色」四维重排。总账 #32：`utility(cluster_id, branch_pattern / skill_revision, evidence_status)` 为主视图，全局效用只是带样本量与异质性的聚合。同一子任务在不同锚点状态、失败机制、skill 角色下，正确动作可以相反。用子任务身份合并它们，会跳过这四维，泛化变差，不是变好。

AIG 本身也不是子任务检索器。它是整条失败轨迹上的自适应归因接口；稀疏只出现在当前设计的 Q97（查询相关覆盖加 `coverage_manifest`）。论文没有测跨任务召回。

和 Q88-B 的关系：不冲突，只要不新造身份。总账 #63 的原文是「task_id 不同即 cross-task；不引入 task_family」。那是引用记账，不是检索粒度禁令。用子目标去搜 block/claim，命中仍按对方 `task_id` 记 cross-task，Q88-B 不动。一旦铸造 `subtask_id`，并把 citation 或 utility 按它归并，就和 Q90「即使文本相同也不按内容 hash 合并」是同一类合并，那时才冲突。

不引入新身份的路径：

1. 查询允许是子目标加依赖模式（想要的 artifact、effect），打到现有 Block/Claim projection。覆盖策略仍可按 Q109 的建议以 task 与 outcome 组织视图，检索单位仍是块和主张。
2. 命中后只在同一冻结视图内沿 Claim 做邻域展开，复用已有 path/entity 预算，把「子任务因果链」当成读时拼出来的邻域，不落成对象。
3. 有 grounding Fork 时，适用性仍走四维；纯 projection 命中保持 provisional，在线 Memory 不写相似边（叙述第 35 条）。投影命中继续只记索引级 exposure（Q121 的 M4'）。

## 论点二：future path 并入影响图

合并与反向引用不是同一件事。合并应拒绝。反向索引值得做，而且便宜。

Future path 是干预语义。叙述第 10 条：未来分支是真实分支、想象分支（完整 AO 序列，逐条标 synthetic）、guidance。验证要过总账 #56 的五项门槛和总账 #60 的 ControlContract。效用按 `fork_node_id` 聚合（叙述第 16 条）。

InfluenceClaim 是观察归因语义。总账 #78：Builder 创建时永远是 hypothesis；Reader 核验「source 产生 carried_artifact、target 实际消费、downstream_effect 出现及反例」之后才是 supported / contradicted / insufficient；supported 也不自动生成 EvidenceBridge。Q99 把 schema validity、semantic plausibility、evidence verification 分成三层，就是为了避免「没发现错误」被当成因果证据。

把 future path 收成图节点的出边，会重演 Q121 已否决的信任塌缩：一个状态字段同时表示「reader 核对过一条观察边」和「配对对照验证过一条反事实」。想象分支的 synthetic observation 还会写进本应落回原始 AO 的证据地图。Block 身份相对于视图、随 revision supersede；Fork 身份是永久锚点。CONTEXT 已把「用 block/view ID 派生 ForkNode ID」和「把所有 block 都当 fork」列为禁用。`cut` 是割集位置，不是节点，合并后没有地方放（外部评审 F6）。这和 Q121-B 是同一面墙，只是从「整层合并」换成「把分支挂到节点上」。

反向引用是另一条路，而且正向已经有了。总账 #68：每个 ForkRevision 用 `influence_grounding` 定位到 `block | edge | cut`。总账 #71：Guidance 的 semantic basis 指向 block/claim/cut，factual basis 仍指向 AO。缺的是反方向：诊断读到一个块时，看不见「这里已经有过哪些已提交的分叉」。

值得做的范围很小：只索引已经成为某次 ForkRevision grounding 目标的位置；READ_VERIFY 阶段给出轻量摘要和该分支自己的验证状态；单独一栏，标成干预史。它不改变 Claim 状态，不把 Branch 写成 InfluenceClaim，不进入 citation/utility（沿用 M4'）。视图 supersede 或 ACL 收紧时走已有的 needs_revalidation。这是 grounding 记录上的反向索引，不是新生命周期。

## 论点三：跨任务边改成节点的多分支泛化

「跨任务 fork 边 = 迁移能力」这句话把三种边读成了一种。分支模式的泛化已经记在簇上。挪到图节点上会拆掉簇特意守住的不传递。

现有边各自的含义：

- 已验证相似边（总账 #30）：「连接两个 fork-node revision 的语义相似关系」，簇成员资格的唯一依据；「A~B、B~C 不传递」。这是情境相似，不是迁移证明。
- HypothesisBridge：叙述第 36 条写的是「值得检查」，不是已验证相似，也不是因果。
- EvidenceBridge：支撑归因，仍然不是「对其他任务的泛化能力」。
- `cross_task_reference_strength`：引用强度。叙述第 37 条把两维和 outcome utility 分栏，引用不能自动晋升。

「这类情境下哪种分支模式有效」的记录是总账 #32：已验证簇内、带独立真实正向效用的 `branch_pattern`。中心是 Fork 决策点，成员来自其他树，效用带样本量与异质性。这就是设计者想要的「多分支对其他任务的泛化」，键在簇和分支模式上，不在影响图节点上。

改挂到图节点的多分支上会破坏四件事。图内路径是单条轨迹上的影响传播，读成跨任务相似就会把总账 #30 禁止的传递相似性从后门放进来。Block 没有跨任务稳定身份，aggregator 和簇成员资格会断。其他任务的分支嵌进本轨迹节点，会撞上总账 #79：跨任务只能先看 projection，再逐 ref 下钻。模型建出来的图分支会开始充当迁移证据，而叙述第 35 条禁止在线 Memory 创建相似边。

诊断时若要看到泛化，用论点二的反向索引找到 grounding Fork，再读该 Fork 已属簇的条件效用。这是读时联结，不搬迁账本。

## 论点四：多根因与干预语义

节点只记录事件，不记录「它为何导致失败」。多根因是真实现象，但当前设计缺的不是节点上的根因字段，而是「整支替代路径里哪些改动子集就够」这一种证据。这不值得用 `cause_set` 来修。

直接回答。InfluenceBlock 的字段是角色、AO/Segment refs、summary、input、output、authorship、`granularity_reason`、source hash。没有 failure reason，没有 blame。失败如何传下去，写在 Claim 的 `downstream_effect` 上，而且从 hypothesis 起算。Reader 的 supported 只表示观察故事与证据相符，不表示「改这个节点任务就会好」。责任定位是 ReaderReport 里的候选 anchor，再落到 ForkRevision。一次 run 最多 5 个候选（总账 #28）。总账 #43 写明 step reward 只是候选定位，不是根因。

「改图上任意一个节点可能修不好任务」攻击的是一套设计里不存在的修理动作。修理动作是分支：叙述第 10 条的完整替代 AO 序列，一次可以改多处；guidance 是分支字段。定位也可以不是单节点：grounding 的 `cut` 就是割集。一个任务多个 Fork 也已经允许。所以「单节点干预不够」并不构成缺口。

Fork 已经记录「试过哪条替代动作序列、相对基线是否更好」。它没有记录「改动集合的哪个子集是必要的」，也没有「这条分支修好了哪个子任务、没修好任务」的专门映射。局部修好、任务仍失败，可以由 forecast contract 的中间状态谓词和 `partial_match` 表达（叙述第 24 条），不必先有子任务身份。剩下的窄缺口是：一条多改动分支被验证为充分之后，不知道删掉其中一部分是否仍然充分。

取舍：

- `cause_set` 不该引入。它会变成跨锚点的新身份，直接撞上总账 #19 的单锚点 1:1。割集已经能点名一组块，而不夺取 Fork 身份。模型列出的原因集合没有配对对照，会把叙事当成必要性。
- 有界替代：仅当分支已过 replay 投资六门槛、且 diff 里至少有两处可分离改动时，在同一份 ControlContract 下，对最多 2 个事先声明的子集做配对 replay。结果记在该 branch 上，作为 supporting evidence：`subset_sufficient` 或 `not_sufficient`。它不写回 Block，不新造身份，不能单独把 ForkRevision 送进 validated。整支分支相对基线的充分性仍是验证门槛。不可 replay 的任务不做这项实验，也不许用模型标注代替。

多数失败保持「整支分支相对基线是否充分」就够。子集实验只在高价值、且否则会把多处改动误当成缺一不可时才付费。

## 裁决

| 论点 | 裁决 |
|---|---|
| 一、子任务级 causal 检索 | 改造后采纳。采纳「查询可以是子目标依赖模式，读时展开同一视图内的 Claim 邻域」。拒绝 `subtask_id` 及按它归并 citation/utility。 |
| 二、future path 并入影响图 | 拒绝合并。改造后采纳反向索引：仅已 grounding 的 Fork/Branch，诊断时可见，不耦合 Claim 状态，不进因果账本。 |
| 三、跨任务边改为节点多分支泛化 | 拒绝。泛化继续记在已验证相似边与簇条件 `branch_pattern` 效用上；诊断时经反向索引只读，不搬迁。 |
| 四、多根因与干预语义 | 拒绝节点根因字段，拒绝 `cause_set`。改造后采纳：仅高价值、可 replay、多改动分支做 ≤2 个预声明子集的配对 replay，结果只作 supporting evidence。 |

## 建议追加的 Round 10 问题

**Q122** — 子任务级召回要不要新身份？

- A. 不铸造 `subtask_id`。允许用子目标加依赖模式查询现有 InfluenceBlock/Claim projection；命中后只在同一冻结视图内沿 Claim 做有界邻域展开，复用既有 path/entity 预算。跨任务命中仍按 `task_id` 记 cross-task。投影命中只记索引级 exposure，不写相似边，不进 utility。
- B. 引入稳定 `subtask_id`，跨任务合并同一子任务的 citation 与 utility。
- C. 检索只允许整段 Fork context，禁止用子目标查询 block/claim。

推荐 A。B 与总账 #63、Q90 的不合并原则冲突；C 丢掉总账 #75 已经买下的密集召回。

**Q123** — future path 与影响图如何关联？

- A. 不把分支写入影响图。对已是 `influence_grounding` 目标的 `block | edge | cut` 建反向索引；READ_VERIFY 可读对应 Fork/Branch 的轻量摘要与该分支自己的验证状态，单独标为干预史。不改变 Claim 的 hypothesis/supported/contradicted，不进入 citation/utility。视图 supersede 或 ACL 变化时走 needs_revalidation。
- B. 真实分支与想象分支成为 Influence 节点的出边，与 Claim 共用一套状态。
- C. 不做反向索引。

推荐 A。B 重演 Q121 的信任塌缩。

**Q124** — 跨任务泛化记在哪里？

- A. 维持总账 #30 与 #32：泛化等于已验证相似边上的簇，加上簇条件 `branch_pattern` 效用。影响图节点不挂其他任务的分支，相似边不改写成图内多分支。诊断需要时经 Q123 的反向索引只读。
- B. 把跨任务迁移改记为 Influence 节点的多分支 path。
- C. 用 `cross_task_reference_strength` 直接代表泛化能力。

推荐 A。C 把引用强度当成效用，叙述第 37 条已经分开。

**Q125** — 多根因要不要新的原因集合？

- A. Block 不增加失败原因字段。失败传播仍在 `downstream_effect`，责任定位仍是 Reader 的候选 anchor，修理仍是完整 Branch。仅当分支已具备 replay 投资资格、且 diff 含至少两处可分离改动时，允许在同一 ControlContract 下对最多 2 个预声明子集做配对 replay。结果记为该 branch 的 supporting evidence，不能单独满足 validated 门槛，不新造 `cause_set`。
- B. 新增多锚点 `cause_set` 身份，并在节点上记录根因。
- C. 不做子集实验。干预证据只保留整支分支相对基线的充分性；局部修复只通过 forecast contract 的 `partial_match` 表达。

推荐 A。若暂不付这笔 replay 费用，C 是合法的更便宜默认，B 在两种情况下都不该选。
