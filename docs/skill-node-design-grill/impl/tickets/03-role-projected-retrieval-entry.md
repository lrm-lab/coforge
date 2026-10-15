# 03 — 按角色投影的统一检索入口

**What to build:** 稳定群 Memory Agent 只能提交发现计划并拿到历史经验卡片；授权的非 Memory 角色则通过同一套服务端入口提交带 scope、snapshot 与 budget 租约的检索计划，并拿到可审计的发现结果信封。服务端绑定身份与权限，调用方不能自报 principal、deadline 或租约。同一操作的相同计划可以幂等重放，计划漂移会被拒绝。伪造给 Memory 的 exact 载荷在任何调度之前被拒绝。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

权威决定：`memory-search-entry/Q134-B`、`memory-search-schema/Q135-A`、`memory-search-schema/Q136-B`、`memory-search-schema/Q137-B`、`memory-envelope/Q138-A`、`memory-envelope/Q139-B`、`memory-agent-exact-removal/Q159-A`。Q159 取代 Q134 里 Memory 的双 lane 公开形状，也取代 Q158 的暂停合同。

本票交付发现侧入口与信封身份。非 Memory 的 exact 调度、命中与 CurrentEvidenceRef 属于票 06；typed corpus 选择与 12 席分配属于票 07 与票 08。本票不要实现这些后续合同，也不要给 Memory 留 exact 的零值、not_dispatched 或暂停状态。

共享检索门面会与票 06、08、09、10 交汇。本票在隔离 worktree/分支中开发；共享文件的冲突留到票 14 集成，不在本票里提前合并其他票的未完成合同。

- [ ] Memory 的公开请求是 `MemoryDiscoveryPlan(intentText?, dependencyPattern?)`；至少一项语义输入非空，且只调度 `memory_discovery`
- [ ] Memory 的公开响应只有 `memoryCandidateCards[]`、`analogicalPriorCards[]` 与 discovery audit；没有 current evidence、exact lane audit、exact quota、exact lease、exact deadline、exact cancel、exact truncation 或 exact completeness
- [ ] 含 exact 字段的伪造、legacy 或 replay 载荷在 dispatch、lease 与 audit construction 之前以 `exact_capability_absent_for_memory_agent` 拒绝；不静默剥离，也不先执行 discovery 再声称 exact 不可用
- [ ] 非 Memory 授权角色使用服务端签发的 `scopeRef` / `snapshotRef` / `budgetLeaseRef` 与 `operationId`；principal、role、deadline、cancellation 与 adapter handle 由服务端绑定
- [ ] 服务端规范化计划并计算 `planHash`：同 operationId + 同 hash 幂等重放；同 operationId + 不同 hash 以 drift conflict 拒绝；refs 在绑定 principal 下逐次解析
- [ ] 语义字段只进入 memory-discovery；unknown query fields 被拒绝；adapter 不得把卡片自我升级为 current evidence
- [ ] 公开信封只含约定的最小 metadata（schema version、operationId、planHash、duplicate、canonical resolved context、use-class policy version、auditRef）；不公开时间戳、精确预算余额、ACL 标签、excluded 计数、adapter 拓扑或 stack trace
- [ ] discovery 的 LaneAudit 能区分 not_dispatched、completed 与 terminated，且计数只含已授权的公开结果
- [ ] 自动化测试覆盖 Memory 拒绝矩阵、幂等重放、plan drift，以及非 Memory 语义检索的信封形状
