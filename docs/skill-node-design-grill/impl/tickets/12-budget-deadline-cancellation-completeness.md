# 12 — 预算、截止、取消与完整性树

**What to build:** 一次检索的父租约在调度前拆成各 lane 自己的子预算和子截止时间。一条 lane 用尽预算、到达自己的截止或遇到依赖失败时，只结束自己；父级取消、父截止或服务关闭会结束全部仍在运行的 lane。已经完成的兄弟 lane 结果保留，被终止 lane 的中间命中不公开。完整性只根据真正调度过的 lane 计算，供后续 Hint 判断这次检索是完整、部分还是不可用。

**Blocked by:**
- 03 — 按角色投影的统一检索入口
- 06 — 非 Memory 的 exact lane
- 08 — 分配与确定性交织
- 11 — 已服务锚点的派生子图展开

**Status:** ready-for-agent

权威决定：`memory-control-budget/Q143-A`、`memory-deadline/Q144-B`、`memory-cancellation/Q145-A`，以及 `memory-partial-hint/Q146-B` 中的完整性与 terminated-hit 隔离。谁可以据此生成 Hint/Offer 属于票 13。Q159 规定 Memory 没有 exact 子预算、子截止、子取消或 exact 完整性；本票不得给 Memory 补上这些字段。

本决定不新增、也不推翻 Memory 自主监听的工作区共享总上限。

- [ ] 父 `budgetLeaseRef` 只为已调度 lane 派生冻结的 child lease；exact 与 discovery 只核销自己的资源表；未用预算不转给兄弟 lane
- [ ] child 耗尽只终止本 lane 并记 `budget_exhausted`；不改变票 06 的结果配额
- [ ] deadline 来自服务端绑定的上下文；调度前按版本化策略冻结 child deadline，且 child 不晚于 parent；有效截止是二者较早者
- [ ] 分页、IO 与子调用复用单调剩余时间，不逐跳重置 timeout；精确时间只进受控 audit
- [ ] child deadline 只终止本 lane；parent deadline 终止全部运行中的 lane
- [ ] HTTP 请求、orchestrator、parent deadline、server shutdown 与 revocation 合成 parent signal 并 fan-out；child 的 deadline、budget 或 dependency 不连坐兄弟 lane
- [ ] 公开 reason 采用 first-terminal-cause-wins；次级信号留在 native audit；底层 adapter 合作式取消，不留下孤儿工作
- [ ] 完整性由已调度 LaneAudit 派生为 complete、partial 或 unavailable；not_dispatched 不进分母
- [ ] completed lane 的已授权公开结果保留；terminated lane 固定为无公开结果、returnedCount=0，中间命中只进 native audit
- [ ] Memory 响应仍然没有 exact 控制面字段；展开操作使用自己的 child snapshot/budget/deadline/cancel，且失败不改写父信封
- [ ] 自动化测试覆盖：兄弟 lane 互不借用、父取消扇出、child 失败隔离、terminated 中间命中不可见，以及 Memory 的 exact 控制面仍不存在
