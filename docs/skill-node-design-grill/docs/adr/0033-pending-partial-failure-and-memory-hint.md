# Partial Failure 与 Memory Hint 生成规则

**Decision key:** `memory-partial-hint/Q146-B`
**Status:** `accepted`
**Decision:** Option B
**Depends on:** `memory-envelope/Q139-B`、`memory-control-budget/Q143-A`、`memory-deadline/Q144-B`、`memory-cancellation/Q145-A`

本 ADR 记录一条 retrieval lane 失败或终止时，哪些结果可以公开、最终 RetrievalEnvelope 如何驱动 Memory Hint/Offer，以及一成一败时如何表达完整性和来源。用户已选择 Option B：completed lane results 可公开，terminated lane intermediate hits 隔离且不公开，只有 completed memory-discovery 的 public memory candidates 可在服务端 verified served-only provenance 下生成 complete/partial Hint。A/C 全文保留为未选决策历史。

## 一、本分支要解决的问题

Q145-A 已允许一条 lane 因 child deadline、budget 或 dependency 终止时，独立 sibling 继续。因此同一个 RetrievalEnvelope 可能出现：

```text
current_log_exact = completed
memory_discovery  = terminated
```

或：

```text
current_log_exact = terminated
memory_discovery  = completed
```

Q139-B 的 LaneAudit schema 已能表达 `terminated+hits`，但此前只保留表达能力，并未授权将 terminated lane 的中间 hits 放入 public envelope。本分支必须决定：

1. completed sibling 的结果是否可以公开；
2. terminated lane 已产生、但尚未完整完成的 hits 是否可以公开；
3. 一成一败时最终 envelope 如何呈现；
4. all dispatched lanes 都 terminated 时如何呈现；
5. 部分 envelope 是否有资格驱动 Memory Hint 或 Coforge Memory Offer；
6. Hint sources 是否必须来自本次 envelope 真正公开并允许消费的 cards；
7. Hint 如何携带 retrieval completeness 与 incomplete-lane provenance；
8. exact 完成但 discovery 失败时，能否仅凭 current evidence 生成 Memory Hint；
9. partial 与 complete retrieval 使用相同 sources 时，Hint dedup 是否应将其视为同一投递。

### 本分支明确不处理

- memory-discovery 内部 OpenViking/Coforge/corpus 的 12 席分配；
- exact/discovery 结果 quota；
- budget/deadline/cancellation 传播，已由 Q143–Q145 定案；
- target agent 如何 adopt/reject/defer；
- followthrough/outcome 如何进入 utility；
- evidence escalation 与 `read_full_log`；
- Hint 节流、cooldown 和 TTL 的默认数值；
- Hint 是否可以自动执行 skill；
- Memory Offer 文本的逐句语义 entailment verifier。

## 二、涉及的现有实现与文件

### 1. RetrievalEnvelope 与 LaneAudit

文件：

```text
skill-node-design-grill/docs/adr/0029-pending-memory-search-schema.md
skill-node-design-grill/docs/adr/0032-parent-budget-deadline-and-cancellation-tree.md
```

Q139-B 已定义：

```ts
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
  lane: "current_log_exact" | "memory_discovery";
  executionState: LaneExecutionState;
  resultState: LaneResultState;
  reasonCode: LaneReasonCode | null;
  returnedCount: number;
  truncated: boolean;
  featureVersions: Record<string, string>;
  nativeAuditRefs: string[];
};
```

现有 schema 可以表达：

```text
exact completed + discovery terminated
exact terminated + discovery completed
terminated + no public result
terminated + public hits
```

但当前 policy 尚未授权 `terminated+hits`。此外：

- `truncated` 只能表示还有更多已授权结果因 lane-local result limit 未返回；
- timeout、cancellation 或 budget cutoff 不能复用 `truncated`；
- 一成一败无需新增 envelope-level status，两个 mandatory LaneAudit 已能机器级表达；
- 当前没有 top-level retrieval completeness 字段；
- `memoryCandidateCards` 有 `warnings[]`，但没有强制 incomplete-lane warning；
- `CurrentEvidenceRef` 没有 warnings 字段；
- 没有 policy 规定 terminated lane 的中间结果何时达到可安全公开的 checkpoint。

### 2. OpenViking Memory Hint

文件：

```text
OpenViking/openviking/session/memory_hints.py
```

当前 `HintSource`：

```python
HintSource {
    kind: fork | branch | guidance | skill
    ref: str
    revision: str
}
```

当前 `MemoryHint`：

```python
MemoryHint {
    hint_id
    task_id
    run_id
    target_agent_id
    sources
    match_reason
    anchor_state_summary
    applicability
    confidence_status
    provenance
    ttl_expires_at
    created_at
}
```

当前能力：

- sources 必须非空；
- Hint 只能 `memory@target_agent` 定向投递；
- Hint 不可执行，目标 agent 决定 adopt/reject/defer；
- delivery 执行 pending cap、cooldown、target preference 和 source-set dedup；
- 新 Hint 成功接纳时记录 hint exposure；
- disposition、followthrough、outcome 分开追加，不互相覆盖。

当前缺口：

- 没有 `retrievalEnvelopeRef`；
- 没有 retrieval operationId、planHash 或 auditRef；
- 没有 retrieval completeness；
- 没有 contributing/incomplete lanes；
- `provenance` 只是必填非空字符串，没有结构化校验；
- delivery 只验证 source kind/ref/revision，不证明 source 来自指定 RetrievalEnvelope；
- current source kinds 不包含 AO/current evidence，因此 exact-only 结果不能自然成为 Hint source；
- source-set dedup hash 不包含 complete/partial 状态；
- target 看不到“来源本身 provisional”和“本次 retrieval 不完整”的区别。

### 3. OpenViking Evaluation Loop

文件：

```text
OpenViking/openviking/session/evaluation_loop.py
```

当前 `MinimalEvaluationLoop.run()`：

1. 从 injected `selected_refs` 记录 MEMORY_RETRIEVE event；
2. 执行 task run 和 score；
3. 冻结 DiagnosisBrief；
4. 调用 diagnosis function；
5. commit provisional ForkRevisions；
6. 调用 `hint_composer(revisions)`；
7. 将 composer 结果交给 HintDeliveryService。

当前缺口：

- 没有 RetrievalEnvelope 输入；
- 没有 LaneAudit 或 retrieval completeness 分支；
- Hint composer 只接收 revisions；
- 不校验 Hint sources 是否属于 selected refs 或某次 retrieval 的公开结果；
- `_record_citations()` 对 committed revisions 记录 `considered`，与 composer 实际选择的 Hint sources 不完全绑定；
- 上游 collaborator 抛错时异常直接传播；
- 没有 one-completed/one-terminated 的处理路径；
- 没有 all-lanes-terminated 的审计 envelope 消费路径。

因此，后续实现若要支持 Q146，必须把冻结 RetrievalEnvelope 或其受控 ref 交给 Hint composer，并由服务端验证 source membership，而不能让 LLM 仅用自然语言声明 provenance。

### 4. Coforge Exploration 与 Offer

文件：

```text
coforge/apps/web/src/server/group-memory/memory-exploration.server.ts
coforge/apps/web/src/server/group-memory/memory-offer.server.ts
```

Exploration close 的现有 served-only 约束：

- `found=true` 必须同时提供非空 summary 和至少一个 citation；
- citation ID 必须语法合法；
- 每个 citation 必须是该 exploration session 实际 served 的对象；
- unserved citation 被拒绝；
- close request/response 受 operation ID + request hash 幂等保护。

但 `publishMemoryOffer()` 独立于 exploration：

- target 只允许 insight 或 active skill revision；
- 没有 exploration session ID 或 RetrievalEnvelope ref；
- 不验证 target 是否刚由 retrieval served；
- 没有 retrieval completeness、incomplete lanes 或 LaneAudit hash；
- body 只检查非空和长度，不验证每个主张是否由 targets 支持；
- operationKey 是 offer publication 幂等键，不是 retrieval identity；
- delivery row 记录投递事实，但没有显式 disposition/followthrough；
- shadow gate 只以后续 episode 做弱相关 ±1，不等价于目标 agent 的明确采纳和行为证据。

因此，Coforge 当前 offer grounding 比 exploration close 更弱。如果 Memory Offer 继续作为群聊中的 Memory Hint 投递形态，Q146 必须决定是否强制它引用并验证 RetrievalEnvelope。

## 三、所有选项共同约束

1. Request-level 认证、schema、scope/snapshot 和 plan-drift 错误仍走 transport error，不属于 partial lane failure。
2. `not_dispatched` 不算 failure；Q140-A 因 query clause 缺失而不调度的 lane 不降低 completeness。
3. `completed+empty` 表示完整执行后的零命中，不是 failure。
4. `truncated` 继续只表示 lane-local quota 截断，不表示 timeout、budget 或 cancellation。
5. Parent cancellation 发生后不能新发布 Hint；已经原子提交的 Hint/Offer 按自己的幂等记录保留。
6. 任何 Hint/Offer source 必须能回到公开、已授权、由指定 retrieval operation served 的对象；仅验证数据库中存在不够。
7. `memory_candidate` 可以成为 Hint/Offer 候选；`analogical_prior` 只能启发继续核验，不能直接驱动可行动 Hint；`excluded` 永不公开。
8. CurrentEvidenceRef 是当前事实证据，不自动成为 executable skill 或 Memory Hint source。
9. Retrieval completeness 与 source object 的 validated/provisional/confidence 状态正交，不能共用一个字段。
10. Partial/complete 状态必须进入 Hint provenance 和 dedup identity，不能只放在自然语言 warning。
11. Memory Agent/LLM 不能自报 retrieval completeness；状态必须从冻结的 mandatory LaneAudit 派生。
12. Hint composer 不能引用未由该 envelope public-admit 的 source card。
13. 完整性标签不得暴露 ACL-filtered、classifier-excluded 或不可见对象数量。
14. Q143–Q145 的 child budgets、deadline 和 cancellation 传播不因 Hint policy 而被重新分配。

## 四、派生的 Retrieval Completeness

所有选项均可使用以下派生状态：

```ts
type RetrievalCompleteness =
  | "complete"
  | "partial"
  | "unavailable";
```

派生规则：

```text
所有 dispatched lanes completed
  → complete

至少一条 dispatched lane completed
且至少一条 dispatched lane terminated
  → partial

所有 dispatched lanes terminated
  → unavailable
```

`not_dispatched` lane 不进入 completeness 分母。例如 semantic-only query 只 dispatch discovery；discovery completed 时 retrieval 是 complete，而不是因为 exact 没运行就 partial。

Completeness 是从 LaneAudit 计算的服务端事实，不是 Memory Agent 或 Hint composer 的输入判断。

## 五、Option A：Strict All-or-Nothing Public Results 与 Hint Gate（未选）

### 1. 机制

只要任一 dispatched lane 为 `terminated`：

- 所有 lanes 的 public result arrays 都置空；
- completed sibling 的结果也不公开；
- terminated lane 已产生的中间 hits 不公开；
- envelope 仍保存两条 mandatory LaneAudit 和 auditRef；
- retrieval completeness 为 `partial` 或 `unavailable`；
- 不生成 Memory Hint 或 Coforge Memory Offer。

只有满足以下全部条件才可生成 Hint：

```text
retrievalCompleteness = complete
memory_discovery.executionState = completed
memoryCandidateCards.length > 0
```

Exact-only query 即使完整完成也不生成 Memory Hint，因为没有 memory-discovery candidate。

### 2. 一成一败时的表示

例如 exact completed、discovery terminated：

```json
{
  "currentEvidenceRefs": [],
  "memoryCandidateCards": [],
  "analogicalPriorCards": [],
  "laneAudit": {
    "currentLogExact": {
      "executionState": "completed",
      "resultState": "hits",
      "reasonCode": null,
      "returnedCount": 0
    },
    "memoryDiscovery": {
      "executionState": "terminated",
      "resultState": "none",
      "reasonCode": "deadline_exceeded",
      "returnedCount": 0
    }
  }
}
```

注意：exact lane 内部可能已经找到结果，但 public arrays 被整体 gate 清空。为了维持 `returnedCount` 表示 public count，它必须是 0；native audit 才能记录内部完成结果。这意味着 completed+hits 与 returnedCount=0 的既有 Q139 不变量需要扩展为“结果被 envelope all-or-nothing gate 抑制”，或者增加 suppression 状态。因此 Option A 并非零 schema 成本。

另一种实现是仍把 exact 的 resultState 标为 hits 但 public count=0，这会直接违反现有不变量，不允许静默采用。

### 3. 优点

- 安全心智模型最简单：只有完整 retrieval 才可消费；
- Memory Hint 永远基于完整执行的所有 dispatched lanes；
- 不需要让 Hint 携带 retrieval completeness；
- 不会使用 terminated lane 的任何中间状态；
- 不会让用户把“没查完”误读为“查过且没有”；
- Hint composer 只处理 complete envelope，分支少；
- Coforge Offer 可以继续采用强 all-or-none publication 心智模型；
- 不需要定义 partial Hint 文本限制。

### 4. 权衡

- discovery 超时会丢掉已经完成的 current evidence；
- exact 超时会丢掉已经完成、可能有价值的 memory candidates；
- Q145-A 允许 sibling 继续的主要价值被抵消；
- 最弱 adapter 决定整个 retrieval 的可消费性；
- transient dependency failure 会让 Memory Agent完全沉默；
- completed sibling 已消耗 budget 和 deadline，却不能被使用；
- 高延迟/低可靠 discovery 会降低 exact evidence 的可用率；
- all-or-nothing gate 需要新增“结果被抑制”语义，否则与 Q139 returnedCount/resultState 不变量冲突；
- 目标 agent 无法获得“当前证据已找到，但历史检索失败”的有用信息；
- operational reliability 接近 Q145 已拒绝的 fail-fast，尽管控制面仍让 sibling 运行到完成。

### 5. 后果

选择 A 后：

- partial/unavailable envelope 只具审计价值，不具业务消费价值；
- 任一 terminated lane 禁止 Hint/Offer；
- 必须修改 LaneAudit 或增加 suppression metadata，解释 completed lane 的结果为什么没有公开；
- 系统可用性由所有 dispatched lanes 的联合成功率决定；
- 后续不再需要 terminated-hit safe checkpoint，但仍需实现 envelope-level suppression；
- Coforge direct offer 可以被禁止，要求只从 complete retrieval 生成。

## 六、Option B：Completed-Lane Results 可公开；Terminated-Lane Hits 隔离；受限 Partial Hint（已选）

### 1. Public Envelope 机制

- completed lane 的公开、已授权结果保留；
- terminated lane 的中间 hits 不进入 public arrays；
- terminated lane 固定 `resultState=none`、`returnedCount=0`，即使 native audit 记录它曾产生中间 candidates；
- completed sibling 按正常 `empty|hits` 和 public returnedCount 呈现；
- envelope 始终保留两条 mandatory LaneAudit；
- 一成一败时 completeness=`partial`；
- all dispatched lanes terminated 时结果数组为空、completeness=`unavailable`；
- 不新增顶层 aggregate status，consumer 从 mandatory LaneAudit 派生 completeness；
- client 已断开时不能再向该 client 返回，但首次 idempotency/audit record 仍可保存终止事实，后续 replay 语义由既有 operation record处理。

### 2. Memory Hint 资格

允许生成 Hint 必须同时满足：

1. `memory_discovery.executionState=completed`；
2. 至少存在一个公开 `memoryCandidateCard`；
3. 选中的 Hint sources 是该 envelope `memoryCandidateCards` 的子集；
4. 每个 source pointer 在生成时再次按 target principal、ACL 和 current status 校验；
5. parent retrieval 没有因 client/orchestrator cancellation 被整体取消；
6. `analogicalPriorCards` 不直接成为 Hint source；
7. exact-only completed results 不单独生成 Memory Hint，因为 current evidence lookup 不是长期记忆消费，且现有 HintSource 没有 AO/current-evidence kind。

行为矩阵：

```text
exact completed + discovery completed with candidates
  → 可生成 complete Hint

exact terminated + discovery completed with candidates
  → 可生成 partial Hint，必须声明 exact 不完整

exact completed + discovery terminated
  → 可公开 exact evidence，但不生成 Memory Hint

exact completed + discovery completed empty
  → 不生成 Memory Hint

all dispatched lanes terminated
  → 不生成 Memory Hint

semantic-only query：discovery completed with candidates
  → retrieval complete，可生成 complete Hint

exact-only query：exact completed with hits
  → retrieval complete，但没有 memory candidate，不生成 Memory Hint
```

### 3. Hint Retrieval Provenance

MemoryHint/Offer 增加不可变结构化来源：

```ts
type HintRetrievalProvenance = {
  retrievalEnvelopeRef: string;
  operationId: string;
  planHash: string;
  retrievalCompleteness: "complete" | "partial";
  contributingLanes: Array<"memory_discovery">;
  incompleteLanes: Array<
    "current_log_exact" | "memory_discovery"
  >;
  laneAuditHash: string;
  sourceCardRefs: string[];
};
```

字段语义：

- `retrievalEnvelopeRef`：指向冻结 RetrievalEnvelope 的稳定引用；
- `operationId`/`planHash`：绑定原 SearchPlan 和幂等身份；
- `retrievalCompleteness`：从 LaneAudit 派生，只允许 complete 或 partial，因为 unavailable 不可生成 Hint；
- `contributingLanes`：真正提供 Hint sources 的完成 lanes；对当前 Memory Hint 只能是 `memory_discovery`；
- `incompleteLanes`：本次已 dispatch 且 terminated 的 lanes；
- `laneAuditHash`：冻结两条 LaneAudit 的 canonical hash，防 composer 改写；
- `sourceCardRefs`：本 envelope 中被用于 Hint 的公开 memory-candidate refs。

校验规则：

- completeness 不能由 composer 自报；
- sourceCardRefs 必须是公开 `memoryCandidateCards` 的非空子集；
- sourceCardRef 不能指向 analogical prior、excluded 或 terminated-lane internal hit；
- incompleteLanes 必须与 frozen LaneAudit 一致；
- contributingLanes 中每条 lane 必须 completed；
- partial Hint 的 `match_reason`/body 不得声称 incomplete exact lane 已证实或排除某机制；
- source object 的 confidence_status/validated/provisional 与 retrievalCompleteness 分栏保留；
- provenance 必须由服务端构造和验证，LLM 只能选择 served source cards并起草文案。

### 4. Hint Dedup Identity

现有 OpenViking dedup 只 hash source triples，无法区分 partial 与 complete。新 dedup identity：

```text
hash(
  target agent,
  task lineage,
  canonical source triples,
  retrievalCompleteness,
  sorted incompleteLanes
)
```

不直接把每次 operationId 放入 dedup key，避免相同完整性和相同 sources 因重复 retrieval 不断新发 Hint。但：

- partial → complete 会形成不同 delivery identity；
- complete → partial 不应刷新或替代既有 complete Hint；
- 同 sources + 同 completeness + 同 incomplete lanes 可继续刷新 TTL，而不是重复投递。

### 5. Coforge Memory Offer 对齐

若 Memory Offer 是群聊投递形态，`publishMemoryOffer()` 必须新增并验证：

```ts
type MemoryOfferRetrievalGrounding = {
  retrievalEnvelopeRef: string;
  operationId: string;
  planHash: string;
  retrievalCompleteness: "complete" | "partial";
  incompleteLanes: LaneName[];
  laneAuditHash: string;
  sourceCardRefs: string[];
};
```

服务端要求：

- targets 是 sourceCardRefs 对应的公开 memory candidates；
- source cards 来自 completed memory-discovery lane；
- target insight/skill 当前仍有效；
- offer row 持久化 retrieval grounding；
- operationKey 继续只负责发布幂等，不替代 retrieval identity；
- 不再仅因 insight/skill 在数据库中存在就允许绕过 retrieval 直接发布。

Exploration close 的 served-only citation 校验可作为实现先例，但必须扩展到统一 RetrievalEnvelope 和 lane completeness。

### 6. 优点

- 保留 Q145-A sibling failure isolation 的实际价值；
- completed current evidence 不会因 discovery 失败而丢失；
- discovery 完成时仍可提供有用 Hint；
- terminated lane 不稳定的中间 hits 不会被误当最终结果；
- partial Hint 机器级携带完整性，不依赖自然语言提醒；
- Hint sources 必须 served-only，补上 OpenViking/Coforge 当前 grounding 缺口；
- exact 失败时禁止“当前日志已证实/排除”的过度断言；
- partial→complete 可形成新 Hint，不会被旧 source-only dedup 吞掉；
- 无需扩 Q138-A 的顶层 metadata，completeness 可从 LaneAudit 派生；
- completed lane 的 Q139 resultState/returnedCount 不变量无需改变。

### 7. 权衡

- MemoryHint 与 Coforge Offer schema 必须新增 retrieval provenance；
- Hint composer 必须读取冻结 envelope，而不能只接收 revisions；
- delivery service 需要验证 source-card membership；
- partial Hint 文案需要服务端 policy lint，不能只靠模型自律；
- exact 完成/discovery 失败时虽然有事实，但不发 Memory Hint，需要普通 evidence consumer 使用；
- partial→complete 可能产生第二条 Hint，需要与 throttle/cooldown 协调；
- Coforge 现有 direct-offer 调用方必须迁移；
- all-lanes-terminated 使用 audit-bearing envelope 的 transport mapping仍需实现细化；
- 必须持久化或可解析 RetrievalEnvelope，不能只返回临时 JSON。

### 8. 后果

选择 B 后：

- partial retrieval 是正式、可消费但受限的状态；
- completed sibling 结果正常公开；
- terminated lane partial hits 永不公开；
- 只有 completed memory-discovery 的公开 memory candidates 可以驱动 Hint/Offer；
- Hint/Offer 必须携带服务端验证的 retrieval provenance；
- existing direct offer 和 hint-composer seams 必须收口到 served-envelope grounding；
- disposition/followthrough/outcome 继续发生在 Hint 发布之后，不因 partial 状态被自动推断。

## 七、Option C：允许 Terminated-Lane Partial Hits 与 Hint Sources（未选）

### 1. 机制

- completed sibling 的结果公开；
- terminated lane 已产生且通过当时 ACL/classifier 的 hits 也公开；
- LaneAudit 使用 `executionState=terminated`、`resultState=hits`、非零 returnedCount；
- Hint 可以引用 completed lane 或 terminated lane 的公开 partial hits；
- 每张 partial source 携带 `incomplete_lane` warning；
- Hint retrieval provenance 记录 termination reason 和 partial source refs；
- adapter 必须定义 safe publication checkpoint，说明哪些中间 hits 已经完成足够处理。

### 2. 优点

- 最大化已经完成工作的利用；
- 长查询 deadline 前产生的高排名候选不会全部丢失；
- 依赖不稳定时 Memory Agent仍可能获得更多信息；
- 直接使用 Q139-B `terminated+hits` 的表达能力；
- 某些流式检索 adapter 可逐条发布已验证结果。

### 3. 权衡

- termination 时 adapter 可能尚未完成全部 ACL、dedup、rank、classifier 或稳定排序；
- 前几个中间结果不一定是最终 TopK；
- 不同终止时刻会返回不同 partial hits，replay 稳定性差；
- Memory Agent 或目标 agent 容易忽略 warning；
- partial exact scan不能支持“不存在”判断；
- partial discovery cards 可能未经过所有 adapters 和 use-class policy；
- Hint provenance 与 source confidence 语义显著复杂；
- 每个 adapter都必须定义并测试自己的 safe checkpoint；
- 可能鼓励 adapter 在终止前抢先输出未稳定候选；
- partial hits的 returnedCount/truncated 解释变复杂；
- 跨 adapter流式结果仍不能共享 global score。

### 4. 后果

选择 C 后：

- terminated+hits 成为正式 public 状态；
- 每个 adapter interface 必须支持 safe partial publication；
- Hint/Offer 可以引用不完整执行的来源；
- policy、测试和审计复杂度显著提高；
- 必须定义 partial hit 的 replay、ordering、classifier checkpoint 和撤回机制。

## 八、HintRetrievalProvenanceV1 Schema（已选）

该 schema 是 `memory-partial-hint/Q146-B` 的规范组成；Option C 若未来被重新考虑，必须另建 revision 扩展 terminated-hit provenance。

```ts
type RetrievalCompleteness =
  | "complete"
  | "partial";

type HintContributingLane =
  | "memory_discovery";

type HintIncompleteLane =
  | "current_log_exact"
  | "memory_discovery";

type HintRetrievalProvenanceV1 = {
  schemaVersion: "memory-hint-retrieval-provenance.v1";

  /** 冻结 RetrievalEnvelope 的稳定引用。 */
  retrievalEnvelopeRef: string;

  /** 原 retrieval 的逻辑操作与 canonical plan identity。 */
  operationId: string;
  planHash: string;

  /** 从 frozen LaneAudit 派生，composer 不可自报。 */
  retrievalCompleteness: RetrievalCompleteness;

  /** 真正贡献 Hint source 的 completed lanes。 */
  contributingLanes: HintContributingLane[];

  /** 已 dispatch 且 terminated 的 lanes。 */
  incompleteLanes: HintIncompleteLane[];

  /** 两条 canonical LaneAudit 的内容哈希。 */
  laneAuditHash: string;

  /** 必须是 envelope public memoryCandidateCards 的非空子集。 */
  sourceCardRefs: string[];
};
```

服务端验证伪代码：

```ts
function validateHintRetrievalProvenance(
  envelope: RetrievalEnvelopeV1,
  provenance: HintRetrievalProvenanceV1,
): ValidatedHintRetrievalProvenance {
  assert(provenance.retrievalEnvelopeRef === envelope.ref);
  assert(provenance.operationId === envelope.operationId);
  assert(provenance.planHash === envelope.planHash);
  assert(provenance.laneAuditHash === hash(envelope.laneAudit));

  const derivedCompleteness = deriveCompleteness(envelope.laneAudit);
  assert(provenance.retrievalCompleteness === derivedCompleteness);
  assert(derivedCompleteness !== "unavailable");

  assert(
    envelope.laneAudit.memoryDiscovery.executionState === "completed"
  );

  const allowed = new Set(
    envelope.memoryCandidateCards.map(card => card.payloadRef)
  );
  assert(provenance.sourceCardRefs.length > 0);
  assert(provenance.sourceCardRefs.every(ref => allowed.has(ref)));

  assertSameSet(
    provenance.incompleteLanes,
    terminatedDispatchedLanes(envelope.laneAudit),
  );

  assertSameSet(provenance.contributingLanes, ["memory_discovery"]);
  return freeze(provenance);
}
```

MemoryHintV2 候选扩展：

```ts
type MemoryHintV2 = MemoryHintV1 & {
  retrievalProvenance: HintRetrievalProvenanceV1;
};
```

Coforge Offer 候选扩展：

```ts
type MemoryOfferInputV2 = {
  // 既有 workspace/agent/conversation/target/body/operation fields
  targets: MemoryOfferTarget[];
  retrievalProvenance: HintRetrievalProvenanceV1;
};
```

不变量：

- `unavailable` retrieval 不存在 Hint provenance，因为不能生成 Hint；
- current evidence refs 不进入 sourceCardRefs；
- analogical prior refs 不进入 sourceCardRefs；
- source-card membership 按 payloadRef/source pointer 的稳定 identity 校验；
- incompleteLanes 与 LaneAudit 严格一致；
- partial Hint 不能把 incomplete exact lane 叙述成已核验；
- provenance 内容进入 delivery audit 和新的 dedup identity；
- adapter ACL labels、excluded count、精确 timing/budget 不内联。

## 九、具体例子

### 场景 1：Exact 完成，Discovery 超时

```json
{
  "currentEvidenceRefs": [
    {
      "aoId": "ao-184",
      "matchFragment": "ECONNREFUSED"
    }
  ],
  "memoryCandidateCards": [],
  "analogicalPriorCards": [],
  "laneAudit": {
    "currentLogExact": {
      "executionState": "completed",
      "resultState": "hits",
      "reasonCode": null,
      "returnedCount": 1
    },
    "memoryDiscovery": {
      "executionState": "terminated",
      "resultState": "none",
      "reasonCode": "deadline_exceeded",
      "returnedCount": 0
    }
  }
}
```

- **Option A**：隐藏 exact 已完成证据，不生成 Hint。
- **Option B**：公开 exact evidence；不生成 Memory Hint，因为 discovery 没有 completed memory candidate。
- **Option C**：如果 discovery 超时前产生两张中间 cards，也可以公开并用于 Hint。

### 场景 2：Exact 超时，Discovery 完成并找到 Active Skill

```json
{
  "memoryCandidateCards": [
    {
      "kind": "skill_revision",
      "payloadRef": "skill:skill-rev-17",
      "statusLabel": "active"
    }
  ],
  "laneAudit": {
    "currentLogExact": {
      "executionState": "terminated",
      "resultState": "none",
      "reasonCode": "budget_exhausted",
      "returnedCount": 0
    },
    "memoryDiscovery": {
      "executionState": "completed",
      "resultState": "hits",
      "reasonCode": null,
      "returnedCount": 1
    }
  }
}
```

- **Option A**：隐藏 skill card，不生成 Hint。
- **Option B**：公开 skill card，可生成 partial Hint；Hint 必须声明 exact lane 不完整，不能声称当前日志已验证该 skill。
- **Option C**：还可以引用 exact 超时前的中间 AO hits，即使全 scope 扫描未完成。

Option B 的 retrieval provenance：

```json
{
  "schemaVersion": "memory-hint-retrieval-provenance.v1",
  "retrievalEnvelopeRef": "retrieval:op-deploy-003",
  "operationId": "op-deploy-003",
  "planHash": "sha256:60a2f5...",
  "retrievalCompleteness": "partial",
  "contributingLanes": ["memory_discovery"],
  "incompleteLanes": ["current_log_exact"],
  "laneAuditHash": "sha256:lane-audits...",
  "sourceCardRefs": ["skill:skill-rev-17"]
}
```

### 场景 3：两条 Lane 都终止

- **Option A**：空 envelope，仅具审计价值，无 Hint。
- **Option B**：mandatory audits 保留，所有结果数组为空，derived completeness=`unavailable`，无 Hint。
- **Option C**：可能公开两条 lane 的中间 hits，但很难证明排序和分类已完成。

### 场景 4：Discovery 未调度，Exact 完成

Exact-only query 下，discovery=`not_dispatched` 不算 failure。Retrieval completeness 是 complete，但仍不生成 Memory Hint，因为没有 memory candidate。Current evidence 由普通 retrieval consumer 使用。

### 场景 5：第一次 Partial，第二次 Complete

第一次 exact 终止、discovery 完成，发送 partial Hint。第二次新 operation 中两条 lane 都完成且 sources相同：

- source-only dedup 会错误吞掉更完整的更新；
- Option B 的 dedup identity包含 completeness/incomplete lanes；
- complete Hint 可作为新的、限制更少的投递进入节流策略；
- 它不能原地覆写旧 partial Hint，旧投递继续留在审计历史。

## 十、术语解释

- **Partial failure**：同一 retrieval 中至少一条 dispatched lane 完成，至少一条 terminated。
- **Retrieval completeness**：从 dispatched lanes 最终 audit 派生的 complete/partial/unavailable 状态。
- **Completed sibling**：另一条 lane终止时仍正常完成的 lane。
- **Terminated hit**：lane终止前产生、但未经过完整执行终点的中间结果。
- **Public admission**：结果通过 ACL、分类和 policy 后被放入 RetrievalEnvelope。
- **Audit-bearing envelope**：即使没有可消费结果，也保留 mandatory LaneAudit 和 auditRef 的响应记录。
- **Memory candidate**：中央 use-class policy允许作为 Hint/Offer 候选的 memory card。
- **Analogical prior**：只能启发继续核验、不能直接驱动行动 Hint 的历史线索。
- **Served-only grounding**：Hint/Offer source 必须是指定 retrieval实际公开过的对象，而不是任意存在于数据库的对象。
- **Retrieval provenance**：Hint 所依据的 envelope identity、plan hash、lane completeness 和 source refs。
- **Completeness provenance**：说明哪些 lanes 完成、哪些不完整的机器级来源信息。
- **Source confidence**：memory object 自身 validated/provisional 等可信状态，与 retrieval 是否完整不同。
- **Entailment**：Hint 文本中的主张是否真的由 sources 支持。
- **Safe publication checkpoint**：adapter 中间结果已经完成 ACL、排序和分类、可以安全公开的阶段。
- **Dedup identity**：决定两次 Hint 是否被视为同一投递的稳定字段集合。
- **Suppression**：服务端有结果但因 policy 不允许而不放入 public response。

## 十一、决策

选择：

```text
memory-partial-hint/Q146-B
```

规范结果：

- completed lane results 可以公开；
- terminated lane partial hits 隔离且不公开；
- 一成一败由 mandatory LaneAudit 表达，不新增顶层 aggregate status；
- all dispatched lanes terminated 时只保留 audit-bearing unavailable envelope，不生成 Hint；
- 只有 completed memory-discovery 的公开 memory candidates 能驱动 Hint；
- exact-only evidence 不能单独成为 Memory Hint source；
- partial Hint 必须携带 retrievalEnvelopeRef、planHash、completeness、incomplete lanes、laneAuditHash 和 served sourceCardRefs；
- Hint/Offer source membership 与 completeness 由服务端验证，不能由 composer 自报。

选择理由：

1. 保留 Q145-A sibling failure isolation 的实际价值；
2. 不丢弃 completed sibling 的可靠结果；
3. 不公开 terminated adapter 的不稳定中间状态；
4. Memory Hint 只从完成的 memory-discovery lane 产生，保持记忆消费语义；
5. partial 状态机器可见并进入 provenance/dedup，不依赖自然语言 warning；
6. 补上 OpenViking Hint 与 Coforge Offer 当前缺少 served-envelope grounding 的生产缺口；
7. 不修改 Q138-A 的最小 envelope metadata，completeness 从 LaneAudit 派生。

## 十二、已定后果与下一分支

`memory-partial-hint/Q146-B` 已 accepted。Option A/C 完整分析保留为未选历史，不是现行架构。HintRetrievalProvenanceV1 是服务端构造和验证的规范 schema；production MemoryHint、EvaluationLoop 与 MemoryOffer 后续实现必须收口到 frozen-envelope served-only grounding。

本 ADR 文件名中的 `pending` 仅为稳定路径遗留。下一分支只处理 memory-discovery 内部 Coforge/OpenViking corpus 接入和 AO exact-search adapter；Hint disposition/followthrough/utility 与 evidence escalation 不在本 ADR 扩展。
