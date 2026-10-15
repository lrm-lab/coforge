# AIG 原生 ForkNode overlay、Reader 结果评估与引导式 remediation

**Status: accepted — design only; Q165-A implementation gate remains closed.**

新写模型将 Fork 收敛为冻结事实 AIG revision 上的 `ForkNode overlay`，以唯一 `anchor_block_id` 锚定事实 Block；它不改写 base AIG，也不把未来分支提升为 AO-derived Block。Reader 在 AIG report 冻结后独占提交 ForkProposal，服务端独占验证和持久化。此决策删除新模型中的 `InfluenceClaim` 和 `cut` grounding：AIG 只保留事实 Block 与原生继承/影响边；Fork 只锚定 Block。历史 Claim/Cut 数据与旧 Fork 不删除，但只读 legacy 审计，不自动伪造 Block grounding、不参与新的 Pattern、GuidedBranch 或检索演化。

## Branch、证据与 replay

一个 BranchStepRef 只能是同一 base frozen revision 的 `factual_block_ref`，或严格标为 counterfactual 的 branch-local `imagined_node`。imagined node 不可变，后续证据通过追加 BranchEvaluation 演化。服务端从 Reader 的结构化 StrategyPatternProposal 生成 CounterfactualStrategyPattern；只有 intervention type、target boundary、mechanism、expected metric、capability 与适用条件等核心字段严格一致的节点才累计经验，语义近邻只能检索、不能自动合并。

证据分 production-direct、replay-direct、analogical、observational 与 model-only。类似 Fork 可以向当前 imagined node 和 Pattern 添加 analogical 证据并调整 estimated confidence，但永不使其成为直接验证。Fork 创建时服务端产出可重评的 ReplayEligibility。replay 在独立受控 run 中形成 Replay AIG；任何 direct support/refutation 先通过 FirstActionAlignment：服务端检查 intervention type、target boundary、必要能力与安全/控制参数，Reader 可提出受审计的功能等价解释。只有 `equivalent`/`functionally_equivalent` 的首行动可产生 direct evidence；对 outcome 的更新还要求相应的前缀或整支对齐。反证以 challenged、invalidated、retired、superseded 的追加生命周期表达；retired 默认从先例检索退出，但不删除审计历史。

## 结果评估、群聊诊断与真实 remediation

Reader 在可信 AIG 上提交 TaskOutcomeAssessment，而不是由 Builder、Critic 或 Refiner 判断任务成败。Critic 只评估图的结构/语义有效性；Refiner 只修复图。服务端使用版本化 OutcomeEvidencePolicy 裁决 Reader assessment，并以任务启动时冻结的 OutcomeContract（用户/Orchestrator 目标、验收标准、evaluator/test 绑定及 policy/SLA 约束）为依据。明确 evaluator/test/acceptance 信号优先于纯 Reader 推断；冲突或仅 provisional criteria 时结果为 uncertain，禁止自动 remediation。

群聊中 `@memory retrieve` 只能检索；`@memory diagnose` 才允许诊断，模糊意图必须澄清。Memory 是 ACL-scoped 入口与 GuidanceDocument 发布者，不构图、不归因、不写 Fork。协调器在需要时复用 session-commit 的同一 AIG pipeline；Reader 基于冻结 AIG 与受控历史 Fork retrieval 提出 GuidedCounterfactualBranch 和 guidance plan，服务端冻结 GuidanceDocument。Memory 仅发布批准的文档，并由服务端按 target role、capability、ACL、成员资格与可用性选择具体 target agent。自动 dispatch 已被选择，但它仍必须通过 ACL、permission、budget、安全、capability 与幂等 gate；任何 gate 失败都 fail closed。

已完成失败任务的自动 remediation 运行在 linked child remediation run 中，保留 `parent_session_id`、`source_fork_id` 和 `source_guidance_id`，不向原失败轨迹追加未标记行动。目标 agent 可以在既有权限内调整 guidance，但必须提交 GuidanceExecutionReport，将 imagined node 与实际 AO-derived Block 标为 equivalent、functionally_equivalent、divergent 或 not_executed。只有对齐的真实行动可成为 production-direct 证据；偏离或执行失败只记录约束/适用性，不自动反驳原 imagined branch。

## Consequences

本 ADR supersedes ADR-0010 中新写模型对 Block/Claim projection、block|edge|cut grounding、Claim 邻域与 Claim-based dependency query 的部分，以及 ADR-0012 中以独立 ForkRevision、cut grounding 或 Diagnosis 生成者为前提的部分。原 ADR 和持久化数据保持历史审计意义；任何兼容迁移必须创建新的 ForkNode overlay，并显式记录 legacy 来源、原 grounding 快照与迁移理由。实现必须先通过 Q165-A 门禁；本 ADR 本身不授权任何产品代码变更。
