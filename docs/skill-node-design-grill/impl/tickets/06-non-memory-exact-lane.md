# 06 — 非 Memory 的 exact lane

**What to build:** Reader、Critic、Refiner、Builder、Diagnosis 等授权角色可以在检索计划里放上一条 literal 或安全 regex，并取回有界的当前证据引用。命中先过快照、范围、ACL 和撤回，再按来源去重并截断。exact 与 discovery 的结果名额互不借用。Memory Agent 仍然没有任何 exact 表面。

**Blocked by:**
- 03 — 按角色投影的统一检索入口

**Status:** ready-for-agent

权威决定：`memory-exact-trigger/Q140-A`、`memory-exact-limit/Q141-B`、`memory-lane-quota/Q142-A`，以及 exact adapter 的 `memory-exact-content/Q149-A`、`memory-exact-snapshot/Q150-A`、`memory-exact-regex/Q151-A`、`memory-exact-ref/Q152-B`。Q159 规定这些 exact 分支对 Memory 为 N/A。

父预算分解、child deadline、取消树，以及 complete/partial/unavailable 与 Hint 溯源属于票 12。本票把 exact 结果合同做完，并留下可被票 12 接上的 lane 终止原因，但不实现那棵控制树，也不把 terminated lane 的中间命中公开出去。

共享检索门面会与票 03、08、09、10 交汇。本票在隔离 worktree/分支中开发；共享文件冲突留到票 14。

- [ ] 不新增 requestedLanes。合法 `query.exact` 存在即调度 `current_log_exact`；语义输入调度 `memory_discovery`；两者都有则都调度；都没有则计划非法
- [ ] exact 表达式不进入语义检索，语义输入也不派生 literal/regex；clause 已经存在后的资源或依赖失败记 terminated 及对应 reason，不得改写成 not_dispatched
- [ ] exact 搜索 authority-resolved SearchableStepView；outer resolver 冻结有序的、按能力绑定的 slices；regex 使用 RE2-compatible 线性时间方言，不使用宿主回溯正则
- [ ] `currentLogExactMaxHits` 只允许整数 1..20，缺省规范为 20，并进入 planHash；exact clause 缺失却携带该 limit 时计划非法
- [ ] 公开命中以 `(sourceSessionRef, aoId, matchedField)` 唯一；先做 snapshot/scope、evidence ACL/撤回、去重和规范序，再应用 limit；不可见命中不占名额，也不泄露 filtered/total
- [ ] `returnedCount <= effectiveLimit`；仅已授权 refs 超限时 `truncated=true`
- [ ] CurrentEvidenceRef 按 session/AO/field 合并为有界 spans，并带 totalOccurrences、spansTruncated 与所搜表示的 content hash
- [ ] discovery 每信封最多 12 张卡片；两 lane 不借位、不回填；父预算耗尽可以终止 lane，但不得转移未用结果名额
- [ ] Memory 路径仍在调度前拒绝 exact，响应中不出现 exact 数组或 exact LaneAudit
- [ ] 自动化测试覆盖 clause presence、1..20 上限、ACL 后截断、无 backfill，以及 Memory 的 N/A
