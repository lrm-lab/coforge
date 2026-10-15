# AIG 构图角色按 run 隔离会话，仅 Reader 与 Diagnosis 阶段式共用

Q12-A 决定：每个 AIG construction run 中，Builder、Critic、Refiner 各自拥有互不共享的 run-scoped session。Critic 与 Refiner 可在同一 run 的最多三轮修订中各自复用本角色 session，但任何角色会话都不得跨 AIG run 复用。Reader 与 Causal Diagnosis 共用一个活 CausalDiagnosisAgent session，并由服务端强制 `READ_VERIFY → freeze ReaderReport → SYNTHESIZE_PROPOSE` phase gate。稳定群 Memory Agent 保有独立长期 identity/session，永不与上述构图或诊断角色共享会话。

角色之间只通过内容寻址的不可变交接物通信：Builder draft/hash、Critic `ViolationSet`、Refiner revision/hash、冻结 InfluenceViewRevision 与 ReaderReport。共用 role-scoped retrieval deep module 不等于共用会话、MemoryTaskState、自然语言上下文或 capability；每次调用仍以调用角色自己的 principal、scope、watermark、SearchPlan 与预算执行。

## Considered Options

- Builder/Critic/Refiner 分离，Reader/Diagnosis phase-gated 共用（**选定**）：隔离构图偏见和写权限，同时保留证据核验到归因提议的受控连续性。
- 所有角色共用一个长会话（否决）：Builder 假设会污染 Critic/Reader，Refiner 可见未授权上下文，phase gate 难以审计。
- 五个逻辑阶段完全独立会话（否决）：Reader 到 Diagnosis 需要重新搬运完整认知状态，增加摘要损失；冻结 ReaderReport 已能提供明确不可变边界。
- 与群 Memory Agent 共用会话（否决）：借用长期群成员身份会混淆 principal、ACL、预算和事实来源。

## Consequences

- 运行时必须为 role session 分配 run identity，并在 run 结束后终止或封存；恢复只能从不可变交接物重建，不能恢复共享聊天状态。
- 服务端必须拒绝跨角色或跨 run 的 session handle，并审计所有 phase transition。
- 本 ADR 补充 ADR-0016 的稳定群 Memory Agent 会话边界、ADR-0019 的共享检索模块边界，以及 CONSENSUS 的 Reader/Diagnosis phase gate；它不改变这些角色的工具权限和证据规则。
