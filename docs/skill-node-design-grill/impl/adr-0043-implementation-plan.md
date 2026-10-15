# ADR-0043 实施计划：AIG 原生 ForkNode overlay 与 GuidedCounterfactualBranch

> **状态：计划，不授权实施。** 本计划落实 [ADR-0043](../docs/adr/0043-aig-native-fork-overlay-and-guided-remediation.md)，但 Q165-A 实现门禁仍关闭。除非明确重新打开门禁，所有任务只能被细化、审查或准备测试，不得改动产品代码。

## 目标与迁移原则

新模型让事实 AIG 保持为冻结的 AO-derived Block 和原生边；反事实作为 `ForkNode overlay` 挂在一份 base AIG revision 上。新写入不再创建 `InfluenceClaim` 或 `cut` grounding，Fork 只锚定 `anchor_block_id`。旧数据只读保留，不能被静默转换或继续参与新 Pattern/GuidedBranch 演化。

这是一次宽重构，采用 **expand → migrate → contract**：先引入版本化新模型和双读兼容，再逐项迁移写入、检索和运行时消费者，最后才停止旧模型的写入并把它锁为 legacy read-only。不得在中间阶段把 imagined node 写成事实 Block，或把模拟 replay 的 AIG 混进原生产 AIG。

## 并行任务图

编号表示依赖方向而非优先级。`无` 表示在门禁打开后可立即并行开始；同一波次任务不得写同一共享模块，除非通过预先约定的接口提交顺序协调。

| ID | 任务 | 阻塞于 | 可与其并行的任务 | 交付的端到端能力 |
|---|---|---|---|---|
| P00 | ADR-0043 版本化协议与兼容性夹具 | 无 | 无 | 在 OpenViking/Coforge 边界定义版本化 DTO、状态枚举、内容哈希输入及 golden fixtures；旧模型仍可读，任何新模型对象都可被安全拒绝或解析。 |
| P01 | AIG 原生边扩展路径 | P00 | P02、P03、P04 | AIG draft/revision/extraction 可表达 Block 与原生继承/影响边；新 AIG 写入不生成 Claim，旧含 Claim view 仍可只读打开。 |
| P02 | Reader 任务结果评估与 OutcomeContract | P00 | P01、P03、P04 | Reader 可在可信 AIG 上输出 `success/failure/uncertain` Assessment；服务端根据 OutcomeContract 和外部 evaluator/test 证据裁决 `confirmed_failure`，但暂不派发 remediation。 |
| P03 | Coforge 群聊诊断控制面 | P00 | P01、P02、P04 | 群聊可显式区分 `@memory retrieve` 与 `@memory diagnose`；前者只检索，后者通过协调器请求诊断。该 slice 只返回审计事件/模拟响应，不自动执行 agent。 |
| P04 | ForkNode overlay 持久化与 legacy 双读 | P00 | P01、P02、P03 | Reader proposal 经服务端验证后可写入以 `base_revision_id + anchor_block_id` 定位的 ForkNode overlay；旧 Fork/Claim/Cut 数据只读，禁止自动映射。 |
| P05 | BranchStepRef、StrategyPattern 与追加证据账本 | P04 | P01、P02、P03 | Fork branch 可引用同 base revision Block 或 branch-local imagined node；服务端创建严格身份的 Pattern，记录 direct/analogical/observational/model-only 证据与 retired/invalidated 生命周期。 |
| P06 | Fork precedent 检索与受控 Reader 输入 | P04、P05 | P07、P09 | Reader 在 ForkProposal 前获得 ACL 过滤的三层先例：高可信直接证据、低可信探索先例、retired/invalidated 反例；结果携带 adopted/rejected/not-applicable 理由要求。 |
| P07 | ReplayEligibility、Replay AIG 与对齐评估 | P04、P05 | P06、P09 | 服务端可判定 replayable/conditional/non-replayable；隔离 replay 形成独立 Replay AIG，并以 FirstActionAlignment/前缀对齐写入 replay-direct 证据。 |
| P08 | GuidanceDocument 审批与目标选择 | P02、P04、P06 | P07 | confirmed failure 时 Reader 可提出 GuidedCounterfactualBranch；服务端冻结 GuidanceDocument，并按 role/capability/ACL/成员资格选择 target agent。尚不启动真实 remediation run。 |
| P09 | Linked remediation run 与 GuidanceExecutionReport | P03、P08 | P07 | 目标 agent 的自动 dispatch 只在 ACL、permission、budget、安全、capability、幂等 gate 全通过时发生；真实后续 AO 写入 child remediation run，并产出每步对齐/偏离报告。 |
| P10 | Commit 后 Failure Gate 与自动诊断编排 | P02、P04、P08、P09 | 无 | session commit 复用同一 post-run AIG pipeline；只有 OutcomeEvidencePolicy 给出 confirmed failure 时才自动走 Reader → GuidedBranch → policy-gated dispatch。uncertain 的显式 diagnose 只产出诊断/建议。 |
| P11 | 新旧检索迁移与 Claim/Cut 写入收缩 | P01、P04、P05、P06、P10 | 无 | 新检索只消费 Block 边、ForkNode overlay、Pattern 与 Guidance 相关投影；停止新 Claim/Cut 写入，legacy 对象仅审计可读且不进入新演化。 |
| P12 | 跨仓端到端验证、故障注入与迁移验收 | P01–P11 | 无 | 覆盖成功、confirmed failure、uncertain、不可 replay、可 replay、对齐/偏离、ACL 拒绝、legacy 读取和自动 dispatch fail-closed 的可重复验收矩阵。 |

## 推荐波次

```text
Wave 0
  P00

Wave 1（四个无共享写热点的并行切片）
  P01  AIG native edge
  P02  Reader outcome
  P03  Coforge intent/control plane
  P04  ForkNode overlay storage

Wave 2（P04 之后分叉）
  P05  Branch/Pattern/evidence
  P06  Precedent retrieval                 [需要 P05]
  P07  Replay eligibility/alignment        [需要 P05]

Wave 3
  P08  GuidanceDocument/target selection   [P02 + P04 + P06]

Wave 4（两条可重叠的集成工作）
  P09  Remediation run/execution report    [P03 + P08]
  P10  Commit Failure Gate/orchestration   [P02 + P04 + P08 + P09]

Wave 5
  P11  Contract old Claim/Cut writes       [P01 + P04 + P05 + P06 + P10]

Wave 6
  P12  Cross-repository acceptance         [P01–P11]
```

P06 与 P07 可并行；P09 的 Coforge child-run 实现也可在 P08 的接口冻结后与 P07 并行。P10 与 P11 故意不并行：自动触发必须先运行在双读/扩展模型上，证明不会读取或写入不兼容的数据后，才能收缩 Claim/Cut 写入。

## 各任务的实现边界与验收

### P00 — ADR-0043 版本化协议与兼容性夹具

**范围：** 定义跨 OpenViking/Coforge 的 schema version、ForkProposal、ForkNode overlay、OutcomeAssessment、ReplayEligibility、GuidanceDocument、GuidanceExecutionReport、BranchEvaluation 和 FirstActionAlignment 的最小传输形状。为 legacy Claim/Cut fixture 和 v2 fixture 建立互不混淆的内容哈希与拒绝路径。

**验收：**
- 新旧 fixture 都能被对应 reader 确定性解析；未知版本 fail closed。
- v2 的 Fork grounding 只能引用 base revision 内 Block；Claim/Cut 字段不能进入 v2 写入 DTO。
- 两仓共享的 fixture/contract test 能在不启动 LLM 或群聊服务时运行。

### P01 — AIG 原生边扩展路径

**主要 OpenViking seam：** `influence_view.py`、`extraction_contract.py`、`extraction_write.py`、`influence_projection.py` 与相应测试。

**验收：**
- 新 extraction schema 输出 Block 与 native edge，不输出 Claim。
- edge 仍可表达继承/影响机制，但无独立 Claim status/projection/grounding 生命周期。
- 旧冻结 view 可读、可审计，不能由新 writer 更新。

### P02 — Reader 任务结果评估与 OutcomeContract

**主要 OpenViking seam：** `aig_role_chain.py`、OutcomeContract 存储/读取边界、session outcome/evaluator 适配与 role-chain tests。

**验收：**
- Builder/Critic/Refiner 不获得 outcome 判定写权限；Critic violation 不等于 failure。
- Reader Assessment 绑定 report hash、evidence refs 与 criteria；确定性 policy 处理 success/confirmed_failure/uncertain。
- 缺失或冲突 criteria 必定 `uncertain`，无法自动执行后续 remediation。

### P03 — Coforge 群聊诊断控制面

**主要 Coforge seam：** 群聊 mention/router、Memory agent 入口、协调器 command/event contract 和审计日志。

**验收：**
- `retrieve` 不创建 AIG/Fork/Guidance，也不 @ 其他 agent。
- `diagnose` 发出可幂等诊断请求；自由文本在有副作用前请求澄清。
- Memory 只接收 ACL-filtered cards/approved documents，不能直接构图、归因或持久化 Fork。

### P04 — ForkNode overlay 持久化与 legacy 双读

**主要 OpenViking seam：** `causal_experiences.py`、`subgraph_forks.py`、`diagnosis_wiring.py`、outbox/projection 与测试。

**验收：**
- ForkNode stable identity 和 revision identity 绑定 base AIG revision 与 anchor Block 的内容寻址上下文。
- 服务端重验 ACL、base revision、anchor membership、hash、branch shape 和幂等键。
- legacy edge/cut Fork 可只读显示其旧 grounding，但永不进入 v2 Pattern、GuidedBranch 或 v2 writer。

### P05 — BranchStepRef、StrategyPattern 与证据账本

**验收：**
- factual Block ref 限定同 base revision；imagined node 始终 counterfactual 且 branch-local。
- Pattern identity 只能由版本化受控字段派生；语义近邻不自动合并。
- BranchEvaluation 为追加记录；analogical 不提升为 direct；retired 默认退出先例候选但可审计。

### P06 — Fork precedent 检索与受控 Reader 输入

**主要 OpenViking seam：** `retrieval_facade.py`、`influence_projection.py`、memory discovery adapters 与 ACL/ranking tests。

**验收：**
- 一次 Reader proposal 前强制生成检索；结果分 high-confidence、exploratory、negative/retired tiers。
- ACL、temporal cutoff、self-reference 防护和 status 过滤在服务端完成。
- Reader 对高相关先例记录 adopted/rejected/not-applicable；检索结果不会被误当 current evidence。

### P07 — ReplayEligibility、Replay AIG 与对齐评估

**主要 seam：** OpenViking control-contract/evidence contract + Coforge sandbox replay worker 的边界。

**验收：**
- 资格判断可重评；non-replayable 明确进入 analogical 路径。
- replay AO 形成带 base-revision/replay-run provenance 的独立 AIG，不污染生产 AIG。
- 仅 equivalent/functionally_equivalent 首行动可进入 direct evidence；只匹配首节点时不得验证全分支 outcome。

### P08 — GuidanceDocument 审批与目标选择

**验收：**
- 只有 Reader 的 frozen report + confirmed failure 可提出自动执行性 guidance。
- 服务端基于 target role、capabilities、ACL、任务成员资格与可用性选择具体 agent，并冻结选择结果。
- Memory 只能渲染/发布批准文档，不可添加无证据行动或改写 target。

### P09 — Linked remediation run 与 GuidanceExecutionReport

**验收：**
- dispatch 前任一安全/权限/预算/幂等检查失败即 fail closed，并记录 blocked_pre_execution。
- remediation 在 child run 写入，不修改原 completed failure run；所有 AO 可回溯 source Fork/Guidance。
- execution report 映射 imagined node 与实际 Block；divergent/not_executed 不能被记作原策略反证。

### P10 — Commit 后 Failure Gate 与自动诊断编排

**主要 seam：** `session.py` post-extraction hook、trajectory index、outcome policy、Coforge coordinator API。

**验收：**
- commit 与 `@memory diagnose` 共用同一 AIG construction pipeline；已有新鲜冻结 view 时不重复建图。
- 只有 confirmed failure 触发自动 Reader diagnosis、Guidance 与 dispatch；success 只保留可检索 AIG；uncertain 不自动行动。
- 所有跨服务操作可重试且不会重复创建 Fork、Guidance 或 remediation run。

### P11 — 新旧检索迁移与 Claim/Cut 写入收缩

**验收：**
- 所有新写入路径拒绝 Claim/Cut；所有新 retrieval/ranking/prompt 不再把它们作为活动对象。
- legacy reader 保持 content hash 与审计可用，且迁移只能显式创建新的 overlay 并记录来源。
- 删除旧写入和活动消费者前，迁移 suite 证明没有 v2 call site 依赖旧对象。

### P12 — 跨仓端到端验证、故障注入与迁移验收

**验收矩阵：**
- success：不创建自动 remediation；
- confirmed failure：Reader → GuidedBranch → policy-gated automatic target handoff；
- uncertain + explicit diagnose：有诊断/建议，无自动 dispatch；
- non-replayable：只有 analogical evidence；
- replay：独立 Replay AIG、首行动/前缀对齐与 direct-evidence gate；
- real remediation：child run + execution report + production-direct 回流；
- ACL、权限、预算、target 不可用、重复投递：全部 fail closed 且幂等；
- legacy Claim/Cut：可审计、不可成为 v2 活动输入。

## 验证策略

每个任务必须新增或迁移其对应的 focused unit/contract tests；P07/P09/P10 还需提供无真实外部副作用的 deterministic integration fixture。P12 是唯一允许依赖全部模块的跨仓 smoke/E2E 阶段。产品门禁打开后，先完成 P00 的 contract fixtures，再并行运行 Wave 1；任何 Wave 在其直接验收测试不绿时不得解锁依赖任务。

## 需在实施门禁重开时确认的非代码前提

- Coforge 的群聊路由、agent dispatch 与 remediation-child-run 的最终 Rust package/module ownership；本计划不假定当前代码已存在这些 runtime。
- 生产自动 dispatch 的 allowlist、权限模型、预算上限、外部副作用隔离和紧急停用开关。
- OutcomeContract 的上游创建者（用户、Orchestrator 或任务系统）及 evaluator/test adapter 的权威来源。
- legacy 数据保留期限与显式迁移触发者；不得在部署脚本中隐式批量改写。
