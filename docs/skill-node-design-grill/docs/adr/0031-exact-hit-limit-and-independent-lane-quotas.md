# Exact hit 上限与 Memory 双 Lane 独立结果配额

**Decision keys:** `memory-exact-limit/Q141-B`、`memory-lane-quota/Q142-A`
**Status:** `accepted`
**Depends on:** `memory-search-entry/Q134-B`、`memory-search-schema/Q135-A`、`memory-envelope/Q139-B`、`memory-exact-trigger/Q140-A`

## 背景

Q140-A 已决定：合法 typed exact clause 存在即确定性 dispatch `current_log_exact`；semantic input 存在即 dispatch `memory_discovery`。本 ADR 决定每条已调度 lane 最多向一个 RetrievalEnvelope 返回多少 public results，以及一条 lane 未用完的结果名额能否被另一条 lane 借用。

现有值不可直接混称：AIG 论文 `T_log.search` 最多返回 20 个匹配；OpenViking `CAUSAL_MEMORY_CAP=12` 是 causal-memory 单次卡片总帽，默认内部 corpus 配额 6/4/2；AO reader `MAX_PAGE_LIMIT=200` 只是内部 snapshot 分页上限；Coforge 30 是 exploration session 生命周期累计结果上限、20 是单次 neighborhood step 上限。它们分别约束不同 interface。

## 决策一：Q141-B — Hard Ceiling 20，允许调用方请求下调

SearchPlanV1 增加：

```ts
type SearchPlanV1 = {
  // 既有字段
  resultLimits?: {
    currentLogExactMaxHits?: number; // integer 1..20
  };
};
```

规则：

- exact public hard ceiling 固定为 20；
- `currentLogExactMaxHits` 缺省时 canonicalize 为 20；
- 调用方只能请求 1..20，不能提高服务端 ceiling；
- exact clause 缺失却提供 exact limit 时 SearchPlan schema invalid；
- effective limit 纳入 canonical plan 与 `planHash`，幂等 replay 使用首次 canonicalized 值；
- `returnedCount <= effectiveLimit <= 20`；
- `truncated=true` 表示 ACL 后、已授权、去重的可返回 refs 超过 effective limit；
- public limit 只限制输出，不缩小授权范围或内部 scan 范围。

一个 public hit 是唯一 `(sourceSessionRef, aoId, matchedField)` 对应的 `CurrentEvidenceRef`。同一 AO 同一字段中的多个 occurrence 合并为一个 ref 的匹配片段/位置，防止单条长日志占满名额。处理顺序固定为：

```text
snapshot/scope filter
→ evidence ACL + withdrawal/revocation checks
→ evidence-ref coalescing
→ canonical order
→ effective public hit limit
```

不可见命中不消耗 public limit，也不公开 filtered count。Canonical order 由 scope resolver 的 session/range 顺序，再按 sequence、封闭字段顺序和首个 match offset 排列；exact lane 不产生 semantic relevance score。

### Q141 Considered Options

#### Option A — 固定 20，不允许下调（未选）

优点：完全对齐论文，SearchPlan 无新增字段，测试简单。

未选原因：简单任务也可能返回 20 条；调用方不能主动降低 token 成本；只能通过收窄 scope 或改写 expression 间接减量；未来允许下调将需要 schema 变更。

#### Option B — Hard ceiling 20，缺省 20，可请求 1..20（已选）

优点：保留论文 ceiling；允许调用方只缩小输出；limit 进入 plan hash、确定且可重放；不依赖实时预算 policy；public output、内部 scan 与授权范围继续分离。

代价：SearchPlan 多一个严格字段；调用方可能请求过低而漏掉后续命中；实现必须明确 limit 不是 scan limit。

#### Option C — 按父预算/查询规模动态决定 1..20（未选）

优点：可自动适应成本和任务规模。

未选原因：effective limit 成为隐藏 interface；同一查询可能随预算状态变化；必须冻结额外 policy resolution；结果数量可能形成预算/范围侧信道；并提前耦合下一分支的父级预算设计。

## 决策二：Q142-A — 两条 Lane 结果配额完全独立，不跨 Lane Backfill

初始结果上限：

```ts
type ResolvedLaneLimits = {
  currentLogExact: {
    maxHits: number; // Q141 effective limit，<=20
  };
  memoryDiscovery: {
    maxCards: 12;
  };
};
```

规则：

- exact refs 只消耗 exact limit；
- memory cards 只消耗 discovery cap 12；
- exact 空位不转给 discovery；
- discovery 空位不转给 exact；
- 两条 lane 都运行时，envelope hard maximum 是 `exactEffectiveLimit + 12`，绝对最大 32；
- 若调用方将 exact limit 下调为 5，最大为 17；
- 父预算可以使某 lane `terminated/budget_exhausted`，但不能把其未用结果名额转给另一 lane；
- `returnedCount` 和 `truncated` 始终 lane-local；
- downstream prompt assembly 可以另行选择注入子集，但不得反向改写 retrieval envelope。

Memory-discovery 内部如何把 12 张 card 分给 OpenViking Fork/Projection/Fact 与 Coforge Episode/Insight/Skill，不属于本 ADR；不得用跨 lane 独立配额决策偷渡该内部 allocation。

### Q142 Considered Options

#### Option A — 完全独立、禁止跨 Lane Backfill（已选）

优点：current evidence 永不被历史 card 挤掉；discovery 也不受 exact 密度影响；严格落实 Q134-B；LaneAudit 可独立解释；无需跨 lane score、allocator 或 borrowed-slot audit；一条 lane 的候选密度不会通过另一条 lane 的返回数泄露。

代价：两条 lane 都满时 envelope 最多 32 个对象；一条 lane 稀疏时另一条不能利用空位；payload 控制依赖 exact 下调、bounded snippets 和后续 prompt assembly。

#### Option B — 独立基础配额，但允许跨 Lane Backfill（未选）

机制：一条 lane 未用完时，另一条在总硬帽内借用空位。

未选原因：一条 lane 的返回数开始依赖另一条；`truncated` 不再纯 lane-local；借位数量可泄露另一 lane 候选密度；discovery 可超过现有 12；需要新增 allocator 和 borrowed/lent audit，重新引入跨 lane 配额耦合。

#### Option C — 单一 Global Result Cap（未选）

机制：例如总帽 20，由 allocator 在 exact 与 discovery 间动态分配。

未选原因：必须在当前事实与历史经验之间比较价值，而两者没有共同分数；两条 lane 会相互挤占；需要 allocation policy/version；实质推翻 Q134-B 的独立 TopK 语义。

## 具体例子

若当前有 47 个已授权 exact refs，SearchPlan 请求：

```json
{
  "resultLimits": {
    "currentLogExactMaxHits": 5
  }
}
```

则 exact lane 返回前 5 个，`returnedCount=5`、`truncated=true`。省略字段则 effective limit=20。若 exact 只找到 2 个、discovery 有 18 张候选：

```text
current_log_exact 返回 2，truncated=false
memory_discovery 返回 12，truncated=true
总计 14
exact 剩余 3 个请求名额不回填给 discovery
```

若 exact effective limit=20 且两 lane 均满：

```text
20 current evidence refs + 12 memory cards = 32 envelope items
```

两组结果仍位于不同数组，没有 global rank。

## 术语

- **Hard ceiling**：任何调用都不能超过的服务端绝对上限。
- **Effective limit**：本次请求 canonicalize 后实际采用的上限。
- **Public hit**：真正出现在 RetrievalEnvelope 中的已授权 CurrentEvidenceRef。
- **Match occurrence**：表达式在同一字段中的一次具体出现。
- **Coalescing**：把同一 AO/字段的多个 occurrence 合并成一个 evidence ref。
- **Scan limit**：adapter 内部最多扫描多少数据；不同于 public hit limit。
- **Lane-local quota**：只属于一条 lane 的结果名额。
- **Backfill**：一条 lane 未用完名额时，另一条借用空位。
- **Global result cap**：整个 envelope 所有数组共享的对象总帽。
- **Prompt assembly**：下游选择哪些 retrieval results 真正注入模型上下文。

## Consequences

- SearchPlan canonicalization 必须填入默认 exact limit=20，再计算 planHash。
- Exact adapter 必须在 ACL/withdrawal 之后去重和截断，并以稳定顺序返回。
- `currentLogExact.truncated` 与 `memoryDiscovery.truncated` 只解释本 lane。
- Envelope 无跨 lane global result cap；绝对结构上限为 32，但 Q141 下调可主动降低它。
- 跨 lane 父预算、deadline、取消和 lane termination 行为由下一分支决定；该控制预算不等同于结果 quota，也不得隐式执行 slot backfill。
