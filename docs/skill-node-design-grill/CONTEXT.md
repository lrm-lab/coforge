# Skill-Node Design（OpenViking × coforge 会话经验抽取）

定义"在 session 归档中抽取关键步骤轨迹节点、跨会话检索、反事实想象与效用统计"这套机制的共同语言。本文件只放术语，不放实现决策；实现决策进 docs/adr/。

## Language

### 存储与身份

**归档证据（archive evidence）**:
一次 commit 写入 archive_NNN 的不可变记录，含消息原文与轨迹节点证据；不承载可变统计。
_Avoid_: 把归档当统计数据库

**节点投影（node projection）**:
fork node / branch 的轻量检索副本（摘要、embedding、指针），由 outbox 异步幂等发布于独立可索引命名空间；不含证据全文。
_Avoid_: 直接索引 sessions 树、把投影当证据原件

**混合检索的 fork 卡片**:
进行中混合检索返回的那张 fork 卡片。带七段快照和分支动作摘要。不带 guidance 全文，不带原始 AO。整张影响图不在这张卡片里。
_Avoid_: 只给 fork id、把 guidance 或原始 AO 放进卡片、用整张 view 代替这张卡片

**Fork 节点（fork node）**:
诊断 agent 按需构造的分叉决策点：七段状态快照、causal context 引用、未来分支与 used_skills 引用；锚点可为跨 commit 的历史 AO，或不可 replay 场景下的当前 session 状态；因按需构造而天然稀疏，不设数量上限。
_Avoid_: trajectory node（旧称）、commit 时批量抽取节点、数量上限

**Segment（交互段）**:
群聊中 agent 每次发送或接收消息形成的截断边界；是 interaction DAG 的构造单元。
_Avoid_: 把 segment 当作独立会话或独立节点

**Interaction DAG**:
由 segment 截断构造的多 agent 交互有向无环图；诊断 agent 沿边查看多 agent 的全局交互历史。它是运行时实时、确定性、append-only 形成的 L1 事实图，边仅表达 local continuation、emit 与 deliver。
_Avoid_: 只按单 session 视角组织群聊历史，或把投递事实解释为下游实际采用及致错

**Influence Graph（影响图，IG）**:
AIG 论文中的固定分区、单遍构建模式：先按既定规则把失败轨迹划成节点，再由模型补充 summary/input/output/authorship 与稀疏的 inherited/effect 影响边。它是从日志派生的 L2 解释图，不是 Interaction DAG，也不是另一份权威事实。在本系统中它对应可显式选择的非默认 `construction_mode=fixed_partition_single_pass_ig`，用于低成本构建、评测基线和 AIG 消融；AIG 失败时不自动改跑 IG，且 IG 不是 AIG 的输入。
_Avoid_: 将 IG 缩写用于 Interaction DAG、把模型影响边当通信事实、把固定分区 fallback 冒充论文 IG，或强制 AIG 先读取 IG

**Adaptive Influence Graph（自适应影响图，AIG）**:
AIG 论文中的 agentic 影响图模式：Builder 可根据一条失败轨迹联合选择节点边界、角色字段和非相邻影响拓扑，经只读 Critic 与可写 Refiner 核验修复后交给只读 Reader 归因。落地时是 Influence View 的默认 `construction_mode=adaptive_agentic_aig`，直接读取同一冻结 L0/L1 证据快照并从空图开始，不依赖 IG。
_Avoid_: 让 AIG Builder 改写 Interaction DAG、将通过 Critic 等同于成为全局因果事实、绕过原日志直接归因，或把 IG→AIG 当作默认流水线

**图有效性谓词（Phi(G)）**:
对 AIG/IG 图结构是否可采纳的确定性判定，不验证语义真实性或因果归因。`validator_profile=paper_exact` 用于论文评测，检查连通、无环、唯一 task 根与唯一 conclusion 汇，并版本化记录论文未明确的 connectivity 解释；`validator_profile=production_grounded` 用于生产，在 L2 引入虚拟 task root 与 observed-outcome sink，检查无环、弱连通和 root→sink 可达，并额外验证 evidence ref、watermark、content hash、ACL、时序及 omitted-range skip。两种 profile 都不修改 L1 Interaction DAG。
_Avoid_: 把 Phi-valid 读作 claim 已有证据、根因正确或可自动晋升 Fork/EvidenceBridge

**Influence View（影响视图，IV）**:
对 AO 与 Interaction DAG 的自适应 action-level 影响表示；以 task、outcome 或 diagnosis query 为目的组织 InfluenceBlock/InfluenceClaim，始终落回权威事实。它是 L2 解释层，不改写事实图。
_Avoid_: 把视图当权威事实、让 draft 进入检索、用 IV 替代 Fork/Branch

**Post-run Influence View（运行后影响视图 / 轨迹索引）**:
轨迹完成后围绕 task 与 observed outcome 生成的基础 InfluenceViewRevision（purpose=post_run_index）。定位是 **AO 台账的派生轨迹索引**而非又一层记忆：可重建（有 deterministic fallback）、随 session/task run supersede、自身不累积 citation/utility；其冻结 Block/Claim 可通过轻量投影参与 provisional 混合检索。
_Avoid_: 同步阻塞 task commit、索引完整视图或原始证据、声称已完成因果归因、当作与 L3 并列的第二层长期记忆

**Diagnosis Influence View（诊断影响视图，DIV）**:
以失败 outcome 和 diagnosis query 为目标、从基础 Influence View 派生或独立构建的 InfluenceViewRevision（purpose=failure_diagnosis），用于定位错误或决策如何传播并产生 Fork grounding。
_Avoid_: 把每条通用 post-run 视图都称为 DIV、直接进入 verified 通道

**Influence block（影响块）**:
Influence View 中表示一个 action-level 工作单元的节点；必须属于单一 participant，并引用同一 Segment 内连续的 AO 区间。一个 Segment 可拆成多个 Block，多 agent 或非相邻影响由 InfluenceClaim/subgraph 表达。Block 身份相对于视图，必须能落回原始证据。
_Avoid_: 跨 participant、跨 Segment 或合并不连续 AO；与稳定 ForkNode 身份等同；把所有 block 都当 fork

**Influence claim（影响主张）**:
Influence View 中从 source block 指向 target block 的有向主张，说明下游继承了什么产物以及产生了什么影响；初始是供导航和核验的解释假设。
_Avoid_: 与 EvidenceBridge 或 verified similarity edge 等同、仅因模型生成就视为已支持

**Influence grounding（影响定位）**:
ForkRevision 对某个冻结 Influence View 中 `block | edge | cut` 位置的证据映射；解释该 revision 在影响地图中的来源，但不决定 ForkNode 的稳定身份。
_Avoid_: 用 block/view ID 派生 ForkNode ID、要求所有 anchor 都严格对应单个 block

**Influence projection（影响投影）**:
冻结 InfluenceBlock 或 InfluenceClaim 的轻量检索卡片，保留语义摘要、类型、状态、embedding 与来源指针，不包含完整视图、原始 AO 或 critic 工作状态。
_Avoid_: 与完整 Influence View 混称、把 projection 当证据原件、索引 mutable draft

**Reader report（读取核验报告）**:
Reader 对冻结 Influence View 的已检查 Claim、证据引用、反例、候选 anchor 与未探索区域形成的不可变报告；作为因果综合阶段的输入。
_Avoid_: 在形成 Fork 结论后回写报告、把未检查路径写成已验证

**Summary-first evidence escalation（摘要优先证据下钻）**:
从轻量 projection 开始，经 Block/Claim 摘要、evidence synopsis，最终只对选中引用读取原始证据的渐进式核验方式。
_Avoid_: 命中上层对象就注入全部底层内容、永远停在摘要不核验事实

**轨迹索引服务（trajectory index service）**:
独立的服务端异步索引服务（与 outbox/aggregator 同模式），承担 post_run 视图生成：workspace 级预算与速率上限、队列优先级（evaluation > 失败轨迹 > 成功轨迹）、超限降级 deterministic fallback、可暂停。
_Avoid_: 由 EvaluationOrchestrator 顺带驱动、轨迹 commit 时同步建图

**因果检索初排**:
因果记忆检索为当前进入混合结果的卡片排序的方式。当前进入的是 fork/branch 和影响图投影。segment/atom 仍是 fact 卡片，暂停期间不进入混合结果。平时是纯 BM25；另一档把 BM25 与真实向量合成名次，没有真实向量时仍是纯 BM25。维度为 0 的向量占位不算向量档。
_Avoid_: 子串匹配、分数恒为 1、只按向量排序、向量不可用时交回空列表、把暂停理解成删除 AO 台账

**因果检索配额**:
一次因果检索最多 12 张卡片。默认 fork/branch 6 张、影响图投影 4 张、segment/atom 2 张。某一路没有卡片时，空位不让给另一路。暂停期间 segment/atom 这一路为空，一次结果最多 10 张，总帽仍是 12。
_Avoid_: 用别的语料把空位凑满 12、把总帽改成 10

**邻域展开**:
Memory Agent 从一张 claim 投影的卡片 id 出发，在该卡片所属的冻结 view 内只沿 `relation_type=influence` 读时拼出的有界路径。`skip` 留在 view 上，不踩过去；某一截只靠 skip 连着时，停在缺口这边。剩下的 influence 仍按两端登记、双向走。路径不另存成对象。诊断 agent 不使用这个工具。
_Avoid_: 让模型填写 view id 或 claim id、命中后自动展开、沿 skip 或 HypothesisBridge 或 EvidenceBridge 走、把双向走理解成连 skip 也要往回穿

**覆盖清单（coverage_manifest）**:
冻结 view 修订上的覆盖声明。字段是 `total_ao_range`、`inspected_refs`、`included_ranges`、`omitted_ranges`（每条有 `reason`）、`snapshot_watermark`。它和 block、claim 一起算进 `content_hash`。两条 claim 之间的空隙（上游 `ao_end_seq+1` 到下游 `ao_start_seq-1`）若与某条 `omitted_ranges` 重叠，这条边必须是 `relation_type=skip`，并且两端的 evidence 都非空。它不进检索，只在打开冻结 view、做 grounding 或证据下钻时读到。
例子：台账 ao-41…46 写发布脚本（b-script），ao-47…60 切流量（b-cutover），ao-61…70 省略（reason：切流后的日志抓取与重试，未改变发布状态），ao-71…75 看错误率（b-rate）。清单 total 41–75，included [41–46][47–60][71–75]，omitted [{61,70,reason}]。b-script→b-cutover 的空隙是 47…46，空，普通 influence。b-cutover→b-rate 的空隙是 61…70，落在省略区间，必须是 skip，两端各至少一条 evidence（ao-60、ao-71 是合法引用；校验只要求非空）。b-script→b-rate 若直连，空隙 47…70 跨过省略区间，也只能是 skip。若那 10 行不省略、并进 b-cutover[47,70]，则 b-cutover→b-rate 是普通 influence，图上没有这条 skip。
_Avoid_: 把清单当成检索卡片、把 omitted range 当成空区间、省掉 reason、把「跳过一个已收录 block」当成必须标 skip

**检索子图**:
commit 之后提取影响图时，由模型划出的一段动作及其 influence 边，写入冻结 view。诊断等这次提取完成，再用子图比历史子图。进行中不提取子图。Memory Agent 不持有提取工具，也不触发 diagnosis。不铸造 subtask_id。
_Avoid_: 进行中提取、Memory 调用诊断、按参与者整段切开、把子图当成会累积效用的子任务、用整张 view 当一条查询

**失败标记**:
提取模型写入检索子图的标记，表示其中某个结果是失败。诊断 agent 不改标记，只对带标记的子图发起检索。没有标记的子图不写 fork。
_Avoid_: 诊断时重判算不算失败、只用角色为 conclusion 的块、靠关键词猜测

**失败子图**:
一张 DIV 里，带有自己失败结论的检索子图。子图内部出现失败结果就成立，可以有多份。任务级的「发布失败」结论块不因此再单独发起一次检索。诊断 agent 对每一份各发起一次检索，各写一份普通 fork。以后分两次检索各命中一份，不绑在同一次结果里。它可以不调用。
_Avoid_: 只准一个结论块、把两份失败合成一份 fork、把两份 fork 绑成一组同次返回、没有失败结果的子图也写 fork

**诊断子图命中**:
一次失败子图检索返回的一份结果：一份历史检索子图，加上影响定位落在该子图内的 fork。fork 带七段快照和分支动作摘要，不带 guidance 全文，不带原始 AO。一次最多 3 份。同一张历史 view 的旁路子图不在其中。
_Avoid_: 只返回 fork 的 id、把 guidance 或原始 AO 放进命中、只返回分数最高的一份、用别的子图把不足 3 份补满

**依赖模式查询（dependency-pattern query）**:
以"想要的 artifact 与 effect"表达子目标的检索查询形态，匹配 InfluenceClaim 的 carried_artifact/downstream_effect 签名；命中后仅在同一冻结视图内沿 Claim 做有界邻域展开，"子任务因果链"是读时拼装。
_Avoid_: 铸造 subtask_id 跨任务合并引用或效用、把读时邻域持久化为对象、跳过四维适用性重排

**干预史（intervention history）**:
视图位置（block/edge/cut）上已提交 Fork/Branch 的反向索引视图：READ_VERIFY 阶段可读对应 Fork/Branch 轻量摘要与该分支验证状态。正向是 fork 自带的 grounding 字段（权威数据 + 内容寻址快照），反向是 outbox 维护的派生倒排索引——语义刻意不对称：反向读取必须逐条过 ACL、绝不改变 Claim 状态、不进 citation/utility。
_Avoid_: 实现成对称图边（分支成为节点出边）、把"此处有 validated 分叉"读作"该影响边被支持"

**Interaction event**:
群聊服务为每条消息发布的不可变权威事件（message_id、channel sequence、内容 hash）；各 agent 的 send/receive 分别入各自 AO 台账。
_Avoid_: 把同一消息的发送与接收合并成一个共享 AO 或共享 segment

**OpenViking 轨迹审计副本**:
OpenViking 对每个群参与 agent 的可采集历史轨迹保存完整、append-only、可审计的归档副本，并以稳定引用关联共享 interaction event 和 Interaction DAG；群聊 interaction store 仍是共享 event 与 DAG 的唯一权威。
_Avoid_: 将归档副本当作第二权威、用副本延迟改写 channel 顺序，或因群成员身份越过来源 session ACL

**AO 台账（action-observation ledger）**:
随 commit 默认建立的密集摘要层：每个 action-observation pair 一条（observation 用确定性 synopsis），全覆盖、不挑选；诊断 agent 分页读取、可下钻原文；fork 节点与 causal context 从中引用。
_Avoid_: 只摘要关键步骤、逐对全量过 LLM

**Causal context**:
fork 节点引用的、作为其归因依据的 AO pair 序列；由诊断 agent 回溯选定，可包含 hindsight（节点之后的）记录。
_Avoid_: 把 hindsight 选择冒充当时决策依据（解读时须区分）

**节点身份**:
fork node 以稳定锚点（ao / session_state 快照 / interaction_edge）派生永久 ID；同锚点重复诊断复用并追加不可变 revision。ao_id 全局唯一、永久不变，commit 只追加归属。
_Avoid_: 路径式 ID、仅内容 hash、archive 内自增编号作主键

### 提取与消费

**MemoryTaskState（记忆任务状态）**:
Memory Agent 为当前群聊任务维护的有界、可变、可过期状态，保存当前关注点、已尝试查询、带 provenance 的候选证据与未决问题；不属于长期记忆，也不是诊断证据本身。
_Avoid_: 与七段 Working Memory 混称、把缓存内容当作权威事实

**群 Memory Agent**:
一个 Workspace 的一名公开、稳定 Memory Agent。它由第一个能够创建它的新建群创建，显示名 Memory，初始 handle 为 `memory`，拥有自己的 identity 与 session；之后的新建群加入这一名。它不按 task 或 thread 临时创建，也不与 Builder/Critic/Refiner 的 run-scoped session 或 Reader/Diagnosis 的 phase-gated session 共享会话。它从所属群的消息起接收消息、归档自身轨迹，并按其 retrieval profile 工作。成员资格、profile 切换、改名、拒绝私有化，以及软删除后的新 identity，以 CONSENSUS `default-memory-agent/Q217–Q235` 为准。
_Avoid_: 每个新建群各建一名、延迟到首条用户消息才创建、按 task/thread 重复创建、自动把本决定之前的群补为成员、把 MemoryTaskState 当作该 agent 的长期身份，或借其长期 session 为构图/诊断角色继承上下文与权限

**Retrieval profile（检索角色配置）**:
某类 agent 在共享检索能力之上采用的角色特定探索约束，包括可检索对象、可走边、候选配额、排序偏好与停止条件。
_Avoid_: 因共用检索能力而假定 Memory 与 Diagnosis 必须采用相同探索策略

**Lane（检索通道）**:
统一检索入口内部的一条独立处理通道：它有自己的语义、信任边界和结果类型。不同 lane 可以共享入口以及 ACL、scope、watermark、父预算、deadline、取消和审计等横切治理，但不共享排名分数、结果配额、证据语义或 exposure/citation/utility 记账；当前两条 lane 是 `current_log_exact` 与 `memory_discovery`。
_Avoid_: 把 lane 当物理数据库、因共享 facade 就混成一个排名池、跨 lane 借结果名额，或让一种 lane 的命中自动取得另一种 lane 的证据等级

**T_log 证据检查接口**:
对固定 scope 与 watermark 内日志、AO、Segment、Interaction DAG 和冻结 Influence View 提供只读检查的 role-scoped adapter。完整检查词汇表为 `get_overview`、`read_full_log`、`read_step`、`read_step_range`、`list_agents`、`get_question`、`search`、`list_block_kinds`、`get_story`、`get_graph`；共享该接口不表示每个角色获得全部操作或论文原始返回内容。Memory profile 默认允许 overview/question、单步/有界区间，以及当前 scope 内冻结图的 story/graph 表示；`current_log_exact` 和 `query.exact` 不出现在其工具/API schema 中。`read_full_log` 仅显式 evidence escalation；`list_agents` 只返回可见 identity/role/capability；`list_block_kinds` 当前不向 Memory 开放。每次读取均以调用者 principal 重验 ACL，并按 summary-first escalation 计费审计。
_Avoid_: 把 `T_log` 当作全库权限、把论文 `list_agents` 的完整 system prompt 语义原样开放、借 Memory 群成员身份代查、返回 mutable draft/critic 私有状态，或与可写 `T_build` 混合

**T_log current-log search（当前日志精确搜索）**:
`T_log.search` 在固定 scope 与 pinned watermark 的当前步骤内容中做有界正则/文本匹配，返回按日志位置定位、可继续下钻的当前 evidence refs；它不以语义相似度发现历史经验，也不把命中本身计为 citation 或 utility。对拥有 exact capability 的非-Memory role，该能力按 `memory-search-entry/Q134-B` 作为单一 `retrieve(SearchPlan)` facade 内部的 `current_log_exact` 类型化 lane 执行，与 `memory_discovery` lane 共享 principal/ACL、scope/watermark、父级预算与审计，但不共享分数、TopK 配额、证据语义或记账。稳定群 Memory Agent 的能力合同中永久不存在该 lane 或 `query.exact`；其伪造/遗留/replay exact payload 依 `memory-agent-exact-removal/Q159-A` 在任何 dispatch、lease 或 audit construction 前被服务端拒绝。
_Avoid_: 把精确命中按语义 relevance 混成历史 prior、跨 watermark 搜索后伪装当前证据、另暴露第二个同名公共 search 工具，或因统一入口而把两个 lane 压成一个结果池

**Typed corpus adapter（类型化语料适配器）**:
围绕一种具有独立原生身份、状态与搜索语义的记忆对象族建立的只读接入边界；输出统一外形但保留 kind、native identity/status、source pointer、来源内 rank/score 与 audit ref 的 NativeMemoryCard。它只报告原生事实，不拥有中央 use-class、跨语料 allocation 或 public selection。
_Avoid_: 用整个 provider 已裁剪 facade 冒充 corpus adapter、在 adapter 内先截成 public TopK、抹平原生状态，或让 adapter 自报 candidate trust

**NativeMemoryCard（原生记忆卡）**:
类型化 corpus adapter 交给统一 memory-discovery coordinator 的内部候选信封；它归一传输形状但不迁移原始存储身份，也不把不同 corpus 的分数变成共同尺度。卡片在逐对象 ACL/current-status recheck 与中央 use-class classification 之前不具备 public candidate/prior 资格。
_Avoid_: 把卡片当新的权威副本、直接跨 corpus 比数值 score、跳过 admission recheck，或把 adapter 输出等同于已提供给 agent

**Discovery allocation envelope（发现检索分配信封）**:
`memory_discovery` 在 public cap 内分别为 `memory_candidate` 与 `analogical_prior` 划定的 seat 边界；当前 candidate 最多 8、prior 最多 4，总数最多 12。两类只在各自内部回填，不互借，因此 cap 是上限而不是必须填满的目标。
_Avoid_: 把新的 candidate/prior 8/4 冒充旧 verified/provisional 8/4、跨 use class 借位、因 underfill 将 prior 升级为 candidate，或让 exact lane 补 discovery 空位

**Corpus coverage floor 与 flex seat（语料覆盖底座与弹性席）**:
每个有 eligible cards 的 typed corpus 在所属 use class 中先获得一个 coverage floor；剩余 flex seats 按 corpus-local rank depth 在仍有候选的 corpora 间确定性分配，每 corpus 最多 4 席。同一 rank depth 的起始顺序由 plan hash、allocation policy version 与 use class 派生的 stable rotation 固定；它决定 selected set，不等于最终 public interleave。
_Avoid_: 比较异构 native score 分配 flex、让单 corpus 占满 class、把 floor 读作品质保证、让 final ranker 改写已分配 seat count，或用固定字母序制造长期偏向

**Corpus-local total order（语料内完整顺序）**:
单一 typed corpus 内由 native ranking features、显式 corpus policy 和 canonical identity 最终 tie-break 形成的完整顺序；必须有版本且任何两个 cards 都能唯一判定先后。它只支撑该 corpus 的 rank 与跨 corpus ordinal zipper，不使不同 corpus 的数值 score 可比较。
_Avoid_: 依赖数据库物理行序、容器/map iteration order 或 stable sort 的偶然输入序；把 corpus-local score当共同尺度；相同分数不加 identity tie-break

**Allocation membership freeze（分配成员冻结）**:
Q153 allocation 对 selected candidate/prior refs、探索 ref、seat reasons 生成内容寻址 `allocationHash`；final interleave 只能返回这两个 ref 集合的完整 permutation，不能删增、重复、跨 use class、重新截断或补位。
_Avoid_: 让 final ranker 成为第二个 allocator、因排序模型失败公开部分集合、用 rerank 改写 8/4/floor/ceiling，或让 duplicate replay按新 policy现场重算 membership

**Rank-depth zipper（按语料内名次深度交错）**:
在 candidate 与 prior 各自数组中，按 Q153 已冻结的 stable rotation，先依次输出各 corpus 的 selected local-rank1，再输出各 local-rank2，逐层继续；复用 allocation rotation而不派生第二套顺序。统一 exploration card 固定在 candidate 第一轮 exploitation 后；若无 exploitation则为 rank1。输出产生 class-local public ranks 与 `finalOrderHash`，不建立 envelope-wide rank。
_Avoid_: 固定 corpus block造成永久前置偏差、比较异构 score、让 exploration 永远第一或永远末尾、为 fact pause hole生成 placeholder card，或将 candidate/prior拼成一个 global list

**Class-local public rank（类别内公开名次）**:
Card 在 `memoryCandidateCards[]` 或 `analogicalPriorCards[]` 自己数组中的一基位置；只表达确定性展示顺序，不表示证据强度、utility、验证状态或执行资格。两个数组的 rank 不可互比。
_Avoid_: 宣称 candidate rank2 高于 prior rank1、把 publicRank 当跨 lane/global score、按 rank 自动采用 Hint，或让 prompt assembly擅自跨 class重排

**Pause-reserved hole（暂停保留空位）**:
某 corpus 被显式暂停时仍封存、不可由其他 corpus 回填的 public seat。当前 segment/atom 在 fact pause 期间保留一个 prior 空位，因此 discovery 最多返回 8 candidates + 3 priors；该空位表达暂停边界，不表示 lane failure。
_Avoid_: 静默将暂停席让给 projection/episode、把少于 12 误判为 terminated、继续假装沿用旧 2-seat fact quota，或隐藏 underfill 原因

**Discovery-wide exploration seat（发现检索统一探索席）**:
由 outer coordinator 在 candidate envelope 内拥有的最多一个探索位；eligible strata 是通过全部硬门的 visible provisional fork/branch 与 cold-start skill revision，先按 stratum、再按 card 做可重放 seeded draw。Skill stratum 继续受 rolling 10% exploration gate；无 eligible 时在 candidate class 内回填 exploitation。探索模式不改变对象的 use class、验证状态或 warning。
_Avoid_: 每个 provider/corpus 各自再扣探索席、让大 eligible pool 仅靠数量垄断、把 exploration 当质量升级、绕过 skill exploration rate，或无 eligible 时跨到 prior 回填

**Served-anchor expansion（已提供锚点扩展）**:
Initial `retrieve(SearchPlan)` 冻结后，由 Memory Agent 以 parent envelope 中真正 served 的 candidate 或 prior card 为 anchor，沿一个白名单 relation 做一 hop 的按需图遍历。它是同一 retrieval 深模块的 bounded traversal，不接受自由文本 query，也不是第二个 semantic search；prior 可导航到 candidate，但自身不升级。
_Avoid_: Initial retrieve 自动强制扩展、以数据库中存在但未 served 的对象作 anchor、把 redirect 当 expansion、一次暗走多 hop/relation，或因沿边到达提升 use class

**Derived retrieval envelope（派生检索信封）**:
Served-anchor expansion 产生的独立冻结结果；拥有自己的 operationId、planHash、child snapshot、allocationHash、finalOrderHash 与 auditRef，并通过受控 derivation proof 绑定 parent envelope、anchor 与 relation。Parent envelope 永不原地修改；只有 completed derived envelope 真正 served 的 candidates 才能驱动 Hint/Offer。
_Avoid_: 把 expanded cards 尾插回 parent arrays、复用 parent hash 冒充同一时刻、让 terminated partial进入public、引用 prior anchor直接发Hint，或只凭 known/active target绕过envelope membership

**Expansion chain（扩展链）**:
由 E0→E1→E2 构成的有界派生序列；每步只能用上一 completed envelope 已 served card作anchor，one relation/one hop，并受10分钟TTL、默认4步/硬上限8步、累计30个unique served与task parent budget治理。换semantic query必须新建`retrieve(SearchPlan)`，不能用旧redirect。
_Avoid_: 将chain ref当bearer credential、把unused parent child budget自动转给下一步、任一步失败改写已完成ancestor、无限多hop，或让close summary取得citation authority

**Child expansion snapshot（扩展子快照）**:
Expansion dispatch时由服务端签发、绑定parent envelope、anchor、bound principal/scope与native graph watermarks的读取快照。它显式晚于或不同于parent snapshot；serving前仍重验current ACL/withdrawal/status，duplicate replay返回冻结结果而不是按当前图重算。
_Avoid_: 假装expansion与parent处于同一时刻、让agent自报snapshot、anchor撤回后继续读邻居、同operation重试时换新图结果，或把raw watermark当访问能力

**SearchableStepView（可搜索步骤视图）**:
在固定 scope/snapshot 下，为一个 AO 临时组装的只读、权威解析字段视图。`action` 是稳定序列化的 canonical action projection，`observation` 是可授权解析的 raw observation，`message` 是由 channel authority 解析的正文；每个实际可搜索表示绑定 representation kind、content hash、snapshot 与 withdrawal state。无法授权或解析的字段省略，synopsis 不冒充 raw content。
_Avoid_: 把临时视图持久化成第二权威、把 message 归档副本替代 channel authority、把 synopsis 无命中解释为 raw 中不存在，或泄露不可见字段数量

**ExactSearchSlice（精确搜索切片）**:
ScopeSnapshotResolver 从 opaque scope/snapshot refs 解析出的有序、capability-bound 搜索输入，限定单个来源 session/channel range、冻结水位、可用 content resolver、evidence ACL 与 withdrawal policy。切片顺序是 exact ref canonical order 的第一层；持有切片不授予超出其 principal/scope/snapshot/child-operation 的读取权。
_Avoid_: 把 raw path/watermark 当 bearer credential、让 matcher 自行打开任意 store 或签发新 snapshot、执行中重排 session 范围

**RE2-compatible exact regex（RE2 兼容精确正则）**:
Current-log exact lane 允许的版本化、线性时间 regex dialect；排除 backreference、lookbehind 等不能保证线性复杂度的特性，并受表达式长度、child budget、deadline 与 cancellation 约束。Unsupported syntax 在扫描前作为 invalid input 拒绝；literal 模式始终完整转义表达式。
_Avoid_: 直接运行 host backtracking regex、把 compile error 当零命中、在 literal 模式解释元字符，或用 row 间 cooperative check 冒充可中断单次危险 match

**Exact public hit（精确搜索公开命中）**:
Current-log exact lane 在固定 snapshot/scope 中定位、经 source evidence ACL 与撤回检查后返回的唯一 CurrentEvidenceRef；身份按 source session、AO 与 matched field 去重，同一字段的多个 occurrence 合并为有界、按 offset 排序的 spans/fragments，并携带该实际搜索表示的 `totalOccurrences`、`spansTruncated` 与 content hash。`spansTruncated` 只表示一个 field 内还有未列出位置，lane audit 的 `truncated` 表示还有未返回的独立 refs；public hit limit 只限制 refs，不限制内部 scan 或授权范围。不可见匹配不占 public limit，也不暴露过滤数量。
_Avoid_: 按每次 regex occurrence 重复占位、返回全部 spans 绕过单 ref 大小边界、混淆 field 内与 lane 级截断、在 ACL 前截断、把内部分页上限当 public hit ceiling，或用返回数量泄露隐藏匹配

**Lane-local result quota（通道本地结果配额）**:
按 `memory-lane-quota/Q142-A` 分别约束 current-log evidence refs 与 memory-discovery cards 的独立结果名额；一条 lane 的空位不得被另一条借用或回填，各自独立计算 returnedCount 与 truncated。它是输出数量约束，不是父级控制预算、token 预算或执行 deadline。
_Avoid_: 建跨 lane global TopK、借空位推测另一 lane 候选密度、让日志命中挤掉历史候选或反之，或把结果 quota 与 budget lease 混称

**Retrieval child budget（检索子预算）**:
按 `memory-control-budget/Q143-A` 在 lane dispatch 前从父 `budgetLeaseRef` 派生、只允许特定 lane 核销的服务端能力；exact 与 discovery 使用独立 child leases 和各自适合的 resource meters，unused budget 不跨 sibling 借用。它限制执行成本，不改变该 lane 的 result quota；具体 meter 与余额只进受控 audit。
_Avoid_: 用一个伪统一 token 比较异构资源、first-come-first-served 抢父池、把 unused child budget 变成另一 lane 的结果名额，或因持有 lease ref 就跳过 principal 重验

**Retrieval deadline tree（检索截止时间树）**:
按 `memory-deadline/Q144-B` 由一次 retrieve 的 parent absolute deadline 与 dispatch 时冻结的 lane child deadlines 构成的时间约束；child 不得晚于 parent，effective deadline 取二者更早值，所有分页/IO/子调用复用 remaining duration 而不重置 timeout。Deadline 来自 server-bound context，精确时间只进受控 audit。
_Avoid_: 每个 adapter hop 重获完整 relative timeout、让 child 延长 parent、使用可倒退 wall clock 计算剩余时间，或由 agent 在 SearchPlan 中自报 deadline

**Retrieval cancellation tree（检索取消树）**:
按 `memory-cancellation/Q145-A` 将 client/orchestrator/parent-deadline/server-shutdown 等 parent cancellation fan-out 到全部运行中 lanes，而 child-local deadline、budget 或 dependency termination 只终止本 lane、sibling 继续的控制结构。公共 reason 采用 first-terminal-cause-wins，secondary signals 留 native audit；底层 adapters 必须合作停止，不能留下 orphan work。
_Avoid_: 任一 child 终止就取消独立 sibling、parent 取消后只停止等待却继续后台执行、把 lane-local failure 冒充 not_dispatched，或公开 terminated lane 的中间 hits

**SearchPlan（检索计划）**:
群 Memory Agent 按 `memory-search-schema/Q135-A`、`memory-search-schema/Q136-B`、`memory-exact-trigger/Q140-A` 与 `memory-exact-limit/Q141-B` 提交给单一 `retrieve` interface 的版本化、可幂等请求；携带 operation identity、共享 semantic intent、可选 dependency pattern、显式 typed exact clause、可选且只能下调服务端 ceiling 的 exact public-result limit，以及服务端签发的 opaque scope/snapshot/budget refs。Refs 只声明既有能力范围，服务端仍以绑定 principal 重验授权并对含 canonical limit 的规范化 plan 计算 hash；同 operation identity 下内容漂移必须拒绝。Lane 由 query clause presence 确定性触发：semantic input 触发 `memory_discovery`，exact clause 触发 `current_log_exact`，两者都有则都触发，均无则 plan invalid；无额外 requestedLanes 或隐藏 trigger classifier。
_Avoid_: 让 agent 自报 workspace/principal/ACL 或完整 session 范围、把 opaque ref 当 bearer authorization、用活会话隐式状态替代固定 snapshot、把 semantic intent 自动解释成 regex，或在 clause 已存在时由预算/隐藏 policy 静默改为 not_dispatched

**Memory retrieval use class（记忆检索使用类别）**:
统一 retrieval module 按 `memory-search-schema/Q137-B` 依据版本化中央 policy，将 native memory card 分类为 `memory_candidate`、`analogical_prior` 或 `excluded` 的消费语义；分类综合 kind、状态、same/cross-task、evidence status、synthetic、executable、offer eligibility 与 provenance 完整性。Adapter 只报告原生事实，无权自我提升 use class；任何 memory card 都不能被分类成 current evidence。
_Avoid_: 将 kind 永久等同于 use class、让各 adapter 自行定义 candidate、隐藏 provisional/synthetic 状态，或因相似度高把历史对象升级为当前证据

**Unified retrieval envelope（统一检索信封）**:
`retrieve(SearchPlan)` 按 `memory-search-schema/Q135-A`、`memory-search-schema/Q137-B` 与 `memory-envelope/Q138-A` 返回的版本化载体；最小公共 metadata 只含 schemaVersion、operationId、planHash、duplicate、canonical resolved scope/snapshot/budget refs、use-class policy version 与受控 auditRef。结果机器级分为 `currentEvidenceRefs[]`、`memoryCandidateCards[]`、`analogicalPriorCards[]`；每张 card 保留 native identity、状态与 lane-local score，但无跨 lane global score/rank。精确 timing/budget、ACL labels、excluded counts、adapter topology 和事件时间线仅进受控 audit plane。
_Avoid_: 返回无类型 `results[]`、增加混淆逻辑 operation 的 retrieval attempt ID、泄露 adapter ACL labels/父预算/excluded 数量、让 OpenViking selection audit 冒充 lane audit，或把业务 response 变成 observability dump

**LaneAudit（检索通道审计摘要）**:
按 `memory-envelope/Q139-B`、`memory-lane-quota/Q142-A` 与 `memory-partial-hint/Q146-B` 为每条 `current_log_exact|memory_discovery` lane 返回的正交状态：`executionState=not_dispatched|completed|terminated`、`resultState=none|empty|hits`、稳定 `reasonCode`、public `returnedCount`、lane-local `truncated`、非敏感 `featureVersions` 与 opaque `nativeAuditRefs`。未调度、执行后零命中与提前终止必须机器可分；returnedCount/truncated 只解释本 lane且不因另一 lane 空位改变。Public policy 固定 terminated lane 为 `resultState=none,returnedCount=0`，其中间 hits 仅可留 native audit；completed sibling 正常公开。
_Avoid_: 用单一组合 status 造成枚举爆炸、内联 adapter 事件时间线/eligible set、返回 ACL/classifier 排除数、用 `returnedCount=0` 同时表示未执行和零命中，或把 terminated 中间结果公开为稳定 TopK

**Retrieval completeness（检索完整性）**:
按 `memory-partial-hint/Q146-B` 从本次已 dispatch lanes 的冻结 LaneAudit 派生的 `complete|partial|unavailable`：全部 completed 为 complete，一部分 completed 且一部分 terminated 为 partial，全部 terminated 为 unavailable；not_dispatched 不进入分母。它不是 agent 自评，也不是 source object 的 validated/provisional/confidence 状态。
_Avoid_: 因 exact 未被 query 触发就标 partial、把 completed+empty 当失败、让 composer 自报完整性，或新增会与 LaneAudit 漂移的手填顶层状态

**Served-only grounding（仅已提供来源接地）**:
Memory Hint/Offer 的每个 source 必须是指定冻结 RetrievalEnvelope 中由 completed `memory_discovery` lane 公开提供的 `memory_candidate`，并在生成时重验 target principal、ACL 与 current status；数据库中存在、被历史 exploration 看过或仅是 analogical prior 都不够。
_Avoid_: 允许 direct offer 绕过 envelope、引用未公开/terminated/excluded card、把 current evidence 当 memory source，或只让 LLM 写 provenance 字符串

**Hint retrieval provenance（提示检索来源）**:
绑定 Memory Hint/Offer 到冻结 retrieval 的服务端验证结构，至少包含 retrievalEnvelopeRef、operationId、planHash、派生 completeness、contributing/incomplete lanes、laneAuditHash 与 served sourceCardRefs。Partial/complete 与 incomplete-lane set 参与 delivery dedup，使后续 complete Hint 不被先前 partial Hint 吞掉；unavailable retrieval 不生成该 provenance。
_Avoid_: 用 operationId 取代 source membership 校验、把每次重复 retrieval 强制变成新 Hint、让 complete→partial 覆写较完整投递，或将精确 timing/budget/ACL labels 内联

**Selected raw AO 下钻**:
角色具备按需物化少量原始 AO 的能力，不等于启动时把 scope 内全文注入上下文。Reader/Critic 必须拥有该 capability 才能形成强证据结论，Builder 按需，Refiner 仅限 violation 邻域，Memory/Diagnosis 在 projection→summary→synopsis 后显式升级；不可读时结论只能是 insufficient/redacted。
_Avoid_: 全量预加载 raw AO、因具备 capability 就自动读取、用 synopsis 猜测 supported，或让普通 task agent 默认跨 session 下钻

**角色化经验检索（role-scoped experience retrieval）**:
Builder/Critic/Refiner/Reader 与群 Memory Agent 共用同一检索深模块，但各自携带自己的 role、principal、scope、pinned watermark、SearchPlan 与预算；图角色不得直接调用有状态的群 Memory Agent。返回结果硬分为当前证据 `current_evidence_refs[]` 与历史类比 `analogical_prior_cards[]`，后者只能提出待查机制或反例，不能支持当前 AIG Claim。
_Avoid_: 让 MemoryTaskState 成为构图输入、借 Memory capability 代查、将历史 Fork/AIG 洗成当前证据，或让四个角色共享同一自然语言 Memory 回复

**AoGroundingService（AO grounding 服务）**:
AIG Builder 只用 snapshot-scoped opaque row handle 选择步骤区间与证据，服务端唯一写入口将其解析为 ledger 中真实 canonical AO，校验 principal ACL、watermark、content hash、participant/session/segment、连续性与 overlap，并派生 SourceRef/EvidenceRef 后原子冻结和注册视图。
_Avoid_: 让模型铸造或直接持久化 `ao_id`、允许未解析 SourceRef 绕过该入口，或把语义边界选择也固定成每 Segment 一块

**Hypothesis bridge（假设桥）**:
由模型提出并作为全局长期边保存的跨 lane 暂定关联，用于所有任务继续探索潜在相关节点；表达“值得检查”，不表达已验证相似、来源证据或因果关系。活跃边可被遍历，inactive 边退出普通遍历但保留历史判断与审计。
_Avoid_: 当作 evidence bridge 或 verified similarity edge、仅因被遍历或长期存在就升级为事实

**Evidence bridge（证据桥）**:
由直接 provenance 或经服务端验证的诊断提议形成、可支撑 fork 归因的跨 lane 关系。
_Avoid_: 由 citation 数量自动晋升、把模型假设直接当证据

**Verified retrieval channel（已验证召回通道）**:
承载 EvidenceBridge、权威 ForkRevision 等已通过相应验证门槛对象的独立召回通道。
_Avoid_: 与 provisional 对象无标签混排

**Provisional retrieval channel（候选召回通道）**:
承载 HypothesisBridge、ForkCandidate 等待验证对象的独立召回通道；可全局发现，但始终保留候选状态。
_Avoid_: 因高引用量伪装成 verified 对象

**Citation edge（引用边）**:
任务 run 明确引用某个 Memory Hint 或其来源对象时形成的关系；每次 replay、continuation 或真实 run 的引用都作为不可变事件保留并等权贡献初始 reference value，物化强度可随事件年龄衰减；与采用后的结果效用分开。
_Avoid_: 将曝光当引用、将引用强度当 outcome utility 或因果证明

**索引级曝光（index-level exposure）**:
Influence 投影卡片被检索命中并进入 agent 可见上下文时记录的曝光事件；仅供离线召回质量评估，不计 citation、不进 fork_node_id 聚合与 utility；只有经过 grounding、成为 ForkRevision 或 Memory Hint 来源后才进入因果账本。
_Avoid_: 与 Memory Hint 的 exposure 混同、让索引命中沿"被看见→被引用→排名上升"回流因果账本

**In-task reference strength（任务内引用强度）**:
引用方 task lineage 与被引用记忆的来源 task lineage 相同时，由全部 citation events 等权累加并经时间衰减形成的强度；表达同一任务内的持续相关性。
_Avoid_: 因样本相关而丢弃 replay/continuation 的重复引用、冒充跨任务可迁移性

**Cross-task reference strength（跨任务引用强度）**:
引用方 task lineage 与被引用记忆的来源 task lineage 不同时，由全部 citation events 等权累加并经时间衰减形成的独立强度；表达记忆跨任务被持续引用的程度。
_Avoid_: 与任务内引用强度压成一个分数、把跨任务引用当 outcome utility

**Diagnosis brief（诊断简报）**:
一次诊断开始时冻结的不可变交接材料，引用任务范围、候选证据、未决问题及其读取快照；它提供诊断起点，但不替代被引用的权威证据。
_Avoid_: 把活 agent session 当作权威恢复状态、把简报视为额外读取授权

**Handoff envelope（交接信封）**:
服务端为 Memory↔Diagnosis 交接持久化的不可变、内容寻址载体，保存输入 manifest hash、版本、引用、watermark、预算与 ack/checkpoint；可与活 session 并存，用于重试、幂等和崩溃恢复。
_Avoid_: 将 bearer credential 写入信封、重复投递重复产生副作用、用活会话记忆替代服务端幂等

**Diagnosis outcome（诊断结论）**:
一次诊断 run 结束时持久化的不可变交接产物：引用输入 brief hash、ForkRevision/bridge refs、未决问题、waiting conditions、预算与版本；是 Memory 建立下一 run MemoryTaskState 的权威输入。
_Avoid_: 覆写历史 outcome、绕过内容寻址与幂等键直接消费

**Task lineage（任务谱系）**:
由不可变 task_id 标识的任务传承线；仅权威 orchestrator 可铸造，replay/continuation/baseline/恢复 run 继承原 ID。引用方与记忆来源 lineage 不同即构成跨任务引用。
_Avoid_: 按任务文本 hash 合并谱系、agent 自铸或改写 task_id

**Evaluation orchestrator（评估编排器）**:
独占 Memory→任务运行/评分→DiagnosisBrief→诊断→ForkRevision 提交→下一 run 状态迁移的服务端组件；Memory/Diagnosis 只能提交 trigger/schedule proposal。
_Avoid_: 让 agent 自行创建评测 run、自行扩预算或越过状态机

**Step reward（步骤奖励）**:
对单个 assistant step 的局部质量评价，可用于定位值得进一步分析的区间；它是诊断信号而非因果结论。
_Avoid_: 将最低分步骤直接认定为根因或 fork point

**Causal diagnosis（因果诊断）**:
结合轨迹、结果与对照证据识别分叉决策及可迁移机制的归因过程；可提出 fork node、真实或想象分支及跨树关系。
_Avoid_: 与逐步骤打分混为同一职责、把相关性信号当成因果证明

**Fork draft（分叉草稿）**:
Causal diagnosis 在单次 run 内形成、尚未经过服务端 schema、引用、ACL 与 provenance 校验的暂态分叉表达；不进入全局检索。
_Avoid_: 直接作为全局 ForkCandidate、视为权威记录

**Fork candidate（分叉候选）**:
服务端已接纳的 `ForkRevision(status=provisional)` 的对外角色：全局可检索、可被 Memory Hint 引用，但因果结论仍待 replay、continuation 或真实轨迹验证。
_Avoid_: 与未校验 ForkDraft 混称、因进入权威存储而视为已验证

**Fork validation status（分叉验证状态）**:
ForkRevision 对其因果结论所处阶段的标记：provisional、validated 或 invalidated；状态变化通过追加 superseding revision 表达，不覆写历史。
_Avoid_: 把“服务端已接纳记录”和“因果结论已验证”混成一个状态

**Memory Hint（记忆提示）**:
Memory Agent 通过 `memory@target_agent` 向某个任务 agent 发送的 task/run-scoped、有类型、带来源与置信状态的终端消费事件；按 `memory-partial-hint/Q146-B`，其 sources 必须是 completed `memory_discovery` lane 在冻结 RetrievalEnvelope 中公开的 memory candidates，并携带服务端验证的 Hint retrieval provenance。Exact-only current evidence 与 analogical prior 不能直接成为 source；exact lane terminated 但 discovery completed 时可发带 incomplete-lane provenance 的 partial Hint，discovery terminated 或 retrieval unavailable 时不发。服务端生成 `hint_id`。频道正文是 Hint 内容，目标另收到 `hint_id` 与 `memory_disposition`。用来投递 Hint 的 Memory Offer 就是这次投递。被点名的任务 agent 决定是否采纳，Hint 不可执行，也不作普通检索入口或 explore 中转节点。
_Avoid_: 作为 ForkNode 可变字段、伪装成 executable skill、隐藏候选/partial 状态、允许 direct offer 绕过 served-only grounding、自动采用 guidance、Hint→Hint 多跳

**Memory disposition（记忆处置）**:
被点名的任务 agent 通过原生工具 `memory_disposition` 对某个 Memory Hint 作出的结构化决定：adopt、reject 或 defer。只有这次工具调用是回执。它记录采纳意图，不证明后续行为或结果。调用顺序、citation 与失败分类见 CONSENSUS 的 `memory-disposition-receipt/Q190–Q216`。
_Avoid_: 由 Memory Agent 代判、把自然语言提及或频道回复当回执、把 adopt 直接当正向效用、由服务端推断采纳

**Followthrough（采纳履行）**:
目标 agent 作出 adopt 决定后，其后续 action 与 Hint guidance 的版本化行为谓词匹配结果：observed、partial、not_observed 或 contradicted。
_Avoid_: 用 agent 自报替代行为证据、反向改写原始 disposition

**Debiased reference signal（去偏引用信号）**:
根据 seeded exploration 的 eligible set 与 selection propensity，对曝光选择偏差作离线校正后形成的版本化引用评价信号；用于下一版策略，不即时修改当前排序。
_Avoid_: 覆写原始 citation、把同一批在线反馈立即回灌当前 policy

**Control contract（对照契约）**:
配对 replay/continuation 验证时冻结 anchor/state、任务输入、agent/model/prompt、工具与依赖、权限、预算、版本化 outcome measurement policy 与结果来源的实验契约；treatment 与 baseline 的唯一计划差异是目标 Memory Hint/guidance。
_Avoid_: 仅凭任务文本相同就称为独立对照、把生成模型自报成功当客观 outcome，或把结果测量重新包装成 promotion Evaluator

**子集充分性（subset sufficiency）**:
多改动分支的必要性归因证据：在同一 ControlContract 下对预声明改动子集做配对 replay 的结果（subset_sufficient / not_sufficient）；只作该 branch 的 supporting evidence，不能单独满足 validated 门槛；仅适用于过 replay 投资六门槛且 diff 含 ≥2 处可分离改动的高价值分支。
_Avoid_: 用模型标注代替对照、新造多锚点 cause_set 身份、在节点上记录根因

**Seeded exploration（种子化探索）**:
在 provisional 召回配额中，以记录下来的 seed 从通过硬门槛但低曝光或高不确定候选里选择可复现探索项的机制。
_Avoid_: 全部按热门度利用、不可复现随机、跳过 ACL/适用性硬门槛

**Proposal**:
归因产出的候选技能提案；可被检索，被其他 context 采用时记录效用事件。经服务端 schema、ACL、provenance、content hash 与幂等完整性校验后自动进入 Agent Evolution，不再经过独立 Evaluator approval，并原子产生 `published_active_skill_revision`，立即具备在线检索与执行资格。
_Avoid_: 让 Diagnosis 直接写 skill、把完整性校验冒充质量批准，或把 active 资格误读为已具正效用/必然高排名

**Guidance**:
分支的组成部分：执行分支时参照若干轨迹节点生成的稳定指导，不独立检索，只随分支召回；同时保留指向 DIV block/claim/cut 的 semantic basis 与指向 AO/Segment/raw evidence 的 factual basis，分支可不参照 guidance（对照组）。
_Avoid_: 用 DIV 引用替换直接事实引用、只列 AO 而不表达影响机制、把 guidance 当作插入会话中间状态的消息（不可 replay 任务中仅 append 到 session 尾部）、为 guidance 建独立检索入口

**独立 Evaluator（已移除）**:
旧设计中版本化、独立于 proposal 生成模型且独占 executable skill 批准的尾门；Q11-C 已将该角色与 approval transition 移除，不能再作为现行晋升前置条件。Critic、Reader、客观 outcome、Fork 验证门槛与服务端完整性校验不属于该旧角色，仍然保留。
_Avoid_: 用新名称偷偷重建同一独立 approval agent，或反过来把 Evaluator 移除解释为无需证据、验证与完整性校验

**Agent Evolution**:
Executable skill 的唯一发布与更新通道；完整性校验后的 Diagnosis proposal 自动进入该通道，并原子产生不可变的 `published_active_skill_revision`，立即具备适用 scope 内的在线检索与执行资格。active 只表示资格，不表示已具正效用、必然高排名、强制被选中或绕过常规 ACL、安全、兼容性与撤销硬门。
_Avoid_: 与 proposal namespace 合并、让 Diagnosis 绕过该通道直写 skill，或把 active 资格误读成质量批准、正效用或无条件全局启用

**Replay**:
在可重放任务中重新执行轨迹以产生分支轨迹的能力；可否 replay 由 daemon 七步判定（来源完整、状态可重建、工具版本、副作用隔离、凭据、非确定性、预算），不由调用方自称。

**Skill invocation chain（技能调用链）**:
某个具体 `skill_revision_id` 在下游 task/run 中从 `eligible → offered → selected → invoked → applied → followthrough → objective_outcome` 形成的不可变事件链；每个实际调用以 `invocation_id` 关联 task、run、context/cluster 与版本化 outcome policy。只有链上真实发生的阶段可被记录，缺失阶段不得由后续成功倒推补齐。
_Avoid_: 把 offer/exposure/citation 当实际调用、把 session 级成功平均发给所有候选、让生成方自报补全 followthrough 或 outcome

**Utility evidence grade（效用证据等级）**:
具体 skill revision 的效用证据分为 `observational` 与 `counterfactual`：唯一 applied revision 后出现可观测结果形成 observational evidence；满足 ControlContract 的配对 replay/continuation 相对基线差异形成更强的 counterfactual evidence。多个 revision 同时 applied 且无法逐一消融时只记录 `confounded_set` 联合证据，不向每个 revision 复制完整正效用。
_Avoid_: 把 observational 相关性称为因果证明、将 confounded set 等分或全额归功、忽略 evidence grade 混成一个样本

**Context-conditioned utility posterior（上下文条件效用后验）**:
针对 `(skill_revision, context/cluster)` 维护的局部效用分布；低样本局部后验向该 revision 的全局层级先验有限收缩，observational 与 counterfactual 证据按各自可靠度进入。正常 exploitation 使用保守下置信界 `utility_LCB`，全局聚合只作先验与异质性视图，不覆盖局部反例。
_Avoid_: 用全局平均替代 context 适用性、让每个 context 完全孤立无法冷启动、仅按 posterior mean 排名而隐藏不确定性

**Utility evidence freshness（效用证据新鲜度）**:
每条普通 outcome utility evidence 的时间权重按 evidence grade 与版本化策略衰减并回归中性 prior；revision 本身不设按年龄失效的 TTL。新同类结果、context/cluster 漂移、工具/模型/schema 变化或证据撤回立即触发受影响证据重验，不等待自然半衰期；历史事件永久保留审计。
_Avoid_: 仅因发布时间久就判 skill 错误或删除、让旧正向证据永久垄断排名、让时间自动洗掉严重安全事件

**Active revision cold start（active revision 冷启动）**:
新 `published_active_skill_revision` 立即具备在线资格，但以中性 utility prior 进入独立 seeded-exploration 配额；选择必须记录 eligible set、seed、selection propensity 与曝光/调用上限。积累跨多条 task lineage 的最小可归因 outcome 证据前不得进入正常 exploitation 竞争，高不确定性只提高探索资格，不直接抬高利用分。
_Avoid_: 把 active 当高分、用 proposal 生成质量伪造初始效用、让探索挤占正常 exploit 配额或由同一重复任务快速制造假高分

**Skill quarantine（技能隔离）**:
可信的严重安全、权限越界、provenance integrity 破坏、撤销或 executable incompatibility 事件触发的即时资格硬门，使 revision 退出在线检索与执行；只有版本化服务端 verifier、安全策略、撤销事件或授权管理员可直接触发，Memory/Diagnosis/普通 task agent 只能提交带证据 proposal。它不能靠时间衰减自动恢复；普通任务失败、低收益或纠正只进入负向 utility posterior，并以最小有效样本、置信阈值和 hysteresis 控制降权与恢复。
_Avoid_: 把严重事件稀释进平均 utility、允许任意 agent 凭自然语言直接关闭全局 revision、单次普通失败立即停用，或让排名波动自动解除 quarantine

**效用（utility）**:
由独立异步 aggregator 维护、按具体 skill revision、context/cluster 与 evidence grade 聚合的跨会话统计；正向效用仅来自完整 invocation chain 上的 applied + observed followthrough + objective outcome，或满足 ControlContract 的配对相对改善。exposure、offer、citation/reference strength 与生成方自报不计效用；confounded 多 skill episode 不生成各 revision 的独立正效用。
_Avoid_: 写回归档、commit 时同步更新、把引用强度/曝光/offer 当效用，或隐藏 attribution grade 与样本不确定性

**Per-corpus dual-retrieval fusion（按语料双路融合）**:
同一 typed corpus 内分别取得 BM25 top-32 与 vector top-32，按 canonical native identity 去重并集后，以等权 `RRF(k=60)` 形成版本化 corpus-local total order；任一对象可由任一路发现，RRF 只使用各自名次而不混合 BM25/cosine 原始数值。每个 corpus 的向量路径必须给出 vector completeness proof；proof 缺失、向量异常或不可用时，仅该 corpus 退化为 BM25 top-32 的确定性 local order，其他 corpus 不受影响。该顺序仍须经过中央 ACL/status、use-class、allocation 与 interleave，且不产生跨 corpus 的共同分数。
_Avoid_: 以 BM25-positive 作向量候选门槛、把不同 corpus 的分数混成全局尺度、因一个 corpus 向量失败而重跑整个 discovery lane、把同一对象的双路命中变成两个 public seats

**Diagnostic subgraph typed retrieval text（诊断子图类型化检索文本）**:
诊断历史子图检索在保持 BM25-only 的前提下，以既有 block/claim prose 后追加受限、canonical 的类型化 token：子图失败状态、block role、block kind、block failure 标记、claim relation type、claim failure 标记及 relation profile。缺失 metadata 显式写作 `unknown`；token schema、值规范化、字段顺序和文本策略版本共同冻结。不得包含 ID、AO 范围、raw AO、guidance、provenance/evidence ref、ACL/security metadata 或隐藏候选信息；类型化 token 仅是词法检索信号，不是因果或当前 Claim 证据。
_Avoid_: 为了检索加入原始证据或可识别 ID、因字段缺失而静默改变文本形状、把 token 命中当机制已验证、或偷偷添加 vector/结构评分层

**Memory Agent exact-lane removal（Memory Agent 精确日志通道移除）**:
稳定群 Memory Agent 的能力合同中永久不存在 `current_log_exact`：其可见请求是只含 `intentText`/`dependencyPattern` 的 `MemoryDiscoveryPlan`，可见响应只有 `memoryCandidateCards[]`、`analogicalPriorCards[]` 与 discovery audit；不含 `query.exact`、literal/regex、exact limits、`CurrentEvidenceRef`、exact lane audit、exact child lease/deadline/cancellation 或 exact completeness。伪造/legacy/replay exact payload 在任一 lane dispatch 前以 stable capability-absent error 拒绝。Q134–Q146 的 exact 分支对此 role 为 `N/A`，但对其他授权角色保持不变；恢复必须经新的 ADR。
_Avoid_: 把移除描述成 not-dispatched/paused、在 Memory response 中留下零值 exact array 或 audit、用兼容 shim 静默剥离 exact、因移除 Memory exact 而删除非-Memory 当前证据核验

**Coforge Episode/Insight discovery retirement（Coforge Episode/Insight 发现检索退役）**:
Coforge Episode 与 Insight 从所有新的 `memory_discovery` 候选池、public arrays 与 public expansion 中移除，并在 central use-class classification 前标记为 `retired_from_memory_discovery`；它们不再是 candidate、prior、anchor、target 或 Hint/Offer source。退役不删除 native records、provenance、历史 envelope/Hint/citation/outcome 或审计；每次新 serving/expansion 均重验 current status。Coforge `SkillRevision` 不退役，继续作为 active/current 条件下的 memory candidate，并保留 Agent Evolution 的 executable registry、stable URI、lineage、utility、quarantine 和任务侧执行语义。
_Avoid_: 将 retired object 当 pause hole 重新分配 seat、删除历史审计、让旧 envelope 重放重新暴露对象、把 SkillRevision 与 Episode/Insight 同等删除，或让未来 factual-memory corpus 静默继承其信任/配额

### 假设层与簇

**已验证相似边（verified similarity edge）**:
连接两个 fork-node revision 的语义相似关系，带四维判定 provenance；簇成员资格的唯一依据。
_Avoid_: 用 embedding 余弦直接当相似结论、连通分量自动传递相似性

**跨树簇（cluster）**:
以某 fork node 为中心、成员与中心均有已验证正向相似边的可重叠集合；一个 fork node 可属多个簇。
_Avoid_: 隐含相似性传递、原地合并/拆分（只创建 successor）

**簇条件效用**:
特定簇内某分支模式 / skill revision 的效用；全局效用只是其带样本量与异质性的聚合视图。

**Forecast contract**:
想象分支生成时冻结的语义检查点集合（结果类别、中间状态谓词、动作类型序列、失败模式、比较窗口）；预测-实际对比的判定基准。
_Avoid_: 逐 action 精确匹配、把 context 差异计作想象失败

**有效置信度**:
校准置信度 × 新鲜度因子（fresh 1.0 / needs_revalidation 0.5 / invalidated 0.0）；变质由证据基础失效驱动，不由时钟。
_Avoid_: 未校准自评作排序权重、纯 TTL 过期

**诊断档案（diagnosis dossier）**:
承载增量再诊断的可恢复结构化状态（anchor、判定、簇连接、想象分支及证据基础、未决问题）；取代持久化活 agent。

**稳定性资格（replay investment eligibility）**:
想象分支获得 replay 投资须同时满足的六项可审计门槛；只影响既有合规候选的排序，不引入新 skill。

### 行为模式

**Legacy 模式**:
原始 OpenViking 行为——无轨迹节点抽取、无投影、无 guidance。
_Avoid_: 用多个独立 boolean 组合表达新旧行为

**Causal 模式**:
启用轨迹节点抽取、投影、proposal、replay、guidance 与效用统计的行为模式；session 创建时固化所属模式，切回 Legacy 保留历史数据与审计但停止写入与消费。新建群在创建时强制以 Causal 模式固化，使第一条群事件起即可进入轨迹归档。
_Avoid_: 用多个独立 boolean 组合表达新旧行为，或在群首次检索后才开启而遗漏开端轨迹


## 2026-10-10 Fork/AIG 当前模型（Q166–Q189）

本节覆盖本文件中所有把 **InfluenceClaim**、`cut` grounding、独立 L3 ForkRevision 或 Diagnosis 作为 Fork 生成者描述为现行模型的旧术语。它们只可用于只读 legacy 审计，不能进入新写模型、GuidedBranch、StrategyPattern 或当前检索。

**AIG 原生边（AIG-native edge）**:
冻结 AIG 内由较早 Block 指向较晚 Block 的继承/影响关系；它是图结构而不是可独立检索、可独立验证或可被 grounding 的 Claim 对象。边可保留最小机制注记，但不承载 Claim 生命周期。
_Avoid_: InfluenceClaim、把边当作事实因果结论、以边作为新 Fork grounding

**ForkNode overlay**:
挂载于一份冻结事实 AIG revision 的反事实覆盖节点，以唯一 `anchor_block_id` 连接事实 Block；它不改写 base revision，也不是 AO-derived Block。Reader 在报告冻结后只可提交 ForkProposal，服务端验证并持久化。
_Avoid_: 独立于 AIG 的新写 ForkRevision、将 ForkNode 当事实 Block、Diagnosis 直接写 Fork

**BranchStepRef（分支步骤引用）**:
未来分支中的一步，只能是同一 base revision 的不可变 `factual_block_ref`，或 branch-local 的 `imagined_node`。imagined node 永不进入事实 AIG；其后真实执行所产生的 AO 必须经新的 post-run indexing 才成为事实 Block。
_Avoid_: 复制事实 Block、把 imagined node 提升为事实节点、跨 base revision 直接复用 Block

**CounterfactualStrategyPattern（反事实策略模式）**:
由服务端基于 Reader 的结构化 proposal 生成的、非事实的反事实策略身份；它只聚合字段严格等价的 imagined-node 经验。语义相近但字段不等价的模式仅能作为检索近邻，不能自动合并证据。
_Avoid_: Claim、AIG Block、把向量相似度当作模式同一性

**Branch evaluation（分支验证）**:
追加在不可变 imagined node 或 StrategyPattern 上的证据账本条目。证据可为 production-direct、replay-direct、analogical、observational 或 model-only；类比证据只调整估计置信度，永不构成直接验证。
_Avoid_: 覆写或删除原 imagined node、把相似 Fork 当直接因果证据

**First-action alignment（首行动对齐）**:
imagined branch 与 replay/remediation branch 间的版本化判定。只有 `equivalent` 或 `functionally_equivalent` 的首行动可成为 direct evidence；后续 outcome 的直接性还取决于前缀/整支对齐深度。
_Avoid_: 仅凭文本或 embedding 相似度支持/反驳 imagined branch、把替代策略成功当原策略验证

**Replay eligibility（重放资格）**:
ForkNode 创建时对 anchor 状态、依赖、权限、隔离副作用、预算和 evaluator 的可恢复性评估；可为 replayable、conditionally_replayable 或 non_replayable，并可在环境变化后追加重评。replay 产生独立的 Replay AIG，不改写原生产事实 AIG。
_Avoid_: 假定所有 Fork 可 replay、把 replay 事实混入原生产轨迹

**GuidedCounterfactualBranch（引导式反事实分支）**:
一种可生成行动指导的 ForkNode branch。它由 Reader 在可信诊断与历史先例检索后提出；已批准的 GuidanceDocument 由 Memory 在群聊中发布并定向交接给服务端选择的目标 agent。
_Avoid_: 让 Memory 自行归因或写 Fork、把 Guidance 当独立事实 AIG 节点、将建议视为已执行

**GuidanceDocument（指导文档）**:
服务端冻结的、Reader 批准的 remediation 指导，含目标角色、能力限制、证据、适用条件、风险与来源 Fork。Memory 只能发布已批准内容；自动 dispatch 仍受服务端 ACL、能力、权限、预算、幂等和安全 policy gate 约束。
_Avoid_: Memory 自由补写行动步骤、绕过 Reader 或服务端验证、用自然语言消息替代审计记录

**TaskOutcomeAssessment（任务结果评估）**:
Reader 对可信 AIG 提交的 `success | failure | uncertain` 结论；服务端以 OutcomeEvidencePolicy 和冻结 OutcomeContract 裁决其是否为 confirmed failure。明确 evaluator/test/acceptance 证据优先于 Reader 的纯语义推断。
_Avoid_: Critic 判断任务成败、将图违规当任务失败、只凭 Reader 推断自动 remediation

**OutcomeContract（结果契约）**:
任务启动时冻结的成功标准、验收/evaluator 绑定、SLA/policy 约束与来源；缺失时 Reader 只能形成 provisional criteria，结果必须保持 uncertain，不能自动 dispatch。
_Avoid_: 任务结束后由 Reader 重写成功标准、把开放式推断当 confirmed failure

**GuidanceExecutionReport（指导执行报告）**:
linked remediation run 对 GuidanceDocument 的结构化履行记录，逐项映射 imagined node 与实际 Block，并标明 equivalent、functionally_equivalent、divergent 或 not_executed。只有对齐的实际 Block 可回流为 production-direct evidence。
_Avoid_: 以“已完成”的群聊回复代替事实证据、把执行偏离自动写成策略反证

**Legacy Claim/Cut data（旧 Claim/Cut 数据）**:
旧冻结 revision 与旧 Fork 的只读审计数据，保留原 content hash 与原语义；不自动转换成新 Block grounding，不参与新 Pattern 或 GuidedBranch 演化。需要迁移时必须创建新 ForkNode 并保留 `migrated_from_legacy_fork_id`、原 grounding 快照和迁移理由。
_Avoid_: 物理删除历史、静默把 edge/cut 伪造为 Block、永久双写新旧模型
