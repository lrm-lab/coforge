# Exact lane 由 typed query clause presence 确定性触发

**Decision key:** `memory-exact-trigger/Q140-A`
**Status:** `accepted`
**Depends on:** `memory-search-entry/Q134-B`、`memory-search-schema/Q135-A`、`memory-search-schema/Q136-B`、`memory-envelope/Q139-B`

## 背景

Q134-B 已将群 Memory Agent 的公共检索入口收口为单一 `retrieve(SearchPlan)`，内部保留 `current_log_exact` 与 `memory_discovery` 两条类型化 lane。Q136-B 又将 query 分成共享 semantic input 与显式 typed exact clause：

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

本 ADR 决定这些 query clauses 如何映射为实际 lane dispatch。该映射必须可由 canonical SearchPlan 重算，不能因隐藏 classifier 或当前预算状态改变，从而保持 `operationId + planHash` 的 replay/drift 语义。

现有实现尚无 current-log exact adapter：`OpenViking/openviking/session/ao_ledger_reader.py` 只提供 snapshot、分页和单 AO evidence ACL；`OpenViking/openviking/session/retrieval_facade.py` 是 BM25/vector memory-discovery；Coforge `memory-exploration.server.ts` 目前只有单一非空语义 query。该决定只规定未来统一 module 是否 dispatch adapter，不假装 adapter 已实现。

## 决策：Option A — Query clause presence 确定性触发

```ts
const hasExact = plan.query.exact !== undefined;
const hasDiscovery =
  nonEmpty(plan.query.intentText) ||
  nonEmpty(plan.query.dependencyPattern?.wantedArtifact) ||
  nonEmpty(plan.query.dependencyPattern?.wantedEffect);

const dispatchExact = hasExact;
const dispatchDiscovery = hasDiscovery;
```

行为矩阵：

| Query 形状 | `current_log_exact` | `memory_discovery` |
|---|---:|---:|
| 只有 semantic input | 不调度 | 调度 |
| 只有 typed exact clause | 调度 | 不调度 |
| semantic + exact 都有 | 调度 | 调度 |
| 两者都没有 | 整体 SearchPlan schema invalid | 整体 SearchPlan schema invalid |

触发不新增 `requestedLanes` 字段，也不调用 server classifier。Query clause 同时表达该 lane 的合法输入和调用意图：exact expression 不注入 semantic retrieval，semantic intent/dependency pattern 不自动生成 literal/regex。

未调度 lane 的 Q139-B audit 固定为：

```json
{
  "executionState": "not_dispatched",
  "resultState": "none",
  "reasonCode": "not_selected",
  "returnedCount": 0
}
```

若 clause 存在，lane 已在 trigger 阶段被选中；后续预算不足、超时或依赖不可用必须表达为 `terminated` 及对应 reason，不能静默回写为 `not_dispatched`。

## Considered Options

### Option A — Query clause presence 确定性触发（已选）

优点：

- 相同 canonical plan 永远产生相同 dispatch set；
- 不增加与 query 重复的 lane selector；
- 显式 exact clause 不会被隐藏 policy 忽略；
- 不会从自然语言偷偷合成 regex，也不会把 exact expression 当 semantic query；
- 幂等 hash、审计和测试最简单；
- 调用方表达要查的内容即可，不需要了解 adapter 拓扑。

代价：

- Memory Agent 若遗漏 exact clause，就不会查当前日志；
- clause 存在时不能临时要求保留查询但跳过 lane；
- semantic 与 exact 都存在时，两条 lane 都会 dispatch，不能由服务端按成本静默跳过；
- query shape 与 dispatch 语义绑定。

### Option B — 显式 requestedLanes/run|skip directive（未选）

机制：SearchPlan 额外携带：

```ts
requestedLanes: {
  currentLogExact: "run" | "skip";
  memoryDiscovery: "run" | "skip";
}
```

`run` 必须有对应 query clause；至少一条 lane 为 run；directive 纳入 plan hash。

优点：调用方可以保留两类 query 但只运行一条，dispatch 意图一眼可见。

否决原因：query presence 与 directive 重复，会产生 run-without-query、skip-with-query 等矛盾组合；调用方必须理解内部 lane 名称；schema、hash、错误码和测试矩阵扩大；未来 lane 拓扑变化会扩散到公共 interface。

### Option C — 版本化 server trigger policy（未选）

机制：先按 clause presence 计算 eligible lanes，再由服务端 policy 根据 task class、budget 或其他允许特征选择 dispatch set；policy 只能从 eligible set 中选，不能生成缺失 query。

优点：可按成本和任务类型减少调用，不给 SearchPlan 增加显式 switches。

否决原因：明确 exact clause 可能被静默跳过；相同 plan 在 policy 升级后可能产生不同 dispatch，必须额外冻结 policy output；隐藏行为增加调试和审计难度；若使用模型 classifier，会引入成本、延迟和非确定性；还会把 trigger 与后续预算分配分支耦合。

### 非选项：两条 lane 永远执行并自动推导缺失 query

该方案违反 Q136-B：semantic intent 不得隐式生成 regex/literal，exact expression 也不得自动成为 memory-discovery query，因此不属于可选设计。

## 具体例子

Semantic-only：

```json
{
  "query": {
    "intentText": "支付服务部署后数据库连接失败"
  }
}
```

只 dispatch `memory_discovery`；exact lane 记录 `not_dispatched/none/not_selected`。

Exact-only：

```json
{
  "query": {
    "exact": {
      "expression": "ECONNREFUSED|timeout",
      "syntax": "regex",
      "fields": ["observation", "message"],
      "caseSensitive": false
    }
  }
}
```

只 dispatch `current_log_exact`，不会把正则文本作为 memory query。

两类都有：

```json
{
  "query": {
    "intentText": "支付部署后数据库连接失败",
    "dependencyPattern": {
      "wantedArtifact": "database diagnostics",
      "wantedEffect": "identify failure mechanism"
    },
    "exact": {
      "expression": "ECONNREFUSED|timeout",
      "syntax": "regex"
    }
  }
}
```

两条 lane 均 dispatch，且各自只消费自己的 query clause。

## 术语

- **Trigger condition**：决定 lane 是否进入执行阶段的条件。
- **Eligible lane**：SearchPlan 已提供该 lane 所需合法 query，因此具备调度资格。
- **Dispatch**：服务端真正调用 lane adapter 开始执行。
- **Clause presence**：typed query 片段存在且通过 schema validation。
- **Deterministic**：相同输入和版本必然产生相同 dispatch set。
- **Derived query**：从另一种 query 自动生成输入；Q136-B 禁止两个 lane 互相隐式派生。
- **not_dispatched**：lane 未进入执行阶段，不等于执行后零命中。
- **Hidden interface**：调用方虽看不到字段，却必须了解隐式规则才能预测行为。

## Consequences

- `SearchPlanV1` 不增加 `requestedLanes` 或 trigger policy ref。
- Canonical `planHash` 已足以固定 dispatch set；无需另存 classifier 输出。
- Exact/discovery clause presence 与 dispatch set 的映射必须由统一 module 单点实现并测试，不能复制到 adapters 或 route。
- Route 只解析 strict query schema；adapter 不自行决定是否被调用。
- 下一分支可独立决定 exact hit cap 和跨 lane 配额，因为 trigger 不读取或修改这些值。
- 本 ADR 不决定 exact 命中上限、memory-discovery cap、跨 lane backfill、partial-return policy 或 evidence-escalation authority。
