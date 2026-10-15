# Round 9（griller: kiro / gpt-5.6-sol）——Memory/Diagnosis 共享检索与职责边界

设计树状态：Q1–Q49 已确认。本轮从“Memory Agent 与 causal Diagnosis Agent 是否复用跨 fork node、跨 segment 的混合检索”展开，区分共享机制、角色策略、工作状态与交接边界。

❓ **Q50** - **共享检索到哪一层？**

- A. 一个 typed retrieval facade，下面分 fork/branch、segment/atom、generic memory adapter；两个 agent 使用不同 profile。
- B. 一个合并索引、统一 TopK、统一 expand 和统一停止策略。
- C. 只复用向量/BM25，图探索、ACL、预算和审计各自实现。

➡️ 推荐 A。

---

❓ **Q51** - **Memory Agent 的可变任务状态是否独立命名为 MemoryTaskState？**

它不是七段 Working Memory，不是长期记忆事实，也不是诊断证据权威；它可以缓存带 provenance 的检索结果，并具有 task/run scope 与过期条件。

➡️ 推荐确认。

---

❓ **Q52** - **Memory → Diagnosis 的交接载体是什么？**

- A. Memory Agent 的活 session 和完整可变状态。
- B. 服务端从 MemoryTaskState 冻结、过滤并补齐版本信息后生成的不可变 DiagnosisBrief。
- C. 只传一句自然语言请求，由 Diagnosis 重做全部检索。

➡️ 推荐 B。

---

❓ **Q53** - **谁有权启动 causal diagnosis run？**

- A. Memory Agent 直接创建并授权 Diagnosis Agent。
- B. Memory Agent 只提交 DiagnosisTriggerProposal，由服务端按策略、权限和预算创建 run；也允许用户显式触发。
- C. 只能由用户显式触发。

➡️ 原推荐 B。设计者进一步澄清 Diagnosis 主要用于评测阶段的归因、replay/continuation、生成 fork node、反事实想象及跨树连接，因此该题需要结合评测编排重新表述，尚未最终关闭。

---

❓ **Q54** - **Step-reward scorer 与 causal fork diagnosis 如何建模？**

- A. Step-reward scorer 是独立前置评测器，只向 causal diagnosis 提供候选定位信号；只有 causal diagnosis 可生成 fork node。
- B. 不保留独立 scorer，由 causal diagnosis 直接分析整条轨迹。
- C. 同一 agent 在一次 run 内同时输出 step rewards 与 fork revisions。

➡️ 推荐 A。

---

❓ **Q55** - **群聊中的身份如何划分？**

- A. 两者都是后台辅助 agent。
- B. 两者都是普通 channel member。
- C. Memory 是群聊成员，Diagnosis 是后台 per-run agent。

➡️ 推荐 C 或更保守的 A。


---

## 当前 frontier

❓ **Q56** - **causal diagnosis、replay/continuation 与权威 fork revision 的生命周期顺序是什么？**

- A. `step-reward/最终结果 → causal diagnosis 生成不可检索 ForkCandidate → 服务端选择 replay 或 continuation 验证/补证 → causal diagnosis 定稿 → 服务端提交权威 ForkRevision → 异步投影可检索`。
- B. causal diagnosis 先提交一个可检索 ForkRevision，再由 replay/continuation 产生后续 revision。
- C. 不建立 ForkCandidate；必须等 replay/continuation 全部结束后，diagnosis 才第一次表达分叉结构。

➡️ 推荐 A。它同时保留“评测中先归因和实验”的意图，以及“只有服务端验证后的权威 revision 才进入长期检索”的边界。ForkCandidate 只是 diagnosis-run 内、ACL 保护、不可检索的暂态产物。

---

❓ **Q57** - **MemoryTaskState 按什么身份与生命周期隔离？**

- A. 每个 channel 一份持续状态，所有任务共享。
- B. 每个显式 `task_id` 一条 lineage、每个 `run_id` 一份可变状态；跨 run 只复用带 provenance 的 refs/摘要，不延续活状态。
- C. 每条用户消息创建一份，用完即删。

➡️ 推荐 B。它既支持“同一任务多次 run”，也避免频道中并行任务互相污染；不同任务只能通过长期记忆检索关联。

---

❓ **Q58** - **共享检索下，权限与预算是否也共享？**

- A. Memory 与 Diagnosis 共用 credential、trajectory 和余额。
- B. 二者各有独立 capability、pinned SearchPlan 与子预算，受同一个 task/evaluation 父级总上限约束；每次跨 ref/边重新检查来源 ACL。
- C. 权限独立，但预算完全不设父级上限。

➡️ 推荐 B。共享内核不等于共享授权；父级上限防止两个 agent 分别合法却合计失控。

---

❓ **Q59** - **Memory Agent 的跨图探索边界是什么？**

- A. 命中 fork/branch 后可沿 verified-similarity edge 最多一跳；命中 segment/atom 后可沿当前 SearchPlan 内的 Interaction DAG；禁止把两类边交替组成无界 walk，也不把相似性当传递关系。
- B. 可以在 fork、cluster、segment 间自由多跳，直到模型判断停止。
- C. Memory 只能做直接向量检索，不能 expand。

➡️ 推荐 A。Memory 可以多路探索，但每种边保留自己的语义和预算；`A~B、B~C` 不能推出 `A~C`。

---

❓ **Q60** - **fork node 作为“类似 skill 的记忆”时，向任务 agent 暴露什么？**

- A. 直接伪装成 executable skill，按 guidance 自动执行。
- B. 返回有类型的 `Memory Hint`：匹配理由、锚点状态、已观察分支/结果、适用 guidance、证据/置信状态和稳定 skill URI（若存在）；显式标注不可执行，由任务 agent 决定是否采用。
- C. 只返回 fork_node_id，让任务 agent 自行读取所有原始证据。

➡️ 推荐 B。fork node 是因果证据记忆，不是 executable skill；只有 Evolution 发布的稳定 skill URI 才能进入执行通道。

---

❓ **Q61** - **同任务与跨任务 run 的检索迁移门槛如何区分？**

- A. 相同 `task_id` 是强排序特征但不是自动适用证明；跨任务先做近似召回，再按任务/决策类型、锚点状态、失败机制、行动与 skill 角色四维重排。在线重排不创建 verified similarity edge，只有 causal diagnosis 可持久化该边。
- B. 相同 task_id 自动采用；不同 task_id 禁止召回。
- C. 不区分同任务与跨任务，只按 embedding 分数排序。

➡️ 推荐 A。这样既支持同任务多次 run，也允许机制相似的跨任务迁移，同时不让在线 Memory Agent 污染跨树图。


---

## Q56/Q59 细化后的当前 frontier

❓ **Q62** - **“可检索 ForkCandidate”具体对谁可见？**

- A. 三层可见性：①同一 `evaluation_id/task lineage` 的 Memory Agent 可检索，用于下一次 replay/continuation；②其他 causal Diagnosis Agent 可在 ACL 允许的 candidate corpus 中发现它作为待验证参照；③普通跨任务 Memory Agent 只能检索已权威提交的 ForkRevision。候选永远带 provisional 状态，不能进入 executable-skill 通道。
- B. ForkCandidate 生成后立即进入普通全局 Memory 检索，只靠 `provisional` 标签区分。
- C. 仅生成它的 Diagnosis Agent 能读，后续 Memory Agent 通过 handoff 直接收到，不经过检索。

➡️ 推荐 A。它满足多轮评测的 Memory→Diagnosis→Memory 循环，也避免一个尚未验证的归因污染所有真实任务；同时让跨任务 Diagnosis 能发现潜在重复模式。

---

❓ **Q63** - **Memory 的“多路探索”是否先拆成两条并行 lane，而不是一条可任意换边的路径？**

- A. 拆成两条 lane：`Interaction lane` 从当前 run 的 atom/segment 出发，沿 local_continuation/emit/deliver 重建多 agent 上下文；`Causal-memory lane` 从 query/state 出发，检索 ForkCandidate/ForkRevision/branch/cluster/skill。两个 lane 独立计候选、跳数和停止条件，最后由 Memory Agent 在 MemoryTaskState 中归并；跨 lane 只能走显式 typed bridge。
- B. 建一个统一异构图，Memory Agent 可在 segment、fork、cluster、skill 之间自由选择下一条边。
- C. 每次只能选择一个 lane，不能同时探索。

➡️ 推荐 A。所谓“同一套混合检索”应统一 session、ACL、预算和结果 envelope，而不是抹平边语义。选定 lane 架构后，下一轮再分别确定：允许哪些 typed bridge、fork similarity 可走几跳、Interaction DAG 的方向与深度，以及何时停止。


---

## Bridge、子 agent 与跨任务评价 frontier

❓ **Q64** - **跨 lane 的 typed bridge 采用哪种契约？**

- A. 只允许由权威 provenance 派生的白名单关系：`Segment/AO --diagnosed_as--> ForkCandidate/ForkRevision`、`Fork/Branch --evidence_from--> AO/Segment`、`MemoryHint --derived_from--> Fork/Branch/Skill`。可在 ACL 允许时反向读取，但保留原关系语义；每次过桥单独计预算并重验来源 ACL。embedding 相似只能产生同 lane 候选，不能自动创建 bridge。
- B. 模型认为有关即可在任意两种节点间创建临时 bridge，并继续多跳。
- C. 禁止跨 lane；两个 lane 只能最后做文本摘要合并。

➡️ 推荐 A。bridge 的作用不是限制信息融合，而是回答“为什么允许从这个 fork 跳到这个 segment”，并把 provenance、方向、ACL 和预算附着在这次跳转上。

---

❓ **Q65** - **causal-memory lane 派发子 agent 时，分片单位和输出职责是什么？**

- A. 每个一次性 `InteractionPathWorker` 负责一条有界 interaction path/subgraph，而不是一条消息：输入是 entry segment、允许的 edge sequence、相关 AO/fork refs、watermark 与子预算；只返回结构化 `assessed_refs + mechanism + applicability + contradictions + evidence_refs`，不直接写 fork、相似边或 utility。主 Memory/Diagnosis agent 归并；≤3 worker，共享总预算。
- B. 每个 interaction event 派一个 agent，各自自由扩展和提出 fork。
- C. 每个 participant session 派一个 agent，读取其完整历史后自由总结。

➡️ 推荐 A。单 event 缺少因果上下文，整 session 又过宽；有界 path/subgraph 更接近“一个多 agent 交互机制”。它也能复用 Round 8 已定的不可变 brief + ACL 隔离 map-reduce。

---

❓ **Q66** - **“跨任务被引用”如何计入 ForkCandidate 的价值，才能避免自证循环？**

- A. 分开记录四层信号：`exposure`（被展示，0 utility）、`citation`（被任务 agent 明确引用，只计 reference_value）、`adoption`（实际采用其 guidance）、`outcome`（真实任务成功/无纠错，或配对 replay/continuation 相对基线改善，才计 outcome_utility）。检索排名可以看到 reference_value，但必须与 outcome_utility 分栏，并做曝光归一化；citation 本身不能把 candidate 晋升为权威 fork/skill。
- B. 每次被检索或引用都直接增加统一 utility，并提高后续排名。
- C. 完全忽略引用，只认最终成功结果。

➡️ 推荐 A。跨任务 citation 确实能评价“是否值得关注”，但不能证明“是否有效”；否则全局曝光的 provisional candidate 会形成 `排名高 → 被看见 → 被引用 → 排名更高`。replay、continuation 与真实跨任务 run 可进入同一评价账本，但保留既有来源质量系数和原始 provenance。


---

## 动态 bridge、citation strength 与 worker cap frontier

❓ **Q67** - **模型动态创建的跨-lane bridge，是否与权威证据边分成两个状态？**

- A. 分型：`HypothesisBridge` 由模型在当前 retrieval/diagnosis run 中创建，可继续多跳并进入审计/checkpoint，但只表示“值得探索”；`EvidenceBridge` 由已有 anchor/evidence provenance 或服务端验证产生，可持久化并支撑 fork 归因。HypothesisBridge 若要晋升，必须由 causal diagnosis 提交证据并走 propose→validate；不能因被遍历/引用自动晋升。
- B. 不分型；模型创建的 bridge 立即作为持久图边，与 anchor/evidence edge 同权。
- C. 都不持久化，权威证据引用也只在 query 期间存在。

➡️ 推荐 A。它保留 Q64=B 的自由跨-lane 探索，同时不把“模型觉得相关”偷换成“已有因果证据”。

---

❓ **Q68** - **跨任务 citation edge 的端点、去重和 strength 如何定义？**

- A. 每次明确引用形成不可变 `TaskRun --cites(role)--> MemoryRef` 事件；同一 task lineage 对同一 ref+role 最多贡献一份独立 cross-task citation，replay/continuation 的重复引用记录但不重复增加独立任务数。聚合 strength 以不同 task lineage 数为主，并按 exposure 做归一化；与 adoption/outcome 分栏。来源 task 与 fork 的原始 task 相同则记 same-task reuse，不算 cross-task strength。
- B. 每次模型输出中出现 ref 都把 strength +1，包括同一 task 的 replay/continuation 重复引用。
- C. citation edge 直接连接 ForkCandidate↔ForkCandidate，不记录引用它的 task/run。

➡️ 推荐 A。否则多跑 replay 就能人为放大 edge strength，也无法区分“很多独立任务都认为相关”和“一个任务反复自引用”。

---

❓ **Q69** - **“最多 5 workers”是哪一级的上限？**

- A. 每次 Memory→Diagnosis→Memory 评测迭代统一最多 5 个并发一次性子 agent，InteractionPathWorker、sub-diagnosis worker 和其他并行 explorer 共用槽位；各角色仍有更小 profile cap，且总 token/tool/path 预算不因 worker 数增加。
- B. 仅 causal-memory lane 最多 5 个 InteractionPathWorker；Diagnosis 仍可另派 ≤3，其他 lane 另计。
- C. 每个 dispatcher 都可各派 5 个，只限制单层 fan-out。

➡️ 推荐 A。统一 parent cap 能防止嵌套 fan-out 变成 5×5；它限制的是并发执行数，不替代总预算账本。


---

## 双维引用与 HypothesisBridge 生命周期 frontier

❓ **Q70** - **in-task / cross-task 两维引用强度如何聚合与用于排序？**

- A. 底层保留全部 citation events；物化两个 policy-versioned 分数：`in_task_reference_strength` 中同一 task 的真实 run/replay/continuation 每次引用都贡献，但按来源质量和重复序号递减；`cross_task_reference_strength` 按不同 task lineage 聚合，每个 lineage 对同一 ref+role 最多贡献一个有效独立权重。两维不预先压成全局标量，由 Memory/Diagnosis retrieval profile 分别组合。
- B. 两维都直接使用原始引用次数，所有事件等权。
- C. 存储时立即合成一个统一 citation score，检索只看该分数。

➡️ 推荐 A。它确保同一任务第 2、3 次 replay 引用仍然增加 in-task 价值，同时不会等价于新增两个跨任务样本；保留双维也允许同任务 replay 优先看 in-task、陌生任务优先看 cross-task。

---

❓ **Q71** - **HypothesisBridge 在多轮评测中的活跃生命周期是什么？**

- A. 以 `evaluation_id/task lineage` 为活跃 scope：可从本轮 MemoryTaskState 经 checkpoint/handoff 带到后续 replay/continuation run；evaluation 结束后只保留审计记录，不再作为普通全局可遍历边。若要长期活跃，必须晋升 EvidenceBridge。
- B. 创建后立即成为全局长期可遍历的 hypothesis edge，所有任务都可继续沿它多跳。
- C. 仅当前 run 有效，下一次 replay 也必须重新发现。

➡️ 推荐 A。它支持 Memory→Diagnosis→Memory 的多轮连续探索，又避免未验证模型关联永久污染全局图。注意这不限制 ForkCandidate 本身按 Q62 全局可检索，只限制其动态跨-lane 假设桥。

---

❓ **Q72** - **沿 HypothesisBridge 多跳时采用什么硬边界？**

- A. 每条探索 path 最多跨 2 条 HypothesisBridge、最多 12 个总实体、禁止重复节点/边；每个端点必须重新与原始 query/MemoryTaskState 做直接适用性检查，间接路径不能自动产生 verified similarity、citation 或 EvidenceBridge。5 个 worker 共享该总路径预算。
- B. 不设固定跳数，由每个 worker 自己判断停止。
- C. HypothesisBridge 只能走一条，禁止连续使用。

➡️ 推荐 A。两跳足以实现“从当前 interaction 找到 fork，再由 fork 探索另一条 interaction”的跨-lane发现；直接重验防止相关性随路径漂移。


---

## 时间衰减与全局 HypothesisBridge 治理 frontier

❓ **Q73** - **citation 的时间衰减函数如何定义？**

- A. 原始 citation event 永不修改；读取物化强度时使用 policy-versioned 指数衰减 `weight(age)=2^(-age/half_life)`。in-task 与 cross-task 各自配置 half-life，可由 workspace 收紧；策略变化重算投影、不改原始事件。
- B. 固定滑动窗口，窗口外引用直接不计分。
- C. 定期把存量计数乘折扣并覆写，丢弃单条事件年龄。

➡️ 推荐 A。指数衰减连续、可审计，且保留未来修改 half-life 后重算的能力；两维分开配置可让 task 内热度更快衰减、跨任务复用更慢衰减。

---

❓ **Q74** - **全局 HypothesisBridge 与 EvidenceBridge 是否采用隔离的召回配额和排序通道？**

- A. 分通道：EvidenceBridge/ForkRevision 进入 verified quota，HypothesisBridge/ForkCandidate 进入 provisional quota；hypothesis 的 citation/时间衰减只影响 provisional 通道内部排名。最终结果可混合展示，但必须保留状态标签和每类上限，不能仅凭引用量压过全部 verified evidence。
- B. 全部进入同一个排序列表；引用强度足够高的 HypothesisBridge 可以无条件压过 EvidenceBridge。
- C. HypothesisBridge 不参与首轮召回，只能从已命中的 verified 节点扩展得到。

➡️ 推荐 A。它保留全局 hypothesis 的发现能力，同时防止廉价生成的模型边淹没昂贵验证的证据边。

---

❓ **Q75** - **如何控制全局 HypothesisBridge 的图膨胀？**

- A. 服务端验证 endpoint/type/ACL；按 canonical endpoint pair + relation type 聚合去重，同时保留每次模型 judgment 事件；设置 per-run 写入配额和 per-node active-edge cap。超过 cap 时最低“直接相关性 × 时间衰减 × 引用强度”的边转 inactive，仅退出遍历索引，审计记录不删除。
- B. 每个模型判断都永久新增独立活跃边，不限出度。
- C. 定期物理删除旧边和 judgment 事件。

➡️ 推荐 A。它把“完整审计历史”和“可遍历活跃图规模”分开，避免长期运行后每个节点拥有无界出边。

---

❓ **Q76** - **citation/traversal 能否自动把 HypothesisBridge 晋升为 EvidenceBridge？**

- A. 不能。in-task/cross-task 引用强度与 traversal count 只能提高再次诊断或验证的优先级；晋升必须由 causal diagnosis 提交直接 evidence refs、关系语义与反例检查，再走 propose→server validate。引用某个 endpoint 时，只有 citation provenance 明确包含 bridge_id，才给该 bridge 计引用，不能抬高该节点的全部相邻桥。
- B. 达到 citation strength 阈值自动晋升。
- C. 只要被跨任务引用一次就晋升。

➡️ 推荐 A。大量 agent 相信一个关联仍然是关注信号，不是因果或证据真实性证明。


---

## ForkCandidate 状态模型与默认参数 frontier

❓ **Q77** - **全局可检索 ForkCandidate 与权威 ForkRevision 的边界如何表达？**

- A. 三阶段：①`ForkDraft` 仅 diagnosis-run 内；②服务端完成 schema、anchor/ref 存在性、ACL、provenance 与幂等校验后形成全局可检索 `ForkRevision(status=provisional)`，对外称 ForkCandidate；③获得因果验证证据后追加 `ForkRevision(status=validated|invalidated)`。权威表示“记录及来源被服务端接受”，validated 才表示“因果结论得到支持”。
- B. 模型原始输出未经服务端验证即可作为全局 ForkCandidate；通过全部因果验证后才第一次形成权威记录。
- C. ForkCandidate 与 ForkRevision 是完全独立对象，晋升时复制内容并删除 candidate。

➡️ 推荐 A。它避免“全局可检索但不在权威存储”的悬空状态，也把存储可信度和因果可信度分开；revision 追加而非复制删除，符合既有 append-only/supersedes 模型。

---

❓ **Q78** - **citation 指数衰减的默认 half-life 是多少？**

- A. `in_task = 7 days`、`cross_task = 90 days`；workspace 可配置但只能在有版本的 policy 中修改，历史事件按新 policy 重算投影。
- B. 两维都 30 days。
- C. 不给系统默认值，每个 workspace 必须先配置才能启用 citation 排序。

➡️ 推荐 A。同任务 replay/continuation 通常集中发生，热度应快速衰减；跨任务复用代表更长期的迁移价值。默认值只是初始策略，后续应以离线评估校准。

---

❓ **Q79** - **verified/provisional 双通道的默认召回配额是多少？**

- A. 每次最多 12 个轻量候选：默认 verified 8、provisional 4；任一通道不足可回填空位，但输出至少保留对象状态、来源通道和原始通道内 rank。Diagnosis profile 可在总数不变下调整配额，Memory profile 使用默认值。
- B. 固定各 6 个，不允许回填。
- C. 不设通道配额，合并后统一取 Top 12。

➡️ 推荐 A。它让全局 candidate 有稳定探索份额，又让 verified evidence 保持多数；回填避免冷启动时浪费上下文。

---

❓ **Q80** - **HypothesisBridge 的默认写入与活跃度上限是多少？**

- A. 每个 evaluation iteration 最多新增/更新 12 个 endpoint-pair hypothesis judgments；每个节点最多 32 条 active outgoing HypothesisBridge；超限按治理分数转 inactive。workspace 只能收紧，不能放宽全局安全上限。
- B. 每轮 5 条、每节点 5 条。
- C. 不设固定默认，仅依赖总 token/tool 预算。

➡️ 推荐 A。12 与既有轻量候选/实体预算对齐，32 给跨任务探索留出多样性，又能限制长期图出度；完整 judgment 历史仍保留。


---

## ForkRevision 验证、循环停止与排序 frontier

❓ **Q81** - **provisional ForkRevision 何时变成 validated 或 invalidated？**

- A. `validated` 必须同时满足：①provisional 阶段的 anchor/ref/ACL/provenance 仍有效；②至少有一条原始 observed branch；③至少一个独立对照支持——同一可重建状态的配对 replay/continuation 显示预期差异，或另一真实 run/task 在可比较状态下出现机制一致的分支；④causal diagnosis 完成四维适用性与反例检查；⑤无高严重度未决矛盾。高质量可比较证据反驳核心机制则 `invalidated`；证据不足继续 provisional。各 imagined/observed branch 仍保存自己的验证状态。Citation 单独不能改变该状态。
- B. in-task 或 cross-task citation strength 达阈值即可 validated。
- C. 服务端完成 schema/ACL 校验后立即 validated。

➡️ 推荐 A。它把“记录合法”“很多人引用”和“因果机制得到对照支持”保持为三件不同的事。

---

❓ **Q82** - **Memory→Diagnosis→Memory 多轮评测何时停止？**

- A. 对每个 ForkCandidate，任一条件触发停止本轮主动实验：状态进入 validated/invalidated；replay/continuation eligibility 不通过；候选父预算/时间/分支上限耗尽；连续 2 个 iteration 未获得新 evidence refs 或未改变任何关键判断。预算耗尽或无信息增益时保持 provisional，并在 diagnosis dossier 记录 waiting conditions；未来真实证据事件可重新触发，不保持活 agent。
- B. 只要仍是 provisional 就持续 replay，直到变成终态。
- C. 固定只运行一次 diagnosis，不做循环。

➡️ 推荐 A。它允许“不确定”作为合法结果，避免为了关闭状态而无限消耗评测资源。

---

❓ **Q83** - **inactive HypothesisBridge 如何重新激活？**

- A. 新 model judgment、明确包含 bridge_id 的 citation、adoption/outcome 或 direct relevance 重验事件触发重算治理分；该边重新进入节点 top-32 且当前 ACL 有效时生成 `reactivated` 状态事件并回到 active。单纯 traversal/exposure 不触发；EvidenceBridge 晋升走另一条 propose→validate 路径。
- B. inactive 永不恢复。
- C. 每次被遍历就自动恢复 active。

➡️ 推荐 A。inactive 是活跃索引容量状态，不是删除或因果否定；恢复仍需新信号和容量竞争。

---

❓ **Q84** - **verified/provisional 通道内部如何排序？**

- A. 先执行硬门槛（ACL、状态、freshness、直接适用性），再使用 policy-versioned、role-specific reranker：verified 侧以语义相关、evidence quality、outcome utility、新鲜度为主，citation 为辅；provisional 侧以语义相关、直接适用性、hypothesis judgment 一致性、时间衰减后的 in-task/cross-task reference strength 为主。保存 feature breakdown、模型/policy 版本和确定性 tie-break；Memory 与 Diagnosis 可使用不同权重，但不改变 8/4 配额。
- B. 所有特征合成一个固定全局线性分数，两个 agent 共用。
- C. 完全交给 LLM 看候选文本自由排序，不保存特征与版本。

➡️ 推荐 A。它兑现“共享检索机制、分离角色策略”，并让一次排名能够复现和审计。


---

## 独立对照、引用归因与 provisional 探索 frontier

❓ **Q85** - **“独立对照”采用怎样的冻结实验契约？**

- A. 每次验证冻结 `ControlContract`：同一 anchor/state snapshot、任务输入、agent/model/prompt policy、工具与依赖版本、权限、预算和结果 evaluator；treatment 唯一计划差异是获得目标 Memory Hint/guidance，baseline 不获得它。Replay 在隔离环境执行配对分支；continuation 从同一冻结 anchor 创建 sibling continuation。非确定性无法锁定时使用配对 seed 或有界重复并报告方差；生成 ForkCandidate/Memory Hint 的模型不得担任结果 evaluator。无法满足关键冻结项时，该运行只能作为 supporting evidence，不能单独满足 Q81 的 independent control。
- B. 只要两个 run 的 task 文本相同，就视为独立对照，不冻结模型、工具、预算或 evaluator。
- C. Diagnosis Agent 主观判断两条结果可比较即可，无需持久化契约。

➡️ 推荐 A。否则模型升级、工具变化或预算差异都可能被错误归因给 Memory Hint。

---

❓ **Q86** - **什么行为分别构成 exposure、citation 与 adoption？**

- A. `exposure` 由检索服务在 Memory Hint 实际进入 agent 可见上下文时记录；`citation` 仅在 task agent 输出结构化 `{memory_ref, role=considered|applied|rejected|compared}` 时记录，文本中偶然出现 ID 或仅被塞入 prompt 不算；`adoption` 是 citation(role=applied) 加上后续 action 与 guidance 的版本化行为谓词匹配，由独立 extractor/服务端判定，agent 自报不能单独成立。每个事件引用 task/run、hint/ref revision、source channel、policy version 与因果前序。
- B. Hint 进入 prompt 即同时算 exposure 和 citation；agent 说“已采用”即算 adoption。
- C. 只记录最终 outcome，不记录中间事件。

➡️ 推荐 A。它将“看见”“考虑”“声称采用”和“实际执行”分开，也允许 rejected/compared citation 贡献 reference strength 而不伪装成正向采用。

---

❓ **Q87** - **provisional 通道如何兼顾热门候选利用与冷门候选探索？**

- A. 默认 4 个 provisional 槽位中，3 个按 role-specific reranker exploitation，1 个从通过硬门槛但低曝光/高不确定候选中做可复现的 seeded exploration；若无合格探索候选则回填 exploitation。记录 eligible set、selection propensity/seed、ranker/policy version；citation/reference strength 的离线评估按 exposure propensity 校正。Memory Hint 始终不可自动执行，正常任务可由 workspace 收紧探索槽，评测模式默认保留 1 个。
- B. 4 个槽位全部按当前 citation/reranker TopK，永不主动探索。
- C. 4 个槽位全部随机，避免任何热门偏差。

➡️ 推荐 A。没有探索槽，早期高曝光候选会永久垄断 citation；全部随机又会牺牲相关性和任务质量。

---

❓ **Q88** - **跨任务独立性是否需要 task family，而不只看 task_id？**

- A. 引入 `task_family_id`/derivation provenance：同一原始 task 的 replay、continuation、参数变体和派生 benchmark 全部属于同一 family，只贡献 in-task/family-internal strength；只有来源独立且不共享答案/轨迹派生关系的不同 family 才贡献 `cross_task_reference_strength` 和 Q81 的 cross-task independent evidence。无法判定 family 时标 `independence_unknown`，可记录 citation 但不增加独立证据计数。
- B. 只要 task_id 不同就算跨任务，哪怕是同一 benchmark 模板复制或从原轨迹派生。
- C. 所有 benchmark 中的 run 都算同一任务，完全不计 cross-task。

➡️ 推荐 A。它防止把同一任务的改写、replay 或 continuation 伪装成跨任务迁移证据，同时仍完整保留它们的任务内价值。


---

## Memory disposition、task_id 权威与探索校正 frontier

❓ **Q89** - **被 `memory@` 的 agent 如何决定并记录是否采纳？**

- A. 目标 agent 必须针对每个已处理 Hint 输出结构化 `MemoryDisposition`：`{hint_id, target_agent_id, decision=adopt|reject|defer, reason, intended_action_refs?, decided_at}`。`adopt` 是目标 agent 的权威采纳决定，服务端或 Memory Agent 不得代判；reject/defer 仍形成 citation，超时无回执只算 exposure。后续独立记录 `followthrough=observed|partial|not_observed|contradicted` 和 outcome：它们不推翻 agent 的采纳决定，但只有 adoption + followthrough + outcome 才形成正向 outcome utility。
- B. 目标 agent 在自然语言回复中说“用了”就直接记 adoption 和正向 utility，不需要结构化回执或后续行为。
- C. 目标 agent 不表态，由 Memory Agent 或服务端根据后续文本自动决定是否采纳。

➡️ 推荐 A。它落实“被 @ agent 决定是否采纳”，同时把意图、实际执行和最终效果分开；reject/defer 也能表达“这个 memory 值得考虑但当前不适用”。

---

❓ **Q90** - **既然 task_id 不同即 cross-task，谁有权铸造 task_id？**

- A. 仅权威 task/evaluation orchestrator 在任务创建时铸造不可变 task_id；普通 agent、Memory Agent、Diagnosis Agent 只能引用，不能自选或改写。Replay、continuation、baseline/treatment 和恢复 run 必须继承原 task_id；只有 orchestrator 接受一个新的顶层任务实例时才创建新 task_id，即使文本相同也不按内容 hash 合并。记录 issuer、creation provenance 和 parent evaluation，但这些不改变 Q88 的“ID 不同即 cross-task”。
- B. 每个 agent/run 可以自行生成新的 task_id。
- C. task_id = 任务文本 hash，相同文本永远是同一任务。

➡️ 推荐 A。它遵守 Q88=B，同时防止 replay/continuation 通过换 ID 伪装成跨任务引用；也避免内容 hash 把上下文不同但文本相同的任务误合并。

---

❓ **Q91** - **Seeded exploration 产生的曝光偏差如何进入评价和排序？**

- A. 保留 Q70 的原始等权 citation 与时间衰减，同时额外维护 policy-versioned `debiased_reference_signal`：根据已记录的 eligible set/selection propensity 做 clipped inverse-propensity 或 doubly-robust 校正，仅供离线评价和下一版 reranker 训练；在线当前 policy 不用同一批反馈即时自我改权。Exploration Hint 显式标 `selection_mode=exploration`，但目标 agent 的 disposition、adoption 和 outcome 仍正常记录。
- B. 不做任何校正，直接用原始 citation 训练下一版排序器。
- C. Exploration 产生的 citation/adoption/outcome 全部丢弃，不进入评价。

➡️ 推荐 A。原始事件继续满足“每次引用都有价值”，校正信号则避免把系统主动多曝光误认成候选本身更优；延迟到下一版 policy 也避免在线反馈回路。


---

## 评测状态机、handoff 幂等与 ACL-safe 聚合 frontier

❓ **Q92** - **谁驱动 Memory→Diagnosis→Memory 评测循环？**

- A. `EvaluationOrchestrator` 独占状态迁移：①为 task/run 创建 MemoryTaskState 与 pinned SearchPlan；②Memory 检索并 `memory@target_agent`；③任务 run 完成后运行 step-reward 与结果 evaluator；④冻结 DiagnosisBrief；⑤启动 causal diagnosis；⑥服务端提交 provisional/validated/invalidated ForkRevision 与 DiagnosisOutcome；⑦Memory 以 Outcome 建立下一 run 的新 MemoryTaskState；⑧按 Q82 停止或安排 replay/continuation。Memory/Diagnosis 只能提交 trigger/schedule proposal，不能自行创建 run、扩预算或越过状态。
- B. Memory Agent 可以直接创建 Diagnosis run 和下一次 replay，并自行决定预算。
- C. Diagnosis Agent 完成后直接唤醒 Memory Agent，不保留服务端状态机。

➡️ 推荐 A。它闭合原 Q53：循环仍然是 Memory→Diagnosis→Memory，但控制面属于 orchestrator，agent 只负责各自策略和结构化产物。

---

❓ **Q93** - **Memory↔Diagnosis handoff 如何保证幂等、恢复与权限隔离？**

- A. 两个方向都使用服务端持久化、不可变、内容寻址 envelope：`DiagnosisBrief` 至少含 evaluation/task/source-run/iteration IDs、MemoryTaskState version/hash、selected refs、snapshot watermarks、policy versions 与子预算；`DiagnosisOutcome` 至少含 diagnosis_run_id、input brief hash、ForkRevision/bridge refs、未决问题、waiting conditions、预算和版本。幂等键=`evaluation_iteration_id + handoff_kind + input_manifest_hash`；采用 at-least-once 投递和 receiver ack/checkpoint，重复投递返回同一结果。Envelope 不携带 bearer credential，接收方每次用自己的 capability 重验 refs；内容变化必须新建 iteration/revision，禁止覆写。
- B. 直接传递 Memory/Diagnosis 活 session；失败后从聊天历史猜测恢复。
- C. 仅发送自然语言摘要，不保存输入 hash、ack 或版本。

➡️ 推荐 A。它延续已定的“不持久化活 agent”，并让 crash/retry 不会重复创建 fork、citation 或评测 run。

---

❓ **Q94** - **全局 ForkCandidate/HypothesisBridge 的强度、处置与排名如何避免 ACL 侧信道？**

- A. 每个 citation/disposition/followthrough/outcome/judgment 事件继承并冻结来源 task/channel、目标 Hint/ref 与主体的安全标签；在线检索只使用当前 principal 有权观察的事件计算 `visible_in_task_strength`、`visible_cross_task_strength`、outcome 和治理分，响应不返回隐藏事件数量、隐藏 task ID 或可反推的小样本差值。Fork/bridge projection 可全局发现仍以对象 ACL 为前提，证据下钻逐 ref 重验。服务端内部全量聚合仅可用于受控离线评价，并以阈值/去标识产物进入新 policy，不能把私有原始计数直接注入在线排名。
- B. 只要 ForkCandidate 全局可检索，就公开其全部引用计数、来源 task 和 disposition。
- C. 响应隐藏原始事件，但在线 ranker 仍使用所有私有事件的精确全局总数。

➡️ 推荐 A。C 虽不直接显示计数，排序变化本身仍可能泄露隐藏任务的存在；严格做法是线上强度与 rank 都基于调用者可见事件。


---

## AIG 论文启发后的 frontier

研究依据见 `AIG_2608.24361v1_调研与ForkMemory对比.md`。论文的表示阶梯显示：结构化日志和影响图分别提升归因，而 adaptive graph 只有配合 agent 主动遍历、回查原始日志时达到最佳结果；因此当前根决策是是否增加位于事实图与长期记忆图之间的 diagnosis-local 接口。

❓ **Q95** - **是否新增 diagnosis-local `Diagnosis Influence View`（DIV）？**

- A. 新增。Interaction DAG/AO 继续作为不可变事实层；每次 diagnosis run 由 builder 按当前失败与 query 自适应合并/拆分 AO/segment 为 action-level InfluenceBlock，并创建描述 `carried_artifact + downstream_effect` 的 InfluenceClaim；critic/refiner 后冻结为只读 InfluenceViewRevision，reader/InteractionPathWorker 沿 incoming claim 反向探索并逐条回查原始证据。只有最终 ForkDraft/ForkRevision/EvidenceBridge 进入长期层，DIV 本身不进入全局检索。
- B. 不新增中间视图；直接让 reader 在原始 Interaction DAG 与全局 HypothesisBridge 上诊断，并把所需摘要临时放进 prompt。
- C. 用 adaptive builder 改写基础 Interaction DAG，使其本身同时承担事实图、诊断视图与长期影响图。

➡️ 推荐 A。它吸收论文最有实证支持的“自适应表示 + agentic traversal + 原证据核验”，同时不破坏当前已定的 Interaction DAG 权威性、append-only revision、Hypothesis/Evidence 分型和全局 ACL。B 缺少 action-level 影响接口；C 会把模型构造的可变归因结构混入权威事实图。


---

## DIV 生命周期、覆盖、角色、验证与调度 frontier

❓ **Q96** - **DIV 的可变→冻结生命周期，以及构建失败时如何 fallback？**

- A. Diagnosis run 内先有 mutable `InfluenceViewDraft`，只有 builder/refiner 可修改；最多 3 轮 critic/refiner 后，满足门槛则冻结不可变 `InfluenceViewRevision`，reader 只读。若 adaptive 构建失败、超时或仍有高严重度 violation，服务端从已选 AO/segment 生成确定性的 minimal fallback view，标记 `construction_mode=fallback` 与 violations；它可支撑 provisional ForkRevision 的 grounding，但不能单独满足 validated 门槛。后续修改必须新建 view revision。
- B. 构建失败就允许 ForkRevision 直接引用 AO，不需要 influence_grounding。
- C. DIV 始终可变，reader 与 builder 可同时读写同一张图。

➡️ 推荐 A。它同时保持 Q95 的“每个 ForkRevision 都有 grounding”、系统可用性和冻结后的可复现性；fallback 不伪装成高质量自适应图。

---

❓ **Q97** - **DIV 必须覆盖整条轨迹，还是允许查询相关的稀疏覆盖？**

- A. 允许稀疏、查询相关覆盖，但必须带 `coverage_manifest`：总 AO/segment 范围、实际 inspected refs、included/omitted ranges、遗漏理由和 snapshot watermark。所有 block 必须有 source refs；InfluenceClaim 按时间前向、视图无环；包含一个虚拟 task root 与 observed-outcome sink，纳入的 block 必须位于 root→sink 的弱连通解释子图中。基础 Interaction DAG 不要求单 root/sink。跨 omitted range 的 claim 必须显式标 skip 并引用两端证据。
- B. 每次 DIV 必须把任务全部 AO/segment 都变成 block，不能遗漏。
- C. Builder 可任意选片段，不记录未读/遗漏范围。

➡️ 推荐 A。全覆盖会把长轨迹重新变成昂贵日志重写；无 coverage manifest 的稀疏图又会隐藏盲区。

---

❓ **Q98** - **Builder、Critic/Refiner、Reader、Causal Diagnosis 的能力和模型如何隔离？**

- A. 四个独立 session/profile：Builder 可读 pinned AO/DAG 并写 draft；Critic 只读 draft/evidence、输出 violations；Refiner 只能依据 violation 对 draft 做最小 patch（可由 Builder profile 执行但记录 patch provenance）；Reader 只读 frozen view/evidence；Causal Diagnosis 只消费 reader verdict 并 propose ForkDraft。可使用同一 backbone，但 session、prompt、capability、model/policy version 必须分离；高价值 case 优先让 critic 或 reader 使用不同模型，生成方不得担任最终 evaluator。
- B. 一个 agent 在同一活 session 中建图、批评、改图、读取、归因和评价。
- C. 必须四种不同模型，否则不运行。

➡️ 推荐 A。论文证明的是角色/工具分离，不是必须使用不同模型；同 backbone 仍可运行，但要保留自证风险和版本 provenance。

---

❓ **Q99** - **InfluenceClaim 何时从 hypothesis 变成 supported 或 contradicted？**

- A. Builder 创建时永远是 hypothesis，至少包含 `carried_artifact`、`downstream_effect`、双端 block/evidence refs；结构检查只证明格式合法。Reader 必须分别核验：source 是否产生该 artifact、target 是否实际消费、effect 是否在 target/downstream observation 出现，并检查 alternative source/反例。三项成立且无更强反例才标 supported；直接证据否定任一核心项标 contradicted；其余为 insufficient。Critic verdict 与 Reader evidence verdict 分栏。即使 supported，也只可支撑 ForkDraft，不自动生成全局 EvidenceBridge。
- B. Critic 没发现问题就直接 supported，并自动发布 EvidenceBridge。
- C. Builder 自评 confidence 超过阈值就 supported。

➡️ 推荐 A。它把 schema validity、semantic plausibility 和 evidence verification 分成三层，避免 critic 的“没发现错误”被当成因果证据。

---

❓ **Q100** - **统一最多并发 5 个 worker 在 DIV 流水线中怎样调度？**

- A. Orchestrator 使用阶段屏障并复用 5 个槽位：Build 阶段 1 builder；Critic/Refiner 阶段最多 2 个独立 critic 并行、1 个 refiner 串行归并；Freeze 后 Reader 阶段最多 5 个 InteractionPathWorker 并行。不同阶段不重叠，reader 不能看到 mutable draft。5 是全 evaluation iteration 的并发上限，不是累计 agent 次数；总 token/tool/path/entity 预算仍固定，不因阶段复用增加。
- B. 整个 iteration 累计最多启动 5 次 agent，包括三轮 critic 和所有 readers。
- C. Builder、critic、reader 各自可并发 5 个，阶段可以重叠。

➡️ 推荐 A。它遵守 Q69 的统一并发 cap，同时允许顺序流水线复用槽位；阶段屏障保证 reader 的输入稳定。


---

## 层级生成、跨层检索与可见性矩阵（提案）

### 生成矩阵

| 层级 | 对象 | 生成者与时机 | 是否需要 LLM | 持久性/检索性 |
|---|---|---|---|---|
| L0 事实原子 | 原始 message/tool evidence、AO ledger、session state | Agent runtime/channel service 在 action-observation、send/deliver/commit 时实时 append | 否；observation synopsis 必须确定性 | 权威 append-only；raw evidence 只按 ref 下钻，不作普通全局入口 |
| L1 交互结构 | Segment、InteractionEvent、Interaction DAG | channel/ledger service 在 interaction event 截断和投递时实时物化 | 否 | 权威 append-only；当前 SearchPlan 内可导航，不作为跨任务长期记忆入口 |
| L2 诊断视图 | InfluenceViewDraft/Revision、InfluenceBlock、InfluenceClaim、coverage manifest | EvaluationOrchestrator 触发 diagnosis 后，由 Builder/Critic/Refiner 构建；失败时服务端生成 deterministic fallback | 自适应视图需要 LLM；结构检查/fallback 不需要；semantic critic 可用 LLM | draft run-local mutable，revision 冻结；不进普通全局 Memory 检索，只能按已知 view/grounding ref 到达 |
| L3 因果记忆 | ForkDraft、provisional/validated/invalidated ForkRevision、branch、HypothesisBridge/EvidenceBridge、cluster/utility | Reader/causal diagnosis 完成归因后 propose，服务端校验提交；replay/continuation/真实结果到达时追加 revision/统计 | 归因、想象、guidance、相似判断通常需要 LLM；schema/ACL/幂等/聚合不需要 | Fork/branch 为全局 causal-memory 入口，按 provisional/verified 双通道检索 |
| L4 消费产物 | Memory Hint、MemoryDisposition、executable skill | Memory Agent 检索后按需生成并 `memory@target_agent`；目标 agent 回 disposition；Evolution 在 evaluator 批准后发布 skill | Hint/处置理由通常由 LLM；投递、事件记账和 skill 完整性校验不需要 | Hint 属于 task/run 交互；稳定 skill 可执行；二者通过 refs 回到 L3/L0 证据 |

原则：事实层不依赖 LLM；LLM 只提出分段、影响、归因和消费解释；任何进入权威/全局层的对象均由服务端执行确定性 schema、ACL、provenance、预算和幂等校验。Embedding/reranker 模型属于检索模型，不因此获得写事实或发布 skill 的权限。

### Typed transition 提案

```text
AO/Atom --contained_in--> Segment
Segment --emit/deliver/local_continuation--> InteractionEvent/Segment
Segment/AO --grounded_as--> InfluenceBlock
InfluenceBlock --InfluenceClaim--> InfluenceBlock
block|edge|cut --influence_grounding--> ForkRevision
ForkRevision --has_branch--> Branch
ForkRevision --HypothesisBridge|EvidenceBridge--> ForkRevision/其他 typed ref
ForkRevision|Branch|Skill --derived_as--> MemoryHint
MemoryHint --Disposition/Followthrough/Outcome--> evaluation events
```

每次跨层不是“拿 ID 随便跳”，而是调用 `expand(typed_ref, relation)`：服务端检查 transition 白名单、SearchPlan、snapshot watermark、当前 principal 与来源 ACL、层级预算，并返回新 typed refs。向下读原始证据比向上读摘要权限更窄，逐 ref 重验。

### 可见性提案

| 层级 | Memory Agent | Causal Diagnosis（含 Builder/Critic/Reader profiles） |
|---|---|---|
| L0 AO/raw evidence | 当前 task SearchPlan 内先看 synopsis；仅对 selected refs 按需下钻原文 | 当前 diagnosis pinned snapshot 内可分页读 AO；只对 selected/claim refs 下钻原文 |
| L1 Segment/Interaction DAG | 当前 task/channel 授权范围内沿 interaction lane 导航 | 当前 diagnosis target 授权范围内完整导航，用作 DIV 构建事实底座 |
| L2 DIV | 同一 evaluation/task lineage 可按已知 ref 读取 frozen view 的摘要和 selected block/claim；不能看 draft、不能改图；跨任务默认只看 Fork grounding summary | Builder 写本 run draft；Critic 只读 draft/evidence；Reader 只读 frozen view；历史 frozen view 仅通过 selected Fork grounding 且逐 ref ACL 读取 |
| L3 Fork/Branch/Bridge/Skill refs | 主要全局检索层；可搜 provisional/verified 投影、沿允许 bridge/branch 扩展，不能直接提交 revision/edge | 可检索同一 L3 投影作跨树参照；只可 propose ForkDraft/bridge judgment，不能直接提交或发布 skill |
| L4 Hint/Disposition | 生成 Hint、定向投递、接收目标 agent 的 disposition/outcome 摘要 | 将 Hint/disposition/followthrough/outcome 当诊断证据；不代替目标 agent 作采纳决定 |

---

❓ **Q101** - **是否采用“事实层确定性、解释层 LLM、权威提交确定性校验”的生成矩阵？**

- A. 采用上表：L0/L1 实时确定性生成；L2 diagnosis 时由 LLM 自适应构图、服务端检查/fallback；L3 由 LLM propose、服务端提交；L4 由 Memory/目标 agent 生成解释性产物，事件与 skill 完整性由服务端确定性处理。
- B. Segment/Interaction DAG 也由 LLM 在 diagnosis 时临时生成。
- C. 所有层都确定性生成，LLM 只读最终结果。

➡️ 推荐 A。它让事实不依赖模型，同时把 LLM 用在真正需要语义判断的边界、影响和归因上。

---

❓ **Q102** - **是否采用 typed transition，而不是一个全层级统一 TopK 索引？**

- A. 全局 search entry 仍以 ForkRevision/Branch（及稳定 Skill）为主；当前任务 interaction lane 从 SearchPlan 提供的 Atom/Segment seed 开始；DIV 不作普通全局入口，只能由 diagnosis/outcome/fork grounding 的已知 ref 到达；跨层统一走 `expand(typed_ref, relation)`，逐跳 ACL/预算/水位检查。
- B. AO、Segment、InfluenceBlock、Fork、Hint 全放入一个索引，用一个分数统一 TopK，并允许任意跳层。
- C. 各层完全隔离，禁止任何跨层导航。

➡️ 推荐 A。它保留统一检索 facade，但不抹平不同层的身份、权限和边语义。

---

❓ **Q103** - **Memory Agent 对 DIV 的可见性是否按 task scope 分级？**

- A. 同一 evaluation/task lineage：可按 DiagnosisOutcome/Fork grounding 已知 ref 读取 frozen DIV 摘要及 selected block/claim，用于下一 replay/continuation；跨任务：默认只看 Fork/Branch projection 与 grounding summary，若确需完整历史 DIV/原证据，走显式 evidence escalation 和来源 ACL；永远不能读 mutable draft 或 critic 私有工作状态。
- B. Memory Agent 可全局搜索并读取所有 DIV draft/revision。
- C. Memory Agent 永远不能看到任何 DIV 信息，只能收到自然语言 Fork 摘要。

➡️ 推荐 A。它支持 Memory→Diagnosis→Memory 的同任务闭环，又避免把诊断工作图变成新的全局噪声语料库。

---

❓ **Q104** - **Diagnosis 对各层是否采用 profile-specific capability，而不是一个全能 Agent？**

- A. Builder 可读当前 L0/L1 和 selected L3、写本 run L2 draft；Critic 只读 L2+引用证据、输出 violations；Reader 只读 frozen L2+selected L0/L1/L3；Causal Diagnosis 消费 verdict 并 propose L3；任一 profile 都不能直接提交全局 revision/bridge、发布 skill 或继承 Memory credential。
- B. Diagnosis 的所有子角色共享一个全能 capability，可修改任何层。
- C. Diagnosis 只能看 L2，不能回查 AO/Segment 或跨树 Fork。

➡️ 推荐 A。层级可见性应由服务端 capability 决定，不由 prompt 里的角色说明决定。

---

❓ **Q105** - **跨层证据读取是否采用 summary-first escalation？**

- A. `search projection → read layer summary → expand selected typed relation → read selected evidence synopsis → get raw evidence`，每一级单独计预算和审计；没有 selected ref 不能批量下钻 raw evidence，redacted 节点形成路径断点。
- B. 命中任意上层对象后自动把它引用的全部 AO、Segment、DIV 和原始消息注入上下文。
- C. 永远只读摘要，不允许回查原始证据。

➡️ 推荐 A。它与 AIG 论文中“图负责聚焦、reader 选择性核验原日志”的主要实证结果一致。


---

## Q102 重定案：轨迹完成后生成可检索 Influence View

设计者提出：每条轨迹完成后生成该轨迹的 DIV，再基于 DIV 做混合检索。该方向将 L2 从纯 diagnosis-run 工作层扩展为统一 `InfluenceView` 层，但需要区分同层两种 revision，而不是把没有失败目标的通用视图也叫 Diagnosis View：

- `purpose=post_run_index`：轨迹 commit 后异步生成 query-neutral 基础 InfluenceViewRevision，覆盖成功/失败轨迹；
- `purpose=failure_diagnosis`：Diagnosis 触发后，以基础 revision、失败 outcome 和 diagnosis query 为输入生成 target-specific revision；
- 二者共享 InfluenceBlock/InfluenceClaim/grounding schema，后者可复用或 supersede 前者；
- 只有 frozen Block/Claim 的轻量 projection 进入 provisional 检索，draft、critic 工作状态和全文不入索引。

❓ **Q102（重定案）** - **是否让每条 causal/evaluation 轨迹在完成后异步生成可检索基础 Influence View，并由 diagnosis 产生目标化 revision？**

- A. 是。轨迹完成/commit 后异步生成 `post_run_index` frozen revision；失败诊断时派生 `failure_diagnosis` revision。Memory 混合检索使用 Fork/Branch、InfluenceBlock/Claim projection、当前 Segment/Atom 三类 typed corpus，各自配额和 ranker；不能只用 DIV 替代 Fork，也不把 full view 直接注入上下文。
- B. 每条轨迹生成 DIV，并只检索 DIV；取消 Fork/Branch 全局入口。
- C. 保持原案：L2 仅 diagnosis 时生成且不进入任何全局检索。

➡️ 推荐 A。基础 Influence View 提供比 Fork 更密的 action/influence 表示，尤其覆盖尚未产生 fork 的成功轨迹和冷启动；Fork 仍提供经过归因的稳定 anchor、branch、guidance、utility 与验证状态。两者互补，不互相替代。

---

❓ **Q108** - **Memory Agent、检索服务与可选 LLM workers 如何分工 explore/rerank？**

- A. 三段式：①服务端 HybridRetriever 对 Fork/Branch、InfluenceBlock/Claim、Segment/Atom 做 BM25/vector/图约束预召回、ACL 过滤和 corpus 内初排；②主 Memory Agent（LLM）根据 MemoryTaskState 选择 typed expand、派最多 5 个可选只读 path workers 并决定停止；③workers 只返回 assessed refs/evidence/contradictions，主 Memory Agent 负责跨 corpus 最终语义 rerank、归并和 Memory Hint 生成。可有轻量服务端 reranker，但不另设一个拥有探索权的常驻“调研 LLM”。
- B. 服务端固定 TopK 后直接生成 Hint，Memory Agent 不做 agentic explore/rerank。
- C. Memory Agent 只派任务，所有 explore、最终 rerank 和 Hint 都由另一个常驻 Research Agent 决定。

➡️ 推荐 A。它让主 Memory Agent 对 query、探索路径、停止和最终 Hint 负责；子 LLM 只并行核验路径，避免多个 Agent 竞争最终决策权。


---

## Reader/Diagnosis 合并与 Projection/Summary-first 澄清后的 frontier

❓ **Q98/Q104（重定案）** - **Reader 与 Causal Diagnosis 是否合并为一个活 Agent、两个能力阶段？**

- A. 合并语义 session，不合并能力：同一 `CausalDiagnosisAgent` 先进入 `READ_VERIFY` phase，只能读 frozen Influence View/selected evidence、调度只读 path workers并输出结构化 ReaderReport，不能 propose Fork；服务端内容寻址冻结 ReaderReport 后切换到 `SYNTHESIZE_PROPOSE` phase，Agent 只能基于 frozen report 生成 ForkDraft/bridge proposal，不能修改 view/report。Builder 与 Critic 仍独立；生成方不得担任最终 evaluator。
- B. 完全合并，Agent 可边读证据、边改 DIV、边提交 Fork、边评价结果。
- C. Reader 与 Causal Diagnosis 必须是两个独立 session/model，不能共享活上下文。

➡️ 推荐 A。它保留上下文连续性和较低 handoff 成本，但用 phase capability 与不可变 ReaderReport 防止结论反向改写证据读取过程。

---

❓ **Q103（重定案）** - **Memory Agent 对可检索 Influence View 的可见性边界？**

- A. 全局 search 只返回 frozen `InfluenceBlockProjection`/`InfluenceClaimProjection` 轻量卡片；同一 task/evaluation 可按已知 view ref 阅读完整 frozen selected blocks/claims；跨任务命中 projection 后必须通过 summary-first evidence escalation 才能读完整 view/原证据，逐 ref ACL；draft、critic violations 和未冻结内容永远不可见。
- B. 全局搜索直接返回所有完整 Influence View，包括 draft、coverage 和原始证据。
- C. 虽然建立 projection，但 Memory 只能看 ID，不能看摘要或扩展证据。

➡️ 推荐 A。Projection 负责高召回，完整 frozen view 负责按需理解，AO/raw 负责最终核验。

---

❓ **Q105（重定案）** - **是否采用逐步展开而非一次性注入？**

- A. Memory/Reader 先看十几条轻量 projection，只选择少量候选读 Block/Claim summary，再选择其中一两条读 AO synopsis，仍有歧义才读 raw message/tool evidence；每一步可停止、单独计预算和 ACL。Summary-first 不是禁止原文，而是“先缩小候选，再读取原文”。
- B. 搜到任意 Block/Fork 后，把整张 View、全部 Segment/AO/raw evidence 一次性注入。
- C. 只允许摘要，任何情况下不读原文。

➡️ 推荐 A。它减少无关上下文和权限暴露，同时保留最终事实核验。
