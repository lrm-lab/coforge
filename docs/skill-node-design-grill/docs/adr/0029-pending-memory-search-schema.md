# Memory SearchPlan 与统一 Response Envelope Schema

**Decision keys:** `memory-search-schema/Q135-A`、`memory-search-schema/Q136-B`、`memory-search-schema/Q137-B`、`memory-envelope/Q138-A`、`memory-envelope/Q139-B`
**Status:** `accepted`
**Decision:** `Q135=A / Q136=B / Q137=B / Q138=A / Q139=B`
**Depends on:** `memory-search-entry/Q134-B`

本 ADR 保存 `memory-search-entry/Q134-B` 解锁的第一个设计分支及 Q135–Q139 的完整选项分析。用户已选择：Q135-A 使用服务端签发的 opaque scope/snapshot/budget refs 与 operation ID/canonical plan hash 幂等；Q136-B 使用共享 semantic intent 加 typed exact clause；Q137-B 使用中央、版本化 use-class classifier；Q138-A 只公开最小 envelope metadata 并以受控 `auditRef` 承载完整审计；Q139-B 使用正交的 execution/result/reason LaneAudit 状态。未选选项继续保留为决策历史。

## 一、本分支要解决的问题

`memory-search-entry/Q134-B` 已经固定以下架构边界：

- 群 Memory Agent 只调用一个公共 `retrieve(SearchPlan)` interface；
- 模块内部保留 `current_log_exact` 与 `memory_discovery` 两条类型化 lane；
- 两条 lane 共享 principal/ACL、scope、pinned watermark、父级预算、超时、取消、查询去重与审计；
- 两条 lane 不共享排名分数、TopK 配额、停止条件、证据语义或 exposure/citation/utility 记账；
- response 必须机器级区分当前证据、记忆候选、历史类比和逐 lane 执行状态。

本分支要把这些边界转化为调用方可使用、实现方可验证的 interface，具体解决：

1. SearchPlan 如何引用可信 scope、snapshot、budget 与幂等身份；
2. current-log exact 和 memory-discovery 如何在同一个 plan 中表达查询；
3. memory-discovery 返回的异构对象如何稳定分入 `memoryCandidateCards` 与 `analogicalPriorCards`；
4. SearchPlanV1 与 RetrievalEnvelopeV1 的最低字段骨架；
5. 哪些字段属于 agent 可提交的 plan，哪些必须由服务端绑定的可信上下文提供。

### 本分支刻意不处理

以下内容虽然被 Q134-B 解锁，但属于后续独立分支，本 ADR 不提前拍板：

- 哪些情况下运行 `current_log_exact`、`memory_discovery` 或两者；
- exact lane 的命中数量上限；
- 两条 lane 如何分配父级预算和 TopK 配额；
- 一条 lane 失败时是否允许返回另一条 lane；
- partial failure 时是否允许生成 Memory Hint；
- planner 能否批准 evidence escalation，还是只能提出升级请求；
- `read_full_log` 的批准主体与升级流程。

## 二、涉及的现有实现与文件

### 1. OpenViking typed retrieval facade

文件：

```text
OpenViking/openviking/session/retrieval_facade.py
```

现有 `HybridRetrievalFacade.retrieve()` 接受：

```python
retrieve(
    query: RetrievalQuery | Mapping[str, Any] | str | None,
    principal_labels: Sequence[str],
    profile: RetrievalProfile | Mapping[str, Any] | None = None,
) -> RetrievalResult
```

现有类型包括：

```text
RetrievalQuery
  text
  dependency_pattern

RetrievalProfile
  fork_branch
  projection
  segment_atom
  provisional_slots
  rank_mode

RetrievalCard
  kind
  channel
  in_channel_rank
  status_label
  source_pointer
  payload_ref
  score_breakdown
  acl_labels
  selection_mode
  text

RetrievalResult
  cards
  feature_version
  truncated_by_rerank_clamp
  selection_audit
  rank_tier
```

现有 `RetrievalCard.kind` 覆盖：

```text
fork
branch
block_projection
claim_projection
segment
atom
```

现有 facade 已负责：

- Fork/Branch、Influence Projection、Segment/Atom 多 corpus 预召回；
- BM25 或 BM25+vector hybrid 初排；
- verified/provisional/fact 通道；
- corpus 配额与总帽；
- principal label ACL；
- provisional seeded exploration；
- lane 内 rank 与 score breakdown；
- final rerank clamp；
- claim neighborhood 有界展开。

它不能直接充当新的统一公共 interface，因为它没有 task scope、调用方提供的 pinned watermark、current-log exact query、请求幂等、Coforge episode/insight/skill、逐 lane audit 或 typed partial state。

当前 `FACT_LANE_PAUSED = True`，因此默认不会调用 Segment/Atom adapter，其空位也不会自动回填。这个实现状态必须保留在 adapter-native audit 中，不能被统一 envelope 隐藏。

### 2. OpenViking AO ledger reader

文件：

```text
OpenViking/openviking/session/ao_ledger_reader.py
```

现有能力包括：

- `issue_snapshot()` 生成冻结 AO ledger snapshot；
- `LedgerSnapshot` 保存 session、冻结行数、archive 集合和签发时间；
- `list_ao_ledger()` 在同一 watermark 下稳定分页；
- cursor 与 watermark fingerprint 绑定；
- `get_ao_evidence()` 对单条 AO 做 default-deny 来源 ACL 检查；
- 已提交和 snapshot 范围内 live AO 的区分。

重要现状：

- `list_ao_ledger()` 本身不是 evidence authorization；
- 当前没有论文式 literal/regex `T_log.search` adapter；
- `SegmentAtomAdapter` 每次自行签发 snapshot，不接受统一 plan 已固定的 snapshot，因此不能直接冒充 `current_log_exact`；
- 新 exact adapter 必须使用 plan 的 pinned snapshot，并对每个返回命中重新执行 evidence ACL。

### 3. Coforge Group Memory retrieval 与 exploration

文件：

```text
coforge/apps/web/src/server/group-memory/memory-similarity.server.ts
coforge/apps/web/src/server/group-memory/memory-exploration.server.ts
coforge/apps/web/src/server/group-memory/memory-expansion.server.ts
coforge/apps/web/src/server/group-memory/memory-offer.server.ts
```

现有 `MemorySimilarityIndex.findSeeds()` 返回：

```ts
type MemorySeed = {
  kind: "episode" | "insight" | "skill";
  id: string;
  score: number;
  snippet: string;
};
```

现有 bounded exploration 提供：

- `start → explore/redirect → close` 生命周期；
- Memory Agent designation fence；
- step/result budget；
- served-only citation grounding；
- session TTL；
- operation ID + canonical request hash 幂等；
- 相同 operation ID、不同请求内容时 drift conflict；
- operation effects 与 replay ledger 同事务提交。

这些机制是新统一模块幂等设计的重要先例，但现有 Coforge 检索没有 pinned watermark、per-item source ACL 或统一 lane audit。

`memory-offer.server.ts` 负责下游消息发布和投递副作用，必须留在 retrieval module 之外；否则只读 `retrieve()` interface 会被污染成读写混合 interface。

### 4. Coforge HTTP seam

文件：

```text
coforge/apps/web/src/routes/api/agent/v1/memory.ts
```

HTTP middleware 已提供可信：

```ts
type AgentMemoryPrincipal = {
  workspaceId: string;
  agentId: string;
};
```

因此 `workspaceId`、`agentId`、role、capability、backend handle 和运行时 cancellation signal 不应由 Memory Agent 在 SearchPlan 中自行声明。合适的 seam 是：

```text
agentAuthMiddleware
        ↓
bound role-scoped retrieval module
        ↓
current-log / OpenViking / Coforge adapters
```

route 只负责认证、严格 schema 解析和 transport error 映射，不负责 lane 编排。

## 三、Q134-B 已机械决定的 interface 骨架

无需在 Q135–Q137 中重开的部分：

```ts
interface RoleScopedRetrieval {
  retrieve(plan: SearchPlan): Promise<RetrievalEnvelope>;
}
```

模块创建时绑定可信上下文：

```ts
type BoundRetrievalContext = {
  principal: AuthenticatedPrincipal;
  capabilities: CapabilitySet;
  abortSignal: AbortSignal;
  policySet: RetrievalPolicySet;
  adapters: {
    currentLogExact: CurrentLogExactAdapter;
    openVikingMemory: OpenVikingMemoryAdapter;
    coforgeMemory: CoforgeMemoryAdapter;
  };
};
```

`BoundRetrievalContext` 是服务端依赖，不进入 agent 提交的 JSON。

response 至少必须包含：

```ts
type RetrievalEnvelope = {
  currentEvidenceRefs: CurrentEvidenceRef[];
  memoryCandidateCards: MemoryCandidateCard[];
  analogicalPriorCards: AnalogicalPriorCard[];
  laneAudit: {
    currentLogExact: LaneAuditV1;
    memoryDiscovery: LaneAuditV1;
  };
};
```

禁止出现无类型统一结果和跨 lane 全局排名：

```ts
// 禁止
type InvalidEnvelope = {
  results: Array<CurrentEvidenceRef | MemoryCard>;
  globalScore: number;
  globalRank: number;
};
```

以下事实同样已经固定：

- OpenViking causal-memory 与 Coforge group-memory 是 `memory_discovery` 的内部 adapters，不是额外公共工具；
- adapter-native kind、status、source pointer、score breakdown 和 selection audit 不得丢失；
- current evidence 只能由当前日志 lane 产生，中央分类器不能把历史 card 升级为 current evidence；
- exact hit 不自动产生 citation、adoption 或 utility；
- OpenViking selection audit 不能代替统一 lane audit；
- lane 未执行、失败、超时或被拒绝不能伪装成执行成功且零命中；
- full-log 内容不属于普通 retrieval envelope，`read_full_log` 仍是独立 escalation 能力。

## 四、Q135：SearchPlan 请求身份、可信范围与幂等

**Decision key:** `memory-search-schema/Q135-A`
**Status:** `accepted`

### 1. 背景

统一 retrieval module 必须知道：

- 这是哪个 task/run 的检索；
- 哪些 session/AO 属于允许搜索的当前日志；
- exact lane 使用哪个冻结 snapshot；
- 本次调用使用哪个父级预算；
- 网络重试是否是同一次逻辑操作；
- 相同 operation ID 下请求内容变化时是否应拒绝。

但这些字段不能成为 Memory Agent 的自我授权来源。尤其不能允许 agent 通过填写别人的 workspace、agent、session 或 ACL label 扩大权限。

### 2. Option A：SearchPlan 使用服务端签发的 opaque refs（已选）

#### 机制

```ts
type SearchPlan = {
  schemaVersion: "memory-search-plan.v1";
  operationId: string;
  query: SearchQuery;
  scopeRef: string;
  snapshotRef: string;
  budgetLeaseRef: string;
};
```

- `scopeRef` 由 orchestrator 签发，服务端解析为 task/run/session/range；
- `snapshotRef` 指向服务端冻结的 AO snapshot；
- `budgetLeaseRef` 指向父级预算，而不是客户端自报数值；
- `operationId` 由调用方提供；
- 服务端规范化 plan 并计算 canonical hash；
- 相同 operation ID + 相同 hash 可幂等重放；
- 相同 operation ID + 不同 hash 形成 drift conflict；
- principal、capability、deadline、abort signal 和 adapters 仍来自绑定上下文；
- refs 只是能力范围的引用，最终授权仍由服务端重新验证。

#### 优点

- agent 无法通过伪造 session ID 或 ACL label 扩大权限；
- plan 较小，调用方不需要理解 scope/snapshot/budget 内部结构；
- request replay 与 drift detection 边界清楚；
- AO watermark 内部编码不会变成公共长期契约；
- 与 Coforge operation ID + canonical request hash 先例兼容；
- scope、snapshot 或 budget 内部结构升级时无需修改所有调用者。

#### 权衡

- 需要 scope/snapshot/budget ref 的签发与解析模块；
- 只看 SearchPlan 无法知道全部实际范围；
- ref 不存在、过期、撤销或主体不匹配需要明确错误；
- 离线重放必须同时保存当时的 canonical resolution audit；
- 如果 refs 的生命周期过短，长时间重试或恢复可能失败。

#### 后果

选择 A 后，SearchPlan 是“查询 + 服务端能力引用”，不是完整执行上下文。response 应返回 canonical refs、plan hash 和审计引用，证明服务端实际解析了什么。

### 3. Option B：SearchPlan 只包含 query 和 operation ID（未选）

#### 机制

```ts
type SearchPlan = {
  schemaVersion: "memory-search-plan.v1";
  operationId: string;
  query: SearchQuery;
};
```

scope、snapshot 和 budget 完全从当前 MemoryTaskState 或服务端活 session 推导。

#### 优点

- interface 最小；
- agent 几乎无法伪造范围；
- 普通调用最简单；
- 不需要新的 ref 签发 interface。

#### 权衡

- 同一个 SearchPlan 在不同时间可能解析到不同 snapshot；
- 同一个 operation ID 到底绑定 run 3 还是 run 4 可能依赖活 session；
- 一个 Memory Agent 同时处理多个 task/run 时容易绑定错上下文；
- 离线审计必须依赖额外服务端日志才能还原实际输入；
- 很难显式表达“继续在先前 snapshot 上核验”；
- 活 session 会变成隐藏的 interface 和恢复依赖。

#### 后果

选择 B 后，模块高度依赖服务端有状态 session；SearchPlan 本身不能作为可移植、可重放的交接物。

### 4. Option C：SearchPlan 内联完整结构化范围（未选）

#### 机制

```ts
type SearchPlan = {
  schemaVersion: "memory-search-plan.v1";
  operationId: string;
  query: SearchQuery;
  scope: {
    workspaceId: string;
    taskId: string;
    runId: string;
    sessionIds: string[];
    sequenceRanges?: Array<{
      sessionId: string;
      start: number;
      end: number;
    }>;
  };
  currentLogWatermark: string;
  budget: {
    policyVersion: string;
    tokenLimit: number;
    timeLimitMs: number;
  };
};
```

principal 仍由服务端绑定，但 plan 内的全部范围和值都要逐项验证。

#### 优点

- 单独看 SearchPlan 就能理解请求范围；
- 离线重放和调试直观；
- 不需要额外 ref resolver；
- 可以精确表达多 session 和 sequence range。

#### 权衡

- interface 很宽，调用方必须理解内部 session/range/watermark/budget 结构；
- 每次 schema 演化都会影响所有调用者；
- agent 可以提交越权 ID，虽然服务端应拒绝，但攻击面与错误面更大；
- 当前 AO watermark 只是编码 token，不应被误解为授权凭证；
- 容易把客户端声明和服务端权威状态混为一体；
- 模块可能退化为浅薄的验证和转发层。

#### 后果

选择 C 后，scope 结构变化会扩散到调用方、route schema 和测试；服务端必须区分每个字段是请求偏好、范围断言还是权威输入。

### 5. 决策

选择 **Option A**。它在 interface 深度、可重放性和安全性之间最平衡：调用方显式固定 scope/snapshot/budget，但不需要理解其内部结构；服务端保留唯一授权权威。

### 6. 具体例子

Memory Agent 第一次查询：

```json
{
  "schemaVersion": "memory-search-plan.v1",
  "operationId": "op-deploy-failure-003",
  "query": {
    "intentText": "为什么数据库连接失败"
  },
  "scopeRef": "scope_task_92_run_3",
  "snapshotRef": "snapshot_ao_01JX",
  "budgetLeaseRef": "budget_eval_92"
}
```

网络断开后重试：

- **Option A**：同一 operation ID、refs 和 canonical plan hash，可以返回记录结果或在相同 snapshot 下重做；
- **Option B**：只有 query 和 operation ID；如果 server session 已推进到 run 4，无法从 plan 判断应绑定 run 3 还是 run 4；
- **Option C**：agent 必须重发 workspace、task、run、sessions、ranges、raw watermark 和 budget；任何一项漂移都需要复杂错误解释。

越权场景：agent 把其他群的 `scopeRef` 放入 Option A plan。服务端按 bound principal 解析时拒绝，不能因为 ref 可见或格式正确就授权。

### 7. 术语解释

- **Opaque ref**：调用方能保存和传递、但不需要理解内部结构的服务端引用。
- **Scope**：一次检索允许覆盖的 task、run、session 和步骤范围。
- **Snapshot**：冻结的读取视图，确保一次检索看到同一批数据。
- **Budget lease**：服务端签发的预算使用权引用，而不是调用方自报预算数字。
- **Idempotency**：相同逻辑请求重试时不会重复产生记账或不一致结果。
- **Operation ID**：调用方为一次逻辑操作分配的稳定标识。
- **Canonical plan hash**：服务端用规范字段顺序序列化 plan 后计算的哈希，用于检测请求漂移。
- **Drift**：同一幂等标识被用于不同请求内容。
- **Bound context**：模块创建时由服务端绑定的可信 principal、capability、取消信号和 adapters。
- **Authority**：真正有权决定范围或访问的服务端事实；客户端提供的 ref 不是授权本身。

## 五、Q136：SearchPlan Query 形状

**Decision key:** `memory-search-schema/Q136-B`
**Status:** `accepted`

### 1. 背景

现有 OpenViking `RetrievalQuery` 只有：

```python
RetrievalQuery {
    text
    dependency_pattern {
        wanted_artifact?
        wanted_effect?
    }
}
```

论文 `T_log.search` 则需要 literal 或 regex、匹配字段和大小写等精确语义。如果只保留一个自由文本，exact lane 无法知道特殊字符是否是正则。如果给两个 lane 完全独立 query，则调用方需要理解内部 lane 并重复表达任务意图。

本题只决定查询字段结构，不决定某字段是否自动触发某条 lane。

### 2. Option A：所有 lane 只共享一个自由文本（未选）

#### 机制

```ts
type SearchQuery = {
  text: string;
};
```

服务端自行决定：

- exact lane 把文本当 literal 还是 regex；
- memory lane 如何用作 BM25/vector query；
- 是否从文本推断 dependency pattern；
- 哪些日志字段参加精确匹配。

#### 优点

- interface 最小；
- 对 Memory Agent 最简单；
- 与当前 Coforge `query: string` 接近；
- 调用方不需要理解 exact 与 discovery 查询差异。

#### 权衡

- `error.*timeout` 究竟是正则还是普通文字不明确；
- exact 与 semantic intent 可能根本不是同一句话；
- 不能无损保留现有 OpenViking dependency pattern；
- 服务端需要隐藏的 query 推断规则，审计困难；
- 策略升级可能让同一文本产生不同解释；
- 正则特殊字符和自然语言 punctuation 难区分。

#### 后果

选择 A 后，query classifier 和隐式解释规则成为隐藏 interface；调用方无法确定服务端实际搜索了什么。

### 3. Option B：共享语义 intent，增加可选 typed exact clause（已选）

#### 机制

```ts
type SearchQuery = {
  intentText?: string;
  dependencyPattern?: {
    wantedArtifact?: string;
    wantedEffect?: string;
  };
  exact?: {
    expression: string;
    syntax: "literal" | "regex";
    fields?: Array<"action" | "observation" | "message">;
    caseSensitive?: boolean;
  };
};
```

不变量：

- `intentText`、`dependencyPattern`、`exact` 至少一个非空；
- unknown fields 拒绝；
- `intentText` 和 `dependencyPattern` 供 memory-discovery 使用；
- `exact` 定义 current-log exact 输入；
- 是否因为存在 `exact` 就执行 exact lane，留给后续触发策略；
- exact expression 不自动成为 memory-discovery query；
- semantic intent 不自动被解释成正则；
- 缺省 fields 和 case sensitivity 必须由版本化 policy 填充；
- regex 编译失败必须作为输入错误，而不是零命中。

#### 优点

- 一个 query 对象同时表达共同任务目标和 lane-specific 精确条件；
- 保留 OpenViking dependency pattern；
- literal 与 regex 不再靠猜；
- 无需重复两个完整 query；
- 可审计“语义上想找什么”和“当前日志精确匹配什么”；
- 将来可以扩展 exact field vocabulary 而不改变 semantic query。

#### 权衡

- schema 比单文本复杂；
- intent 和 exact expression 可能互相矛盾；
- regex 需要安全编译、复杂度限制和执行超时；
- searchable fields 必须是封闭词表；
- 仍需后续 lane trigger policy；
- 如果 exact clause 太灵活，可能成为昂贵日志查询语言。

#### 后果

选择 B 后，统一模块负责规范化 query，再向 adapters 分发对应片段；adapter 不得自行把 semantic intent 转成 regex 或把 exact expression 注入 semantic rank。

### 4. Option C：两个 lane 使用完全独立 query（未选）

#### 机制

```ts
type SearchQuery = {
  currentLogExact?: {
    expression: string;
    syntax: "literal" | "regex";
    fields?: Array<"action" | "observation" | "message">;
    caseSensitive?: boolean;
  };
  memoryDiscovery?: {
    text?: string;
    dependencyPattern?: {
      wantedArtifact?: string;
      wantedEffect?: string;
    };
  };
};
```

#### 优点

- 两条 lane 输入完全明确；
- 各 adapter 可以独立演化；
- 不需要从共享 intent 派生 query；
- 可以只表达某条 lane 的复杂条件。

#### 权衡

- 同一概念经常要写两次；
- 两段 query 可能语义漂移或互相冲突；
- agent 必须理解内部 lane 拓扑；
- 新增 discovery adapter 可能继续扩大公共 interface；
- 统一 facade 容易退化成并排包装两个工具。

#### 后果

选择 C 后，调用方需要理解更多实现细节，模块的深度和演化 locality 较差。

### 5. 决策

选择 **Option B**。它保留统一任务意图，同时让 exact search 的 literal/regex 语义显式、可审计，并复用现有 `dependency_pattern`。

### 6. 具体例子

用户问：

> 为什么支付服务部署后无法连接数据库？查一下是否出现过 ECONNREFUSED 或 timeout。

**Option A：**

```json
{
  "text": "为什么支付服务部署后无法连接数据库？ECONNREFUSED|timeout"
}
```

系统无法确定 `|` 是普通字符还是正则“或”，也无法确定整句是否应该进入 semantic retrieval。

**Option B：**

```json
{
  "intentText": "支付服务部署后数据库连接失败",
  "dependencyPattern": {
    "wantedArtifact": "database connection diagnostics",
    "wantedEffect": "identify deployment failure mechanism"
  },
  "exact": {
    "expression": "ECONNREFUSED|timeout",
    "syntax": "regex",
    "fields": ["observation", "message"],
    "caseSensitive": false
  }
}
```

memory-discovery 可查相似部署经验；exact lane 若被后续策略选择执行，则只搜索本次日志中的错误文本。

**Option C：**

```json
{
  "currentLogExact": {
    "expression": "ECONNREFUSED|timeout",
    "syntax": "regex"
  },
  "memoryDiscovery": {
    "text": "支付服务部署后数据库连接失败",
    "dependencyPattern": {
      "wantedEffect": "identify deployment failure mechanism"
    }
  }
}
```

表达清楚，但调用方必须理解两个内部 lane 并维护两个查询的语义一致性。

### 7. 术语解释

- **Query grammar**：查询对象允许哪些字段及字段如何组合的规则。
- **Intent text**：用自然语言描述想解决的问题，主要用于语义检索。
- **Dependency pattern**：用“需要什么产物、希望产生什么效果”表达因果依赖的结构化查询。
- **Literal search**：把输入当普通文字匹配，`.`、`*`、`|` 等符号没有特殊意义。
- **Regex**：正则表达式，可表达“或、重复、字符范围”等模式。
- **Case sensitive**：是否区分大小写。
- **Typed clause**：有明确字段和类型的查询片段，不依赖自然语言猜测。
- **Closed vocabulary**：只允许预定义值的字段集合，例如可搜索字段只能是 action、observation、message。
- **Unknown-field rejection**：请求带 schema 未定义字段时拒绝，避免拼写错误被静默忽略。
- **Query normalization**：服务端把等价输入整理为稳定格式，供 hashing、dispatch 和审计使用。

## 六、Q137：Response 结果分栏的 Use Class 分类

**Decision key:** `memory-search-schema/Q137-B`
**Status:** `accepted`

### 1. 背景

Q134-B 已要求 response 至少分为：

```text
currentEvidenceRefs[]
memoryCandidateCards[]
analogicalPriorCards[]
```

`currentEvidenceRefs` 只能来自 pinned current-log exact lane，指向当前任务真实 AO/step。但 memory-discovery 可能返回：

```text
fork
branch
block_projection
claim_projection
segment
atom
episode
insight
skill_revision
historical_subgraph
```

这些对象还具有不同状态：

```text
validated
provisional
invalidated
fact
active
retired
synthetic
observed
```

不能简单按“来自 OpenViking 还是 Coforge”分类，也不能允许 adapter 自己提升结果的证据等级。

### 2. Option A：在 schema 中固定 kind→bucket 对照表（未选）

#### 机制

例如：

```text
active skill revision       → memoryCandidateCards
active insight              → memoryCandidateCards
fork/branch                 → memoryCandidateCards
episode                     → analogicalPriorCards
block/claim projection      → analogicalPriorCards
segment/atom                → analogicalPriorCards
historical subgraph         → analogicalPriorCards
```

#### 优点

- 实现简单；
- classification 可预测；
- 不需要额外 policy module；
- 测试容易写成固定表；
- 相同 kind 在不同 adapter 中结果一致。

#### 权衡

- 同一种 kind 的不同状态无法自然细分；
- provisional、validated、invalidated fork 需要大量例外；
- synthetic 与 observed branch 可能被同等处理；
- 新增 kind 必须修改公共 schema 和调用者；
- 来源 task、适用性和 provenance 无法参与分类；
- 固定表会随着状态演化不断增长条件分支。

#### 后果

选择 A 后，bucket 语义被绑定到对象 kind；状态和治理变化会推动公共 schema 频繁修改。

### 3. Option B：中央 policy-versioned use-class classifier（已选）

#### 机制

所有 adapters 先返回 native card，统一模块根据标准化分类输入决定 use class：

```ts
type ClassificationInput = {
  kind: MemoryObjectKind;
  status: string;
  sourceTaskRelation: "same_task" | "cross_task";
  evidenceStatus?: string;
  synthetic?: boolean;
  executable?: boolean;
  offerEligible?: boolean;
  provenanceComplete: boolean;
};
```

中央 policy 输出：

```ts
type UseClass =
  | "memory_candidate"
  | "analogical_prior"
  | "excluded";
```

不变量：

- 每张 card 在一个 envelope 中最多进入一个 bucket；
- classifier 不能产生 `current_evidence`；
- adapter 无权自行提高 use class；
- classification policy version 写入 envelope/audit；
- native kind、status、source pointer 和 adapter audit 必须保留；
- `excluded` 对象不返回，也不能泄露其数量；
- provisional 对象进入 candidate 时必须保留显式 provisional 标签；
- 缺少关键状态或 provenance 时 fail closed，降为 prior 或 excluded；
- policy 只改变当前响应投影，不覆写原始对象。

建议的初始语义：

- `memory_candidate`：允许作为 Memory Hint、offer 或执行候选继续评估的对象，例如 active skill、active insight、可检索 Fork/Branch；
- `analogical_prior`：只能启发进一步核验的对象，例如 episode、Influence projection、historical subgraph、跨任务 Segment/Atom、similarity-only hit；
- `current_evidence`：中央 classifier 永远不能产生，只能来自 exact lane。

#### 优点

- kind 与使用语义解耦；
- 可以同时考虑状态、synthetic 标记、来源 task 和 provenance；
- 新 policy 可版本化，不改写原始 card；
- adapter 不掌握信任升级权；
- 适合未来增加新的 corpus；
- 分类规则集中，审计、测试和安全修复具有 locality。

#### 权衡

- 需要新增中央 classification policy；
- policy 变化可能让同一 card 在不同版本进入不同 bucket；
- envelope 必须记录 policy version；
- 缺字段和未知状态需要明确 fail-closed 规则；
- 组合状态较多，需要表驱动或属性测试；
- classifier 错误会同时影响多个 adapters，因此发布和回滚要版本化。

#### 后果

选择 B 后，统一 retrieval module 真正拥有“结果允许被怎样使用”的语义；adapter 只负责检索和报告原生状态。

### 4. Option C：每个 adapter 自己选择 bucket（未选）

#### 机制

```ts
type AdapterResult = {
  memoryCandidates: NativeCard[];
  analogicalPriors: NativeCard[];
};
```

OpenViking 和 Coforge adapters 分别分类，统一模块只拼接同名数组。

#### 优点

- 每个 adapter 最了解自己的对象；
- 中央模块实现简单；
- adapter 可以独立演化；
- 不需要统一所有来源状态词汇。

#### 权衡

- adapter 同时掌握召回和信任分类，容易自我升级；
- OpenViking 与 Coforge 可能对 candidate 使用不同定义；
- policy 无法统一审计；
- 改规则需要修改多个 adapters；
- 测试和安全逻辑分散；
- 统一 envelope 虽有三个数组，语义却可能随来源系统变化。

#### 后果

选择 C 后，调用方仍需理解来源 adapter，统一 module 的 locality 和信任治理能力较弱。

### 5. 决策

选择 **Option B**。信任分类由统一 retrieval module 的版本化 policy 集中完成，而不是按 kind 永久写死或由 adapter 自报。

### 6. 具体例子

memory-discovery 返回四个 native objects：

```json
[
  {
    "kind": "skill_revision",
    "status": "active",
    "id": "skill-rev-17"
  },
  {
    "kind": "fork",
    "status": "provisional",
    "id": "fork-rev-92"
  },
  {
    "kind": "claim_projection",
    "status": "provisional",
    "id": "claim-card-31"
  },
  {
    "kind": "episode",
    "status": "observed",
    "id": "episode-8"
  }
]
```

**Option A** 按固定 kind：

```text
skill、fork → memory candidates
projection、episode → analogical priors
```

如果 fork 后来 invalidated，固定表必须增加状态例外。

**Option B** 由版本化 policy 分类：

```json
{
  "memoryCandidateCards": [
    {
      "kind": "skill_revision",
      "status": "active",
      "id": "skill-rev-17"
    },
    {
      "kind": "fork",
      "status": "provisional",
      "id": "fork-rev-92",
      "warnings": ["provisional"]
    }
  ],
  "analogicalPriorCards": [
    {
      "kind": "claim_projection",
      "id": "claim-card-31"
    },
    {
      "kind": "episode",
      "id": "episode-8"
    }
  ],
  "classificationPolicyVersion": "memory-use-class.v1"
}
```

如果 fork 后来 invalidated，policy 会把它标为 `excluded`；原始 ForkRevision 不被覆写。

**Option C** 由 adapters 分类。若 Coforge 把所有 episode 叫 candidate，而 OpenViking 把所有 projection 叫 prior，统一调用方仍必须理解两个来源系统对 candidate 的不同定义。

### 7. 术语解释

- **Bucket**：response 中放置相同使用语义对象的数组。
- **Use class**：检索结果允许被怎样使用，例如当前候选、历史类比或排除。
- **Classifier**：根据 kind、状态和 provenance 决定 use class 的 policy module。
- **Policy version**：标识使用哪一版分类规则，便于审计、回滚和重算。
- **Discriminated union**：通过 `kind` 字段区分不同对象结构的类型联合。
- **Native card**：adapter 按来源系统原生语义返回的检索卡片。
- **Source pointer**：能回到原始对象的稳定引用，例如 fork revision ID 或 skill revision ID。
- **Provenance**：对象来源、证据和处理链记录。
- **Fail closed**：关键字段缺失或状态未知时不猜测升级，而是降为 prior 或排除。
- **Synthetic**：由模型想象或生成，而不是由真实执行观察得到的内容。
- **Offer eligible**：对象是否允许成为 Memory Agent 向任务 agent 投递的候选来源。
- **Excluded**：不进入响应的对象；为了防侧信道，也不向调用方暴露排除数量。

## 七、决策组合

已定决策为：

```text
memory-search-schema/Q135-A
memory-search-schema/Q136-B
memory-search-schema/Q137-B
```

组合意图：

- 以 opaque refs 固定可信 scope/snapshot/budget，同时保持服务端授权权威；
- 用共享 semantic intent + typed exact clause 表达两类查询，不依赖隐式正则推断；
- 用中央、版本化 use-class policy 统一不同 adapters 的结果使用语义；
- 保持一个小的公共 interface，把 ACL、snapshot、dispatch、classification、audit 和 native adapter 复杂度隐藏在深模块内部。

三个决策均已 accepted；Q135/Q136/Q137 的 A/B/C 分析继续保留，其中未选选项不是现行 schema。

## 八、SearchPlanV1 Schema 骨架

以下骨架落实已接受的 `memory-search-schema/Q135-A` 与 `memory-search-schema/Q136-B`：

```ts
type SearchPlanV1 = {
  schemaVersion: "memory-search-plan.v1";

  /** 调用方提供的逻辑操作幂等键。 */
  operationId: string;

  query: {
    /** 跨 memory-discovery adapters 的共同自然语言意图。 */
    intentText?: string;

    /** 沿用 OpenViking dependency-pattern 查询能力。 */
    dependencyPattern?: {
      wantedArtifact?: string;
      wantedEffect?: string;
    };

    /** current-log exact lane 的显式精确表达。 */
    exact?: {
      expression: string;
      syntax: "literal" | "regex";
      fields?: Array<"action" | "observation" | "message">;
      caseSensitive?: boolean;
    };
  };

  /** 由服务端签发并重新验证，不是 agent 自我授权。 */
  scopeRef: string;
  snapshotRef: string;
  budgetLeaseRef: string;
};
```

已定不变量：

- `schemaVersion` 必填且严格匹配；
- `operationId` 非空并满足封闭格式；
- query 三个主字段至少一个非空；
- unknown fields 拒绝；
- refs 必须能在 bound principal 下解析并相互一致；
- 服务端规范化 plan 后计算 `planHash`；
- 同 operation ID + 不同 plan hash 形成 drift conflict；
- role、principal、capability、deadline、abort signal、adapter handles 不进入 agent-authored JSON；
- lane trigger、exact limit 和配额尚未由本 schema 决定。

## 九、RetrievalEnvelopeV1 Schema 骨架

以下骨架落实已接受的 `memory-search-schema/Q135-A`、`memory-search-schema/Q137-B`、`memory-envelope/Q138-A` 与 `memory-envelope/Q139-B`：

```ts
type RetrievalEnvelopeV1 = {
  schemaVersion: "memory-retrieval-envelope.v1";

  operationId: string;
  planHash: string;
  duplicate: boolean;

  resolvedContext: {
    scopeRef: string;
    snapshotRef: string;
    budgetLeaseRef: string;
  };

  currentEvidenceRefs: CurrentEvidenceRef[];
  memoryCandidateCards: MemoryCandidateCard[];
  analogicalPriorCards: AnalogicalPriorCard[];

  classificationPolicyVersion: string;

  laneAudit: {
    currentLogExact: LaneAuditV1;
    memoryDiscovery: LaneAuditV1;
  };

  auditRef: string;
};
```

`memory-envelope/Q138-A` 的 metadata 语义：

- `schemaVersion`、`operationId`、`planHash`、`duplicate`、canonical `resolvedContext`、`policyVersions.useClass` 与 `auditRef` 是公共必填字段；
- 不新增第二个 `retrievalId`，避免逻辑 operation 与物理 attempt 身份混淆；
- 不向 Memory Agent 暴露 started/completed timestamps、elapsed time、精确 budget consumption/remaining、principal/ACL labels、raw watermark、adapter topology、excluded counts 或 stack trace；
- 完整运行诊断、成本、安全和 adapter-native audit 由 `auditRef` 指向的受控服务端记录承载；
- request/auth/scope/schema/plan-drift 错误仍走外层 transport error，不伪装成成功 envelope 或 LaneAudit。

已定的分栏类型：

```ts
type CurrentEvidenceRef = {
  kind: "current_log_match";
  sourceSessionRef: string;
  aoId: string;
  sequence: number;
  matchedField: "action" | "observation" | "message";
  matchFragment: string;
  snapshotRef: string;
  evidenceRef: string;
};

type MemoryObjectKind =
  | "fork"
  | "branch"
  | "block_projection"
  | "claim_projection"
  | "segment"
  | "atom"
  | "episode"
  | "insight"
  | "skill_revision"
  | "historical_subgraph";

type NativeScore = {
  adapter: string;
  rankTier?: string;
  inChannelRank?: number;
  scoreBreakdown?: Record<string, unknown>;
};

type MemoryCandidateCard = {
  useClass: "memory_candidate";
  kind: MemoryObjectKind;
  payloadRef: string;
  sourcePointer: Record<string, unknown>;
  statusLabel: string;
  snippet: string;
  nativeScore?: NativeScore;
  warnings: string[];
};

type AnalogicalPriorCard = {
  useClass: "analogical_prior";
  kind: MemoryObjectKind;
  payloadRef: string;
  sourcePointer: Record<string, unknown>;
  statusLabel: string;
  snippet: string;
  nativeScore?: NativeScore;
  synthetic: boolean;
  warnings: string[];
};
```

`memory-envelope/Q139-B` 将 LaneAudit 定为正交状态摘要，而不是单一组合枚举或内部事件时间线：

```ts
type LaneName =
  | "current_log_exact"
  | "memory_discovery";

type LaneExecutionState =
  | "not_dispatched"
  | "completed"
  | "terminated";

type LaneResultState =
  | "none"
  | "empty"
  | "hits";

type LaneReasonCode =
  | "not_selected"
  | "access_denied"
  | "deadline_exceeded"
  | "cancelled"
  | "budget_exhausted"
  | "dependency_unavailable"
  | "internal_error";

type LaneAuditV1 = {
  lane: LaneName;
  executionState: LaneExecutionState;
  resultState: LaneResultState;
  reasonCode: LaneReasonCode | null;
  returnedCount: number;
  truncated: boolean;
  featureVersions: Record<string, string>;
  nativeAuditRefs: string[];
};
```

状态不变量：

- `not_dispatched` 必须搭配 `resultState=none`、`reasonCode=not_selected`、`returnedCount=0`；
- `completed` 必须搭配 `resultState=empty|hits` 且 `reasonCode=null`；
- `completed+empty` 的 `returnedCount=0`；`completed+hits` 的 `returnedCount>0`；
- `terminated` 必须携带非 `not_selected` 的终止 reason；schema 允许未来出现 `terminated+hits`，但是否公开部分结果仍由后续 partial-return policy 决定；
- `returnedCount` 只统计 envelope 中公开的已授权对象，不包含 ACL/classifier 排除对象；
- `truncated` 只表示存在更多已授权 lane-local 结果因该 lane 限制未返回，不表达隐藏对象数量；
- `featureVersions` 使用封闭、非敏感版本键；
- `nativeAuditRefs` 只保存 opaque refs，不内联 selection audit、eligible set 或 adapter event timeline。

约束：

- response 不提供 global score/global rank；
- `nativeScore` 只能在来源 lane 内解释；
- current evidence 必须绑定本次 snapshot；
- memory card 不得因分类进入 current evidence；
- `classificationPolicyVersion` 必填，落实 `memory-search-schema/Q137-B`；
- `duplicate`、`planHash` 和 resolved opaque refs 必填，落实 `memory-search-schema/Q135-A`；
- 未请求、零命中与不可用必须能被最终 LaneAudit 区分；后续 `memory-partial-hint/Q146-B` 已固定 completed results 可公开、terminated intermediate hits 不公开及 complete/partial/unavailable 派生规则；
- adapter-native ACL labels 不应直接暴露给 agent，避免泄露安全结构；服务端只返回已经过授权的对象；
- `auditRef` 指向受控服务端审计记录，不内联隐藏对象数或敏感错误细节。

### 示例 JSON

以下示例演示已接受的 Q135-A/Q136-B/Q137-B schema 形状，不决定 lane trigger、配额或 partial-failure policy：

```json
{
  "schemaVersion": "memory-retrieval-envelope.v1",
  "operationId": "op-deploy-failure-003",
  "planHash": "sha256:60a2f5...",
  "duplicate": false,
  "resolvedContext": {
    "scopeRef": "scope_task_92_run_3",
    "snapshotRef": "snapshot_ao_01JX",
    "budgetLeaseRef": "budget_eval_92"
  },
  "currentEvidenceRefs": [
    {
      "kind": "current_log_match",
      "sourceSessionRef": "session_backend_agent_2",
      "aoId": "ao-184",
      "sequence": 184,
      "matchedField": "observation",
      "matchFragment": "ECONNREFUSED 10.0.0.8:5432",
      "snapshotRef": "snapshot_ao_01JX",
      "evidenceRef": "evidence:ao-184@sha256:8db5..."
    }
  ],
  "memoryCandidateCards": [
    {
      "useClass": "memory_candidate",
      "kind": "skill_revision",
      "payloadRef": "skill:skill-rev-17",
      "sourcePointer": {
        "skillRevisionId": "skill-rev-17"
      },
      "statusLabel": "active",
      "snippet": "检查 PostgreSQL TLS 与 endpoint readiness",
      "nativeScore": {
        "adapter": "coforge_group_memory",
        "scoreBreakdown": {
          "trigram": 0.73
        }
      },
      "warnings": []
    }
  ],
  "analogicalPriorCards": [
    {
      "useClass": "analogical_prior",
      "kind": "claim_projection",
      "payloadRef": "claim-card-31",
      "sourcePointer": {
        "viewRevisionId": "view-rev-8",
        "claimId": "claim-endpoint-readiness"
      },
      "statusLabel": "provisional",
      "snippet": "endpoint 未更新可能导致连接被拒绝",
      "nativeScore": {
        "adapter": "openviking_causal_memory",
        "rankTier": "hybrid",
        "inChannelRank": 2,
        "scoreBreakdown": {
          "bm25": 0.61,
          "vector": 0.82
        }
      },
      "synthetic": false,
      "warnings": ["provisional", "not_current_evidence"]
    }
  ],
  "classificationPolicyVersion": "memory-use-class.v1",
  "laneAudit": {
    "currentLogExact": {
      "lane": "current_log_exact",
      "executionState": "completed",
      "resultState": "hits",
      "reasonCode": null,
      "returnedCount": 1,
      "truncated": false,
      "featureVersions": {
        "exactMatcher": "current-log-exact.v1"
      },
      "nativeAuditRefs": ["audit:exact:901"]
    },
    "memoryDiscovery": {
      "lane": "memory_discovery",
      "executionState": "completed",
      "resultState": "hits",
      "reasonCode": null,
      "returnedCount": 2,
      "truncated": false,
      "featureVersions": {
        "openVikingRanker": "ranker-feature-spec-v1",
        "coforgeSimilarity": "pg-trgm-v1"
      },
      "nativeAuditRefs": ["audit:ov:431", "audit:coforge:772"]
    }
  },
  "auditRef": "audit:unified-retrieval:op-deploy-failure-003"
}
```

## 十、Q135–Q137 已定决策

```text
memory-search-schema/Q135-A
memory-search-schema/Q136-B
memory-search-schema/Q137-B
```

因此：

- SearchPlanV1 使用 operation ID 和服务端签发、逐次重验的 opaque `scopeRef`、`snapshotRef`、`budgetLeaseRef`；
- Query 使用共享 `intentText`、可选 `dependencyPattern` 与显式 typed `exact` clause；
- memory-discovery native cards 由中央、版本化 use-class classifier 分成 `memory_candidate`、`analogical_prior` 或 `excluded`；
- 三个问题的未选选项保留为决策历史，不是现行 schema。

Q138/Q139 的完整分析与定案记录见下文，第一分支最终闭合结论见第十三节。

## 十一、Q138：RetrievalEnvelopeV1 公共 Metadata

**Decision key:** `memory-envelope/Q138-A`
**Status:** `accepted`

### 1. 背景与现有实现

Q135-A 已固定 `operationId`、opaque `scopeRef`/`snapshotRef`/`budgetLeaseRef`、canonical `planHash` 与 replay/drift 语义；Q137-B 要求公开 use-class policy version。本题决定在这些必要身份之外，是否把执行时间、预算消耗、adapter 明细和内部诊断直接返回给 Memory Agent。

现有参考：

- `coforge/apps/web/src/server/group-memory/memory-exploration.server.ts` 对外只返回 `duplicate`，内部保存 operation ID、canonical request hash 和原始响应；
- `coforge/apps/web/src/routes/api/agent/v1/memory.ts` 使用 `{ok:true}` / `{ok:false,errorCode}` transport envelope 和 `cache-control:no-store`；
- `OpenViking/openviking/session/retrieval_facade.py` 返回 `feature_version`、`rank_tier`、`truncated_by_rerank_clamp` 与 `selection_audit`，但这些属于 adapter-native audit，不是统一 envelope metadata。

认证失败、SearchPlan schema 错误、scope ref 越权、snapshot/scope 不匹配和 plan drift 都发生在合法 lane 调度之前，继续由外层 request/transport error 表达。

### 2. Option A：最小公共 Metadata + 受控 auditRef（已选）

#### 机制

```ts
type EnvelopeMetadataV1 = {
  schemaVersion: "memory-retrieval-envelope.v1";
  operationId: string;
  planHash: string;
  duplicate: boolean;
  resolvedContext: {
    scopeRef: string;
    snapshotRef: string;
    budgetLeaseRef: string;
  };
  policyVersions: {
    useClass: string;
  };
  auditRef: string;
};
```

只公开调用方消费结果、验证重放和引用审计所需的稳定字段。完整执行时间线、预算明细、安全诊断和 adapter-native audit 存入受控 audit plane，由 `auditRef` 关联。

#### 优点

- interface 小且稳定，adapter 可独立演化；
- 幂等身份、canonical context 和 policy version 足以解释结果；
- 不暴露 principal/ACL labels、隐藏对象数、父预算余额或 backend topology；
- 减少通过耗时、排除数量和预算差异形成的侧信道；
- Memory Agent 不需消费与任务无关的 observability 噪声；
- 复杂审计隐藏在一个受控 ref 后，保持模块深度。

#### 权衡

- Memory Agent 不能直接解释慢查询或精确成本；
- 运行调查需另行读取 auditRef；
- audit store 不可用时，公开 envelope 不能独立提供完整诊断；
- 谁可以读取 auditRef 仍由审计权限策略决定，但不扩展本 response schema。

#### 后果

Public envelope 是业务结果信封，不是 observability dump。不新增 `retrievalId`，避免逻辑 operation 与物理 attempt 两套身份进入调用方 interface；首次和重放只由 `duplicate` 区分。

### 3. Option B：公共 Metadata 加执行摘要（未选）

#### 机制

在 Option A 基础上增加 `retrievalId`、original retrieval link、started/completed timestamps、elapsedMs 和 budget consumed/remaining。

```ts
type ExecutionSummary = {
  retrievalId: string;
  replay: {
    duplicate: boolean;
    originalRetrievalId?: string;
  };
  execution: {
    startedAt: string;
    completedAt: string;
    elapsedMs: number;
  };
  budgetSummary: {
    consumedUnits: number;
    remainingUnits?: number;
  };
};
```

#### 优点

- 调用者无需读 audit store 即可观察延迟和预算；
- 可区分逻辑 operation 与物理 attempt；
- UI 和 agent 可以对慢查询或预算紧张作出反应。

#### 权衡

- `retrievalId`、`operationId`、`auditRef` 三种身份容易混淆；
- replay 是否生成新 retrievalId 成为公共语义；
- 时间可泄露负载、缓存状态或隐藏 corpus 大小；
- remaining budget 泄露父任务资源；
- budget unit 随实现变化难稳定；
- interface 同时承担业务结果与 telemetry，兼容成本上升。

#### 后果

选择 B 会迫使预算计量单位、attempt 语义和时间精度成为长期 interface，因此未选。

### 4. Option C：内联完整执行和 Adapter Audit（未选）

#### 机制

在 response 中直接返回完整 scope/session/ranges/raw watermark、principal/ACL labels、adapter events、内部 timings、预算和 excluded counts。

#### 优点

- 单个 response 包含最多调试信息；
- 离线复盘无需访问 audit store；
- adapter 开发阶段观察方便。

#### 权衡

- 暴露 ACL labels、完整 scope 和 excluded counts，形成安全侧信道；
- raw watermark 容易被误解为 bearer credential；
- adapter 拓扑和内部事件成为公共 interface；
- 每次 adapter 拆分或并行化都可能破坏兼容；
- token 成本和模型噪声显著增加；
- 模块退化为浅薄的数据转发层。

#### 后果

Option C 违反 ACL-safe 聚合和深模块原则，因此未选。

### 5. 具体例子

首次调用的 Option A metadata：

```json
{
  "schemaVersion": "memory-retrieval-envelope.v1",
  "operationId": "op-deploy-003",
  "planHash": "sha256:60a2f5...",
  "duplicate": false,
  "resolvedContext": {
    "scopeRef": "scope_task_92_run_3",
    "snapshotRef": "snapshot_ao_01JX",
    "budgetLeaseRef": "budget_eval_92"
  },
  "policyVersions": {
    "useClass": "memory-use-class.v1"
  },
  "auditRef": "audit:retrieval:op-deploy-003"
}
```

网络断开后相同 operationId + planHash 重试，返回同一业务结果并设 `duplicate=true`。Option B 还会新增 attempt/retrieval identity、时间和预算；Option C 会进一步内联 session、ACL 和 adapter 明细。已选 A 只保留稳定业务身份。

### 6. 术语解释

- **Envelope metadata**：描述整个 retrieval response 身份和上下文的字段，不属于某张结果卡片。
- **Operation ID**：调用方为一次逻辑检索分配的稳定标识。
- **Plan hash**：服务端对规范化 SearchPlan 计算的哈希，用于检测请求漂移。
- **Duplicate replay**：相同 operation ID 和 plan hash 再次提交时返回已记录结果。
- **Resolved context**：服务端验证后实际采用的 scope/snapshot/budget refs。
- **Policy version**：本次结果使用的规则版本。
- **Audit ref**：指向受控完整审计记录的 opaque 引用。
- **Telemetry**：耗时、预算、缓存等运行数据。
- **Side channel**：通过数量、时间或错误差异间接泄露不可见数据。
- **Native audit**：具体 adapter 自己生成的内部审计，例如 OpenViking selection audit。

## 十二、Q139：LaneAudit 正交状态 Schema

**Decision key:** `memory-envelope/Q139-B`
**Status:** `accepted`

### 1. 背景与现有实现

Q134-B 要求逐 lane audit，并能区分 lane 未执行、执行完成但零命中、执行完成且有结果，以及超时、取消、预算耗尽、权限拒绝或依赖不可用。OpenViking `RetrievalResult` 只有 rank/selection metadata，Coforge exploration 主要公开 `duplicate/state/remainingSteps`；两者都没有统一 lane 状态。

本题只决定状态 schema 的表达能力，不决定：

- 哪些条件触发某条 lane；
- lane 的命中上限或预算；
- 一条 lane 终止后是否返回另一条 lane；
- `terminated+hits` 是否允许把部分结果放入 envelope；
- partial envelope 是否可生成 Memory Hint。

Request-level 的认证、schema、scope、snapshot 和 plan-drift 错误继续由外层 transport error 表达，不进入 LaneAudit。

### 2. Option A：单一平铺状态枚举（未选）

#### 机制

```ts
type FlatLaneStatus =
  | "not_requested"
  | "complete_hits"
  | "complete_empty"
  | "access_denied"
  | "timeout"
  | "cancelled"
  | "budget_exhausted"
  | "dependency_unavailable"
  | "internal_error";
```

#### 优点

- 易读且 JSON 短；
- 调用方只需 switch 一个字段；
- 初期实现简单。

#### 权衡

- execution、result 和 reason 被压进一个字符串；
- 无法自然表示 timeout 前已有三条结果；
- 增加 degraded/cache/fallback 等独立维度时枚举快速膨胀；
- 合法状态组合无法通过字段不变量单独验证。

#### 后果

Option A 很可能在 partial-result policy 落地时需要 schema v2，因此未选。

### 3. Option B：正交 Execution、Result 与 Reason（已选）

#### 机制

```ts
type LaneName =
  | "current_log_exact"
  | "memory_discovery";

type LaneExecutionState =
  | "not_dispatched"
  | "completed"
  | "terminated";

type LaneResultState =
  | "none"
  | "empty"
  | "hits";

type LaneReasonCode =
  | "not_selected"
  | "access_denied"
  | "deadline_exceeded"
  | "cancelled"
  | "budget_exhausted"
  | "dependency_unavailable"
  | "internal_error";

type LaneAuditV1 = {
  lane: LaneName;
  executionState: LaneExecutionState;
  resultState: LaneResultState;
  reasonCode: LaneReasonCode | null;
  returnedCount: number;
  truncated: boolean;
  featureVersions: Record<string, string>;
  nativeAuditRefs: string[];
};
```

#### 优点

- 执行、结果和终止原因彼此独立；
- 未调度与执行后零命中机器级可分；
- 能表达未来 `terminated+hits`，无需现在决定是否公开 partial result；
- 不需要为每种组合新增状态字符串；
- 适合表驱动验证和属性测试；
- adapter-native audit 留在 opaque refs 后；
- 不暴露 ACL-filtered 或 classifier-excluded 数量。

#### 权衡

- 字段比单一 status 多；
- 调用方必须理解合法组合；
- 服务端需要严格状态 validator；
- reason taxonomy 和 feature-version key 需要版本化封闭词表。

#### 后果

LaneAudit 成为一个小型结果状态机，而不是 observability event log。后续 partial-return policy 只需限制哪些既有状态组合可公开，不必重做 schema。

### 4. Option C：返回内部执行事件时间线（未选）

#### 机制

返回 `lane_selected`、`adapter_started`、`adapter_completed`、`adapter_failed`、`lane_completed` 等逐阶段事件及时间戳、adapter 名称和完整 native audit。

#### 优点

- 调试最丰富；
- 可分析并行、取消、重试和 adapter 顺序；
- incident 调查直观。

#### 权衡

- 暴露内部执行拓扑、时间和错误差异；
- 可能泄露隐藏 corpus、eligible set 或对象数量；
- replay 时返回原时间线还是新 attempt 时间线语义复杂；
- adapter 重构会破坏公共 interface；
- Memory Agent 获得大量任务无关信息。

#### 后果

Option C 将 observability log 变成业务协议，削弱模块深度，因此未选。

### 5. 状态不变量

```text
executionState=not_dispatched
  → resultState=none
  → reasonCode=not_selected
  → returnedCount=0

executionState=completed
  → resultState=empty|hits
  → reasonCode=null
  → empty 时 returnedCount=0
  → hits 时 returnedCount>0

executionState=terminated
  → reasonCode=access_denied|deadline_exceeded|cancelled|
               budget_exhausted|dependency_unavailable|internal_error
  → resultState=none，或未来 policy 允许时为 hits
```

- `returnedCount` 只统计 public envelope 内的已授权对象；
- `truncated` 只说明更多已授权结果因 lane-local 限制未返回；
- `featureVersions` 只暴露 matcher/ranker/policy 的非敏感版本；
- `nativeAuditRefs` 不内联 eligible set、selection propensity 或事件时间线；
- 不返回 ACL-filtered、use-class excluded 或不可见对象数量。

### 6. 具体例子

执行完成但零命中：

```json
{
  "lane": "current_log_exact",
  "executionState": "completed",
  "resultState": "empty",
  "reasonCode": null,
  "returnedCount": 0,
  "truncated": false,
  "featureVersions": {
    "exactMatcher": "current-log-exact.v1"
  },
  "nativeAuditRefs": ["audit:exact:901"]
}
```

未调度：

```json
{
  "lane": "memory_discovery",
  "executionState": "not_dispatched",
  "resultState": "none",
  "reasonCode": "not_selected",
  "returnedCount": 0,
  "truncated": false,
  "featureVersions": {},
  "nativeAuditRefs": []
}
```

超时前已经生成三条候选：

```json
{
  "lane": "memory_discovery",
  "executionState": "terminated",
  "resultState": "hits",
  "reasonCode": "deadline_exceeded",
  "returnedCount": 3,
  "truncated": false,
  "featureVersions": {
    "openVikingRanker": "ranker-feature-spec-v1"
  },
  "nativeAuditRefs": ["audit:ov:431"]
}
```

最后一个例子只证明 schema 能表达该状态；是否允许实际返回三条候选仍由后续 partial-return policy 决定。

### 7. 术语解释

- **Lane audit**：描述某条 retrieval lane 是否执行、产生何种公开结果及如何结束的结构化摘要。
- **Execution state**：未调度、完成或提前终止。
- **Result state**：没有结果语义、零命中或有命中。
- **Reason code**：未调度或终止的稳定机器原因。
- **Orthogonal fields**：不同字段分别表达不同维度，避免组合状态爆炸。
- **Flat enum**：把所有状态组合压进一个枚举。
- **Cartesian product**：多个独立维度组合后导致状态数量快速增长。
- **Truncated**：还有更多已授权结果，但因 lane-local 限制未全部返回。
- **Returned count**：实际出现在 public response 中的对象数。
- **Feature version**：matcher、ranker 或 policy 的版本标识。
- **Native audit ref**：指向 adapter 内部审计的 opaque 引用。
- **Termination**：lane 没有正常完成，例如超时或取消。
- **Partial result**：终止前已产生的部分结果；返回政策另行决定。
- **Request-level error**：合法 lane 调度前发生的认证、schema、scope 或 drift 错误。

## 十三、第一分支闭合结论

SearchPlan 与统一 response envelope schema 分支已由以下稳定键完整闭合：

```text
memory-search-entry/Q134-B
memory-search-schema/Q135-A
memory-search-schema/Q136-B
memory-search-schema/Q137-B
memory-envelope/Q138-A
memory-envelope/Q139-B
```

最终外部 interface：

```ts
interface RoleScopedRetrieval {
  retrieve(plan: SearchPlanV1): Promise<RetrievalEnvelopeV1>;
}
```

SearchPlanV1 定论：

- 使用 `operationId` 和服务端签发、逐次重验的 opaque `scopeRef`、`snapshotRef`、`budgetLeaseRef`；
- 服务端 canonicalize plan 并计算 `planHash`，同 operationId+同 hash 幂等重放、同 ID+不同 hash 拒绝；
- query 使用共享 `intentText`、可选 `dependencyPattern` 与显式 typed `exact` clause；
- principal、role/capability、deadline/cancellation 和 adapters 由服务端绑定，不由 agent 自报。

RetrievalEnvelopeV1 定论：

- 最小公共 metadata 为 schemaVersion、operationId、planHash、duplicate、resolved opaque refs、use-class policy version 和 auditRef；
- 结果分为 currentEvidenceRefs、memoryCandidateCards、analogicalPriorCards；
- 中央版本化 classifier 将 native memory cards 分为 memory_candidate、analogical_prior 或 excluded，不能产生 current evidence；
- 两条 lane 使用正交 execution/result/reason LaneAudit；
- 不提供 global score/rank，不公开 ACL labels、excluded counts、精确 budget/timing 或 adapter event timeline；
- 完整运行审计通过受控 auditRef/nativeAuditRefs 访问；
- request-level errors 留在 transport envelope 之外层错误路径。

本 ADR 文件名中的 `pending` 仅为稳定路径遗留，文件内容与第一分支均已 accepted。下一分支只处理 exact-lane 触发条件。命中上限、配额、partial-return policy 和 evidence-escalation authority 继续保持未展开。
