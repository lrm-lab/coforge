# 02 — AIG 多角色构建链

**What to build:** 一次 AIG construction run 能从冻结的 L0/L1 证据和空图走完 Builder、Critic、Refiner、Reader 的交接，并在成功时得到冻结 revision，在失败时得到只支撑 provisional 的确定性 fallback。角色之间不共享会话，只通过不可变交接物通信；Reader 先核验证据并冻结报告，然后才能基于该报告提出 Fork，且不能改已经冻结的视图或报告。原始证据只按 summary-first 升级暴露。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

权威决定：ADR-0017、ADR-0023，以及 Round 9 的构建/会话/升级规则（CONSENSUS 叙述 61、67、68、72、80）。本票不实现统一检索门面，也不把 Reader 的证据裁决当成 skill promotion 批准。

- [ ] 默认 `construction_mode=adaptive_agentic_aig`：从同一冻结 L0/L1 快照和空图构建，不读取 IG；AIG 失败时不自动改跑 IG
- [ ] Builder、Critic、Refiner 各有互不共享的 run-scoped session；Critic 与 Refiner 在同一 run 内最多三轮修订中只复用本角色 session，不跨 run 复用
- [ ] Reader 与 Causal Diagnosis 共用一个活 session，并由服务端 phase gate 隔开：READ_VERIFY 只读冻结 Influence View 与选定证据、可调度只读 workers、输出内容寻址 ReaderReport，不能 propose Fork；报告冻结后 SYNTHESIZE_PROPOSE 只能基于该报告 propose ForkDraft/bridge，不能修改 view 或 report
- [ ] 稳定群 Memory Agent 保持自己的长期 session，不与上述角色共享；角色间只通过冻结 draft hash、ViolationSet、ReaderReport 等不可变交接物通信
- [ ] Draft 最多三轮 critic/refiner 后冻结；失败时的确定性 fallback 只支撑 provisional，不冒充完整 AIG
- [ ] 证据升级为 projection → summary → synopsis → selected raw evidence；未授权的 raw evidence 不会出现在角色上下文中
- [ ] Reader 的 evidence verdict 不能被当作 skill promotion approval
- [ ] 自动化测试覆盖会话隔离、三轮上限、phase gate、fallback 不升格、以及 raw evidence 升级边界
