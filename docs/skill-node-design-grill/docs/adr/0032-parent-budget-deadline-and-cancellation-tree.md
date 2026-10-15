# Retrieval 父预算、Deadline 与 Cancellation Tree

**Decision keys:** `memory-control-budget/Q143-A`、`memory-deadline/Q144-B`、`memory-cancellation/Q145-A`
**Status:** `accepted`
**Depends on:** `memory-search-schema/Q135-A`、`memory-envelope/Q139-B`、`memory-exact-trigger/Q140-A`、`memory-lane-quota/Q142-A`

## 背景

一次 `retrieve(SearchPlan)` 可并行 dispatch `current_log_exact` 与 `memory_discovery`。两条 lane 共享父 `budgetLeaseRef` 和一次调用生命周期，却消耗不同资源：exact 主要使用 AO 扫描、ACL evidence reads 和 matcher CPU；discovery 使用 SQL/vector/graph/rerank，未来还可能调用模型或远程依赖。现有 OpenViking retrieval/ledger APIs 是同步调用且没有 deadline/cancellation；Coforge exploration 只有 session step/result budget 与 TTL，HTTP route 未向下传 `request.signal`；EvaluationOrchestrator 的 `sub_budgets` 是持久 manifest 字段，不是可原子核销的 retrieval child lease。

本 ADR 决定父 budget 如何分解、parent/child deadlines 如何组合，以及 parent cancellation 与 child-local termination 如何传播。它不决定 terminated lane 的 partial hits 是否公开、部分 envelope 是否可生成 Memory Hint、all-lanes-terminated 的外层结果或 evidence escalation。

## 决策一：Q143-A — Dispatch 前签发独立 Child Leases，禁止运行时借用

父 `budgetLeaseRef` 在可信服务端上下文中解析为：

```ts
type ResolvedRetrievalBudget = {
  parentLeaseRef: string;
  policyVersion: string;
  childLeases: {
    currentLogExact?: string;
    memoryDiscovery?: string;
  };
};
```

规则：

- 只为 Q140-A 已 dispatch 的 lane 签发 child lease；
- child lease 可包含 lane-specific、多维 resource meters，但细节不进入 Memory Agent public envelope；
- exact 只能核销 exact child lease，discovery 只能核销 discovery child lease；
- unused child budget 不转给 sibling，也不影响 Q142-A 的 result quotas；
- child leases 在 dispatch 前冻结并写入受控 audit；
- budget exhaustion 只终止对应 lane，映射 Q139 reason=`budget_exhausted`；
- child lease 的具体数值由版本化 budget policy 决定，不成为 SearchPlan agent-authored 字段。

Q143-A 只决定“已有 parent lease 如何分解”，不自动推翻 ADR-0013 的 autonomous-listening scope。非评测自主监听若仍无 workspace 共享父级硬帽，其 `budgetLeaseRef` 可解析为 autonomous retrieval policy lease，并派生 profile-scoped child controls；是否新增 workspace 总 ceiling 仍需独立决策。

### Q143 Considered Options

#### Option A — 独立 Child Leases、无运行时借用（已选）

优点：异构资源无需伪造统一单位；lane 互不饿死；预算耗尽归因清楚；resolved plan/policy 可重放；与 Q142-A no-backfill 心智模型一致。

代价：一条 lane 提前完成时，其 unused budget 不能帮助 sibling；policy 需预估成本；需要 child lease 签发、核销和关闭模块。

#### Option B — Child Reservations + Shared Overflow（未选）

机制：每条 lane 有保底 reservation，用完后竞争共享 overflow pool。

未选原因：需要跨 lane 原子 allocator；结果可能依赖并发时序；必须审计 reservation/grant/transfer；资源维度未必可交换；容易与已拒绝的 result-slot backfill 混淆。

#### Option C — 单一共享 Atomic Parent Pool（未选）

机制：两条 lane first-come-first-served 直接核销同一 pool，无最低 reservation。

未选原因：race-dependent starvation；相同 plan 的 lane outcome 可能随调度顺序变化；单一标量无法诚实表示异构资源；公平性最终会重新发明 reservation。

## 决策二：Q144-B — Parent Absolute Deadline + Dispatch 时冻结 Child Deadlines

```ts
type ResolvedDeadlineTree = {
  parentDeadline: MonotonicDeadline;
  policyVersion: string;
  childDeadlines: {
    currentLogExact?: MonotonicDeadline;
    memoryDiscovery?: MonotonicDeadline;
  };
};
```

规则：

- parent deadline 来自 orchestrator/request 的 server-bound context，不由 agent 写入 SearchPlan；
- child deadlines 在 dispatch 前按版本化 policy 冻结，且 `childDeadline <= parentDeadline`；
- effective deadline 为 `min(parentDeadline, childDeadline)`；
- adapter 的每次 IO、分页、循环和子调用只能使用当前 remaining duration，不能每 hop 重置 timeout；
- child deadline 到期只终止对应 lane，reason=`deadline_exceeded`；
- parent deadline 到期终止所有仍运行 child lanes；
- 使用 monotonic clock 计算 remaining duration；绝对值和 timing 仅写受控 audit，不进入 Q138-A public metadata。

### Q144 Considered Options

#### Option A — 只有 Parent Absolute Deadline（未选）

优点：模型简单、字段少、整体上限清晰。

未选原因：一个慢 lane 可占满父时间窗；exact/discovery 无延迟隔离；单 adapter 可能后台运行过久。

#### Option B — Parent + frozen Child Deadlines（已选）

优点：同时保证整体 wall-clock bound 和 lane isolation；可按不同延迟特征设置 child policy；适合并行；dispatch resolution 可审计和重放；防 multi-hop timeout reset。

代价：需要 deadline policy、monotonic clock 和 adapter cooperative checks；同步阻塞实现可能需要线程/进程隔离；child 值过短会导致假超时。

#### Option C — 每个 Adapter 使用可重置 Relative Timeout（未选）

机制：每个 SQL/HTTP/vector/rerank 子调用启动时获得完整 timeout。

未选原因：多 hop 累积可超过 parent deadline；retry 重置会无界延长；策略分散；client 断开后容易产生 orphan work。

## 决策三：Q145-A — Parent Fan-out，Child-local Termination 隔离

Cancellation tree：

```text
parent abort/deadline
  ├── cancel current_log_exact child
  └── cancel memory_discovery child

exact child deadline/budget/dependency termination
  └── terminate exact only; discovery continues

discovery child deadline/budget/dependency termination
  └── terminate discovery only; exact continues
```

Parent signal 合并 HTTP `request.signal`、orchestrator cancellation、parent deadline、server shutdown 与 capability/scope revocation。Child control signal 再叠加 child deadline、child budget exhaustion 与 lane dependency failure。

映射：

- parent/client abort → 已开始 lanes `terminated/cancelled`；
- parent deadline → 已开始 lanes `terminated/deadline_exceeded`；
- child deadline → 只终止该 lane，`deadline_exceeded`；
- child budget exhausted → 只终止该 lane，`budget_exhausted`；
- child dependency unavailable → 只终止该 lane，`dependency_unavailable`；
- sibling 继续到自身完成、终止或 parent cancellation。

多个终止信号竞态时采用 first-terminal-cause-wins 作为 public LaneAudit reason，随后到达的 secondary signals 仅进 native audit。Parent cancel 必须向 DB/HTTP/vector/model clients 传播，并在同步分页/循环之间 cooperative check；不能只停止等待而放任后台工作继续。

Terminated lane 的中间结果在 partial-return policy 定案前必须隔离，不得自行公开。Sibling 是否完成不触发 budget/result quota 转移。

### Q145 Considered Options

#### Option A — Parent fan-out + child failure isolation（已选）

优点：client/orchestrator cancel 真正停止全部工作；lane-local 故障不摧毁独立 sibling；符合 Q134/Q142 lane isolation；Q139 reasons 可直接映射；并行容错最好。

代价：需要 cancellation tree、合作停止和 first-cause 规则；sibling 继续会产生后续成本；一成一败的 public/Hint 语义留给下一决策。

#### Option B — Fail-fast，任何 Child Termination 升级为 Parent Cancellation（未选）

优点：全有或全无、失败后快速停止成本。

未选原因：discovery 故障会丢掉已完成 current evidence，exact 故障也会浪费有效 memory cards；最弱 adapter 决定整体可用性；与逐 lane audit 和独立信任通道冲突。

#### Option C — Detached Lanes，Parent Cancel 只停止响应（未选）

优点：不要求 adapter 支持 cancellation，可用于后台 cache warming。

未选原因：client 取消后仍消耗预算/凭据并可能访问已撤销 scope；产生 orphan work；parent lease 关闭后的核销不清；不适合交互式 role-scoped retrieval。

## 具体例子

若 parent remaining=8s，child policy 为 exact=3s、discovery=6s，则 exact effective deadline=3s、discovery=6s，整体仍不得超过8s。Exact 在3s到期只终止自身；discovery继续。若 HTTP client 在1s断开，parent signal fan-out，两个 child 都停止。

若 exact child lease 耗尽而 discovery 仍有预算：

```json
{
  "currentLogExact": {
    "executionState": "terminated",
    "reasonCode": "budget_exhausted"
  },
  "memoryDiscovery": {
    "executionState": "completed",
    "reasonCode": null
  }
}
```

是否公开 exact 终止前产生的 refs、以及 discovery 结果是否可驱动 Hint，由下一分支决定。

## 术语

- **Parent budget lease**：一次 retrieval 总资源使用权的服务端引用。
- **Child lease**：只允许特定 lane 核销的派生资源权。
- **Control budget**：限制执行成本的预算，不等于结果数量。
- **Parent/child deadline**：整个调用和单 lane 的最晚结束时间。
- **Effective deadline**：父、子 deadline 中更早者。
- **Monotonic clock**：不受系统时间校准倒退影响的计时源。
- **Cancellation propagation**：取消信号从父调用向 child 和底层依赖传播。
- **Failure isolation**：一个 child 终止不自动取消 sibling。
- **Orphan work**：已无有效调用方却继续消耗资源的后台工作。
- **First-terminal-cause wins**：竞态中的首个终止原因作为 public reason。

## Consequences

- 统一 retrieval module 必须成为 budget/deadline/cancellation control tree 的唯一所有者。
- Lane adapters 的内部 seam 必须接收 child control context；route 只绑定可信 request/parent signal。
- Q143 child budgets 与 Q142 result quotas 永远分型，不共享“backfill”语义。
- Parent/child control resolution、核销和 secondary termination signals 写入受控 auditRef/nativeAuditRefs，不进入最小 public metadata。
- 下一分支决定 partial failure 与 Memory Hint 生成；本 ADR 不预判 terminated hits、部分 envelope 的消费资格或 all-lanes-terminated 外层结果。
