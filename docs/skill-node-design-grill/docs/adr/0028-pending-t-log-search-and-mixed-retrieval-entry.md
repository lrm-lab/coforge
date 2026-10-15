# T_log.search 与 Memory mixed retrieval 统一入口、分 lane 执行

**Decision key:** `memory-search-entry/Q134-B`
**Status:** `accepted`
**Decision:** Option B

本 ADR 保留 `memory-search-entry/Q134-B` 定案前后的完整分析记录，包括 A/B/C 三个选项、各自机制、权衡与后果。用户现已选择 Option B：Memory Agent 使用单一 `retrieve(SearchPlan)` facade 和统一执行 planner，共享 ACL、scope、pinned watermark、父级预算、超时与审计；`current_log_exact` 与 `memory_discovery` 保持两条类型化 lane，不混合排名分数、TopK 配额、证据语义或 exposure/citation/utility 记账。

## 一、问题背景

Memory Agent 当前面对两类都可以被口语称为“搜索”、但信任语义完全不同的查询需求：一类是在当前任务轨迹中定位真实发生过的步骤，另一类是在长期记忆中发现可能适用的历史经验。`memory-search-entry/Q134-B` 决定这两类能力对外合并为一个带类型化 lane 的统一 facade，而不是一个无类型结果池或两个独立公共工具。

### 1. 当前任务轨迹中的事实查找

典型问题包括：

- 当前错误信息出现在哪一步？
- 哪个 agent 修改了配置？
- 某次工具调用返回了什么？
- 在 pinned watermark 之前是否出现过 `ECONNREFUSED`？

这对应论文中的 `T_log.search`。论文语义是在当前日志所有步骤内容上执行正则搜索，最多返回 20 个匹配。生产设计还必须增加以下约束：

- 查询绑定固定 `scope` 与 `pinned watermark`；
- 每个命中逐条按调用 Memory Agent 的 principal 重验 ACL；
- 返回稳定 step/AO evidence ref 和有界片段，而不是无来源散文；
- 不可见、已撤回或越过 watermark 的内容不得返回；
- 搜索命中只表示“当前日志中出现过”，不自动产生 citation、adoption 或 utility；
- 空命中与搜索后端未执行、超时或被拒绝必须使用不同状态表达。

`T_log.search` 的目标是定位当前事实证据，不负责发现历史相似案例。

### 2. 长期记忆中的经验发现

典型问题包括：

- 过去是否发生过相似的数据库连接失败？
- 哪个 Fork/Branch 曾解决类似问题？
- 是否有适用于当前任务的 active skill revision？
- 哪些 InfluenceClaim 描述了相似的 artifact→effect 关系？

这对应 Memory mixed retrieval。它跨多个 corpus 使用 BM25、向量、状态、适用性或 utility 等信号做发现和排序，区分 verified、provisional 与 fact 通道，并按 retrieval profile 分配候选配额。返回对象通常是历史经验、候选机制或待核验 prior，不是当前任务的直接事实证据。

### 3. 为什么不能把“都接受 query”当作已经可以合并

两类搜索的输入表面相似，输出却回答不同问题：

- exact log search 回答“本次任务的日志里真实出现了什么、出现在哪里”；
- mixed retrieval 回答“历史上哪些经验可能与本次任务相关、值得继续核验”。

前者的主要排序依据是精确匹配位置、日志顺序和当前证据范围；后者使用 BM25、向量相似度、验证状态、适用性与 utility 等信号。两种分数没有天然可比性，且两类结果的 exposure、citation 和 utility 记账规则不同。

## 二、现有实现与文件

### 1. OpenViking typed retrieval facade

文件：

```text
OpenViking/openviking/session/retrieval_facade.py
```

现有 `RetrievalFacade.retrieve()` 已实现或定义：

- Fork/Branch adapter；
- frozen InfluenceBlock/InfluenceClaim projection adapter；
- Segment/Atom adapter；
- BM25 或 BM25+vector hybrid 初排；
- verified/provisional/fact 通道；
- corpus 配额；
- principal ACL 过滤；
- rerank；
- 统一 `RetrievalCard` 信封；
- `expand_claim_neighborhood()` 图邻域展开。

当前默认 causal-memory corpus 配额为：

```text
Fork/Branch:       6
Block/Claim:       4
Segment/Atom:      2
查询总帽:         12
```

当前代码还设置：

```python
FACT_LANE_PAUSED = True
```

因此默认暂时不会调用 Segment/Atom adapter，也不会把空出的两个位置回填给其他 corpus。OpenViking 当前 `CardKind` 也不直接包含 skill；skill 检索主要仍存在于 Coforge 一侧。

该 facade 是语义发现和排序接口，不是论文所述的当前日志正则搜索。

### 2. OpenViking AO ledger reader

文件：

```text
OpenViking/openviking/session/ao_ledger_reader.py
```

当前已有：

- pinned ledger snapshot；
- watermark-frozen 分页读取；
- 单条 AO evidence drill-down；
- 来源 session ACL hook；
- 未注册 session 默认拒绝；
- 对 snapshot cursor 与 watermark 的一致性校验。

但它目前没有论文式 regex `T_log.search` adapter。已选 Option B 仍要求新增受限 current-log exact-search 实现；不能把现有 `RetrievalFacade.retrieve()` 直接改名后宣称已经具备该能力。

### 3. Coforge Group Memory retrieval 与 exploration

文件：

```text
coforge/apps/web/src/server/group-memory/memory-similarity.server.ts
coforge/apps/web/src/server/group-memory/memory-exploration.server.ts
coforge/apps/web/src/server/group-memory/memory-expansion.server.ts
```

当前实现包括：

- PostgreSQL `pg_trgm` seed retrieval；
- episode、active insight 和 active skill revision 检索；
- bounded exploration session；
- `start → explore/redirect → close` 生命周期；
- provenance-edge 邻域展开；
- Memory Agent identity fence；
- step/result budget、TTL 与幂等控制。

`memory-similarity.server.ts` 的 `MemorySimilarityIndex.findSeeds()` 是当前 Coforge 的统一 seed seam，但它仍是 pg_trgm 相关性搜索，不是当前 AO 日志精确搜索。它也尚未与 OpenViking typed retrieval facade 统一。

### 4. 当前接缝状态

当前系统近似为：

```text
当前任务事实搜索
    T_log.search
    └── 设计已定义，AO reader 尚未实现 exact-search adapter

长期因果经验发现
    OpenViking RetrievalFacade
    └── Fork/Branch + Projection + 暂停中的 Fact lane

Group Memory 经验发现
    Coforge similarity/exploration
    └── Episode + Insight + Active Skill
```

`memory-search-entry/Q134-B` 决定未来公共入口和服务端 planner 的形态，而不物理合并这些 corpus；存储身份、ACL、证据等级和原始 provenance 必须保留。

## 三、所有选项都必须保持的边界

无论最终选择 A、B 或 C，都必须满足：

1. 当前日志事实和历史经验不能失去类型标签。
2. 历史相似案例不能直接支持当前 InfluenceClaim；它只能作为 analogical prior，引导继续查证。
3. 每次读取必须使用 Memory Agent 自己的 principal、capability 与来源 ACL，不能借用 Diagnosis 或群中其他 agent 的权限。
4. 当前日志搜索必须绑定固定 scope 与 pinned watermark。
5. exact-search 命中不自动计入 citation、adoption 或 utility。
6. 历史 Influence projection 命中只记 index-level exposure；只有经过 grounding、进入 ForkRevision 或 Memory Hint 来源后才进入相应因果账本。
7. `read_full_log` 仍需显式 evidence escalation，不能因为入口合并而自动全文注入。
8. Memory Agent 仍然没有 `T_build`、AIG mutable draft 写入、事实层写入、Fork 权威提交或 Agent Evolution 发布权。
9. 不可因为合并入口而物理合并不同 corpus、重写稳定 identity 或丢失来源指针。
10. 某搜索后端失败、超时、预算耗尽或被 ACL 拒绝时，不能静默伪装成“已执行且无结果”。
11. `current_evidence_refs[]` 与 `analogical_prior_cards[]` 的信任等级必须机器可辨，而不是只靠自然语言提示。
12. `memory-search-entry/Q134-B` 只统一公共入口、执行 planner 与横切治理；任何实现不得借“统一”之名合并 lane 分数、TopK 配额、证据语义或记账。

## 四、Option A：完全合并为一个搜索和一个排序池（未选）

### 1. 机制

Memory Agent 只看到一个工具，例如：

```text
search(query)
```

服务端同时搜索：

- 当前日志步骤与 AO；
- Segment/Atom；
- Fork/Branch；
- InfluenceBlock/InfluenceClaim projection；
- episode/insight；
- active skill revision。

所有结果被转换成统一卡片，计算统一 relevance score，再放进同一个 TopK：

```json
{
  "results": [
    {"kind": "log_match", "score": 0.91},
    {"kind": "fork", "score": 0.88},
    {"kind": "skill", "score": 0.84}
  ]
}
```

### 2. 优点

- Memory Agent 只有一个工具，调用面最小。
- 服务端可以一次完成 fan-out、聚合和统一截断。
- query 不需要先由模型分类成“查当前事实”或“查历史经验”。
- 对简单任务，可能减少工具调用次数和端到端延迟。

### 3. 权衡与风险

#### 不同分数不可直接比较

正则命中、BM25、向量相似度和 utility LCB 表达不同含义：

- 正则命中表示字符串是否真实出现；
- BM25 表示查询词与文档词项的匹配程度；
- 向量分数表示语义相似；
- utility LCB 表示历史执行效果的保守估计。

把这些值统一成 `score=0.87` 需要额外校准政策，否则统一排序只具有数值外观，没有稳定语义。

#### 当前事实可能被历史经验挤掉

如果总 TopK 为 12，大量语义相似历史卡片可能占满配额，使当前日志中的关键错误步骤无法返回。即使当前事实卡片保留 `kind`，排序位置仍会暗示错误的证据优先级。

#### 证据等级容易混淆

模型容易把高排名历史 Fork、skill 或 projection 当作当前任务的直接证明，尤其在最终提示只看到一个排序列表时。

#### 记账可能污染

当前日志命中、历史卡片曝光、Memory Hint citation 与 skill invocation 的记账规则不同。统一列表可能诱导实现把所有“被返回对象”都记成同一种 exposure，形成自证排名循环。

### 4. 选择 A 的后果和后续必答问题

若选择 A，至少还需要确定：

- 跨 lane 分数校准公式和 policy version；
- 当前事实的最小保底配额；
- exact match 是否永远高于 semantic match；
- 统一 TopK 的 corpus 分配和回填规则；
- 每类结果的 exposure/citation/utility 记账；
- 防止 analogical prior 被当成 current evidence 的服务端校验；
- 单个后端失败时统一结果的 partial 状态；
- 统一 reranker 是否可以读取敏感 raw AO。

## 五、Option B：合并公共入口和执行规划，保留类型化 lanes（已选）

### 1. 机制

Memory Agent 只看到一个高级 role-scoped 入口，例如：

```text
retrieve(search_plan)
```

或：

```text
memory_retrieve(
    query,
    requested_lanes=["current_log_exact", "memory_discovery"]
)
```

服务端 planner 在一个请求中选择并调度多个 lane：

```text
RoleScopedRetrievalFacade
├── current_log_exact_lane
│   └── T_log.search
├── causal_memory_lane
│   └── OpenViking RetrievalFacade
└── group_memory_lane
    └── Coforge Episode/Insight/Skill retrieval
```

各 lane 共享：

- principal 与 ACL 基础设施；
- task、scope 与 pinned watermark；
- SearchPlan；
- 父级预算、超时与取消；
- query 去重与幂等；
- 审计和 partial failure 信封。

各 lane 不共享：

- 排名分数；
- lane 内配额和停止条件；
- evidence 类型和信任等级；
- verified/provisional 状态；
- exposure/citation/utility 记账；
- 当前事实与历史 prior 的身份。

返回值机器级分栏：

```json
{
  "current_evidence_refs": [
    {
      "ao_id": "ao-184",
      "sequence": 184,
      "match": "ECONNREFUSED 10.0.0.8:5432"
    }
  ],
  "memory_candidate_cards": [
    {
      "kind": "skill",
      "revision_id": "skill-rev-17",
      "status": "active",
      "utility_lcb": 0.64
    }
  ],
  "analogical_prior_cards": [
    {
      "kind": "fork",
      "fork_revision_id": "fork-rev-92",
      "similarity": 0.81
    }
  ],
  "lane_audit": {
    "current_log_exact": {"state": "complete", "matches": 1},
    "memory_discovery": {"state": "complete", "candidates": 2}
  }
}
```

### 2. 优点

#### 对模型只有一个公共入口

Memory Agent 不必自行判断先调用哪个搜索工具，也不需要在自然语言中手工合并两份异构响应。

#### 保持证据边界

`current_evidence_refs[]` 可以支持当前事实判断；`analogical_prior_cards[]` 只能提出待核验机制或反例。类型由协议强制，不依赖 prompt 纪律。

#### 统一安全和成本控制

ACL、scope、watermark、父级预算、审计、超时和 query 去重可以在一个 planner 中完成，减少两个独立入口产生的策略漂移。

#### 不要求异质分数可比

exact lane 可以按匹配位置或日志 sequence 排序；memory lane 可以继续使用 BM25、向量、验证状态和 utility rank。不同 lane 不必制造一个共同分数。

#### 支持显式 partial failure

例如 exact-search 后端失败时可以返回：

```json
{
  "current_evidence_refs": [],
  "lane_audit": {
    "current_log_exact": {
      "state": "unavailable",
      "reason": "ledger_search_timeout"
    },
    "memory_discovery": {
      "state": "complete"
    }
  }
}
```

这与“exact lane 已执行且零命中”具有不同语义。

### 3. 权衡与风险

- 需要设计新的统一 SearchPlan 和 typed multi-lane response schema。
- 需要实现当前不存在的 AO exact-search adapter。
- 需要定义 planner 何时调用全部 lane，何时只调用某一 lane。
- 需要定义 lane-local budget 与父级总预算的关系。
- 需要把 Coforge 与 OpenViking 的 identity 映射进统一信封，同时不能丢失各自来源键。
- 测试矩阵增加：单 lane 成功、单 lane 失败、ACL redaction、watermark 改变、预算耗尽和取消传播都要覆盖。
- 一个公共入口可能让调用方误以为服务端必然执行了全部 lane，因此 lane audit 必须是强制字段。

### 4. 选择 B 的后果和后续必答问题

若选择 B，下一轮至少要决定：

- exact lane 每次都执行，还是由 query classifier/SearchPlan 显式触发；
- exact lane 的命中上限是否保持论文的 20；
- exact lane 是否占 mixed retrieval 的 12 张卡片配额，或拥有独立配额；
- 父级总预算如何分配到各 lane；
- partial failure 时是否允许继续生成 Memory Hint；
- Coforge skill/insight/episode 如何进入统一 typed envelope；
- 公共入口命名为 `retrieve`、`search` 还是新的无歧义名称；
- planner 是否可以自动 evidence escalation，还是只能返回升级建议。

## 六、Option C：保持两个独立公共工具（未选）

### 1. 机制

Memory Agent 明确看到两个工具：

```text
search_current_log(...)
retrieve_memory(...)
```

例如：

```python
log_hits = search_current_log(
    pattern="ECONNREFUSED",
    scope=current_task,
    watermark="wm-57",
)

memory_hits = retrieve_memory(
    query="PostgreSQL connection refused after deployment",
    corpora=["fork", "projection", "skill"],
)
```

Memory Agent 自行决定调用顺序、是否需要两个工具、如何组合结果、是否继续下钻，以及何时停止。

### 2. 优点

- 两个工具语义直观：一个查当前事实，一个查历史经验。
- 不需要新增复杂的统一 planner。
- OpenViking typed retrieval 可以保持现有公共接口。
- exact-search adapter 可以独立开发、测试和演化。
- 单个工具失败时，调用方能明确知道是哪项能力失败。

### 3. 权衡与风险

#### 调用策略依赖模型纪律

Memory Agent 可能只查历史经验而未核对当前日志，或只查当前日志而未利用长期记忆；也可能在不同 watermark 上重复查询，再把两份结果错误拼接。

#### 父级预算难统一

两个工具各自未超本地预算，但合计可能超过 task 的总检索预算。若事后才统一计费，第二个工具可能在已经消耗上下文后才被拒绝。

#### ACL 和审计容易重复实现

如果两个入口各自维护 principal、scope、watermark 和 audit，长期演化中容易出现一个入口 fail closed、另一个入口 fail open 或字段语义漂移。

#### 容易发生证据洗白

Memory Agent 可能读取历史 Fork 后，在最终输出里没有保留 prior 类型，直接把它写成当前事实。统一 typed response 可以在协议层降低这种风险，两个工具则更依赖 agent 行为约束。

### 4. 选择 C 的后果和后续必答问题

若选择 C，至少还需要确定：

- 推荐或强制调用顺序；
- 是否必须先查当前日志再查历史经验；
- 两个工具的共享父级预算；
- query 和结果去重键；
- 两次调用如何保证 watermark 一致；
- MemoryTaskState 如何分别保存两类结果；
- Memory Hint 提交前如何验证没有把 prior 写成 evidence；
- 一个工具失败时是否允许另一个工具继续以及如何标记不完整性。

## 七、具体例子

### 1. 场景

一个群聊任务正在部署支付服务：

1. Agent A 修改数据库连接配置。
2. Agent B 执行部署。
3. 当前工具日志出现：

```text
step 184:
psycopg.OperationalError:
connection to server at 10.0.0.8, port 5432 failed:
ECONNREFUSED
```

4. 历史长期记忆中存在：
   - Fork F17：曾因 Kubernetes Service endpoint 未更新导致连接拒绝；
   - Skill S9：检查 PostgreSQL TLS 配置；
   - Insight I4：部署后先确认数据库 pod readiness。

当前问题是：

> 为什么这次支付服务部署失败？过去是否有可复用的解决办法？

### 2. Option A 的实际表现

统一搜索返回一个 TopK：

```json
[
  {
    "rank": 1,
    "kind": "skill",
    "title": "检查 PostgreSQL TLS",
    "score": 0.93
  },
  {
    "rank": 2,
    "kind": "fork",
    "title": "Service endpoint 未更新",
    "score": 0.91
  },
  {
    "rank": 3,
    "kind": "log_match",
    "step": 184,
    "text": "ECONNREFUSED",
    "score": 0.84
  }
]
```

非专家看到的直觉是排第一的 TLS skill 最重要，但它只是历史经验。真正的当前事实 `step 184` 反而排第三；当 TopK 更小时，它可能被挤掉。统一列表还需要解释为什么 exact hit 的 0.84 可以和 skill 的 0.93 比较。

### 3. Option B 的实际表现

Memory Agent 仍只调用一次，但结果分栏：

```json
{
  "current_evidence_refs": [
    {
      "step": 184,
      "fact": "当前连接 10.0.0.8:5432 被拒绝"
    }
  ],
  "memory_candidate_cards": [
    {
      "kind": "skill",
      "title": "检查 PostgreSQL TLS",
      "meaning": "可以尝试的历史技能，不证明本次是 TLS"
    }
  ],
  "analogical_prior_cards": [
    {
      "kind": "fork",
      "title": "Service endpoint 未更新",
      "meaning": "值得检查的历史机制，不证明本次相同"
    }
  ]
}
```

Memory Agent 可以据此表述：

> 当前证据只证明数据库连接被拒绝。历史上 endpoint 未更新和 TLS 配置都可能产生类似现象，需要继续读取本次 Service endpoint、pod readiness 与 TLS 日志。

当前事实和待核验假设不会竞争一个统一名次。

### 4. Option C 的实际表现

Memory Agent 必须自己调用两次：

```text
1. search_current_log("ECONNREFUSED")
2. retrieve_memory("database connection refused after deployment")
```

理想情况下，它可以得到与 B 类似的信息。但如果只执行第 2 步，就可能直接声称“失败原因是 PostgreSQL TLS 配置”，把历史 skill 错当本次根因；如果只执行第 1 步，就只能确认连接失败，无法利用历史解决经验。系统还必须确保两次调用使用相同 task scope 和 watermark。

## 八、术语解释

- **`T_log`**：一组只读日志检查工具。它让 agent 查看任务问题、步骤、区间、日志搜索和冻结图，但不能修改图。
- **`T_log.search`**：在当前任务日志中按精确文本或正则表达式查找匹配步骤的工具，例如搜索 `ECONNREFUSED` 出现在哪里。
- **Current log（当前日志）**：本次任务真实发生的消息、action、tool result 和 observation。
- **Exact search（精确搜索）**：按文本或正则匹配，目标是找到确实出现过的内容，而不是寻找语义相似案例。
- **Mixed retrieval（混合检索）**：综合关键词、向量、状态、适用性或 utility 等信号，从多个记忆集合中寻找相关经验。
- **Corpus**：一个独立数据集合，例如 Fork/Branch、Influence Projection、Segment/Atom 或 Skill。
- **Lane**：检索流程中语义独立的一条通道。不同 lane 可以共享入口，但保留自己的权限、配额、分数和结果类型。
- **Facade**：对 agent 暴露的统一接口，它在内部隐藏多个存储和检索实现。
- **SearchPlan**：服务端执行检索的结构化计划，描述查哪些 lane、使用什么 scope/watermark、允许多少预算以及何时停止。
- **Principal**：发起调用的安全主体，例如某个具体 Memory Agent identity。
- **ACL**：访问控制规则，决定 principal 是否能读取某条日志或记忆。
- **Pinned watermark**：冻结的读取上界，保证一次检索看到同一个日志快照，不会前半段读旧数据、后半段读新数据。
- **BM25**：传统关键词相关性算法；查询词与文档词项越匹配，通常分数越高。
- **Vector retrieval（向量检索）**：把文本转换成数值向量，再按语义距离寻找相似内容。
- **Hybrid retrieval（混合式排序）**：结合 BM25 和向量检索信号。
- **Rerank**：对初步召回候选再次排序，可能加入状态、适用性或 utility 等信号。
- **TopK**：只返回排名最前面的 K 个结果。
- **Current evidence ref**：指向本次任务真实日志或 AO 的稳定引用，可以用于支持或反驳当前事实判断。
- **Memory candidate card**：一张长期记忆候选卡片，例如 active skill revision 或可供本次考虑的 Fork。
- **Analogical prior**：历史类比线索；它表示过去可能存在类似机制，但不能证明当前任务也一样。
- **Verified / provisional**：verified 表示已经通过相应验证门槛；provisional 表示只是候选、仍待验证。
- **Exposure**：某条记忆被展示给 agent。被展示不等于被采纳，也不等于产生正效用。
- **Citation**：任务明确引用某条记忆；引用仍不等于该记忆帮助任务成功。
- **Utility**：skill 或记忆被实际应用、出现 followthrough 并产生客观结果后形成的效果统计。
- **Partial failure**：统一请求中的某条 lane 失败，但其他 lane 成功。响应必须明确写出失败，不能用空结果掩盖。
- **Fail closed**：遇到权限、身份或数据完整性不确定时默认拒绝，而不是猜测允许。
- **Index-level exposure**：检索投影卡片被显示时的索引层曝光，只用于召回质量分析，不直接进入 causal utility 账本。
- **Utility LCB**：效用后验的保守下界；它在证据少或不确定性高时给出更低估计，避免只按平均值过度乐观。

## 九、决策

选择 **Option B**。Memory Agent 对外只使用单一 `retrieve(SearchPlan)` facade；服务端在同一请求中统一处理 principal/ACL、scope、pinned watermark、父级预算、超时、取消、查询去重与审计，并按 SearchPlan 调度 `current_log_exact` 和 `memory_discovery` 类型化 lane。

统一入口不等于统一结果池：两个 lane 保留独立分数、TopK 配额、停止条件、证据等级及 exposure/citation/utility 记账。响应必须机器级分栏 `current_evidence_refs[]`、`memory_candidate_cards[]`、`analogical_prior_cards[]` 和逐 lane audit；单 lane 未执行、超时、拒绝或预算耗尽必须显式形成 partial 状态，不能伪装成零命中。

选择 B 的原因是：它减少模型在两个同名搜索工具之间的选择、顺序和去重错误，又在协议层保护当前事实与历史 prior 的信任边界。Option A 被否决，因为统一分数/TopK 会让当前事实与历史经验竞争并污染记账；Option C 被否决，因为它把调用顺序、共享预算、水位一致性和结果归类重新交给模型纪律。

## 十、后续设计分支的解决状态

本决定当时解锁的分支现已全部由后续稳定键闭合：

- `SearchPlan` 与 response envelope：`memory-search-schema/Q135-A`、`Q136-B`、`Q137-B`、`memory-envelope/Q138-A`、`Q139-B`；
- exact dispatch：`memory-exact-trigger/Q140-A`；
- exact limit 与 lane-local quotas：`memory-exact-limit/Q141-B`、`memory-lane-quota/Q142-A`；
- parent budget/deadline/cancellation：`memory-control-budget/Q143-A`、`memory-deadline/Q144-B`、`memory-cancellation/Q145-A`；
- partial failure 与 Hint grounding：`memory-partial-hint/Q146-B`；
- corpus onboarding、exact adapter、allocation、interleave 与 expansion：`memory-corpus-topology/Q147-B` 至 `memory-expansion-placement/Q155-B`；
- evidence escalation 保持既定 summary-first + selected raw AO capability 边界。

`memory-search-entry/Q134-B` 已定案；实现只能按 Option B 的边界推进。任何跨 lane 统一分数、统一 TopK 配额、证据语义合并或记账合并都需要新的显式决策。
