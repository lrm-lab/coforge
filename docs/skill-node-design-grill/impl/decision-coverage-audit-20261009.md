# Q162 决策→实现覆盖审计（2026-10-09）

## 结论

**Q165-A 的实施闸门必须保持关闭。** `Q164-A` 是本审计形成时使用的历史 gate 标识；自 ADR-0043 起，`Q165-A` 是唯一现行规范标识。产品设计没有新的开放决策：Round 29 已确认 Q1–Q160 收口；但“设计决定已落到当前实现”的证据不完整，不能把 14 张 `ready-for-agent` 票误读成已实现，也不能把早期历史验证误读成当前 checkout 的逐行验证。

本审计满足 Q162-A 的第一步：建立覆盖矩阵、区分历史实证/待实现/未验证，并列出第二票波前必须消除的缺口。它**不是**放行任意实现票的授权。

## 范围与证据口径

| 状态 | 含义 |
|---|---|
| 历史已验证 | 实施交接或独立验证记录明确记载提交、探针或测试结果；本审计未重新执行对应测试。 |
| 已票据化，未验证实现 | 有权威 `impl/tickets/` 合同，但没有可作为当前实现完成证据的记录。 |
| 部分覆盖/待复核 | 存在旧实现或局部验证，但其是否满足后续定案的全部合同尚未逐键复核。 |
| 缺口 | 没有对应的当前票，或没有能证明完整覆盖的实现/验证证据。 |

审计材料：`round-29-answers.md`、`round-29-questions.md`、`CONSENSUS.md`、`CONTEXT.md`、`impl/HANDOFF.md`、`impl/R6b-verification.md`、`impl/R8a-verification.md`、`impl/R9-verification.md` 和全部 `impl/tickets/01…14`。本文件没有将历史记录之外的内容断言为当前代码事实；当前 sibling worktree 的源码与测试尚未逐键复跑。

## 决策簇覆盖矩阵

| 决策簇 | 覆盖状态 | 证据或权威交付 | 尚存事实缺口 |
|---|---|---|---|
| AO 台账、因果开关、证据读取、Fork 身份/修订、相似边与簇（早期基础决定） | 历史已验证 | `HANDOFF.md` 的 S1–S6 和 43/43 新增测试记录。 | 未对当前 OpenViking checkout 重跑；技能调用真实来源、生产 ACL/HTTP/daemon 等宿主接线曾被明确列为边界。 |
| Influence View、ForkRevision、Bridge、引用、投影、评估循环（Round 9 基础） | 历史已验证，但有宿主边界 | `HANDOFF.md` 的 S7–S15、F1/F2、G1–G6/E1；最终一轮记 199 passed。 | 真实 LLM builder/reranker、常驻服务、完整上游 ACL 模型和真实向量索引仍是交接中明列的未完成宿主集成。 |
| Q109–Q114：post-run 生命周期、工作区预算、supersede、投影通道与 ACL 再投影 | 已票据化，未验证实现 | `tickets/01-post-run-trajectory-lifecycle.md`；R6b 证明了早期 Phase-2/adaptive seam 的局部行为。 | R6b 不是票 01 的完整生产化证明；工作区级预算、完整 ACL 再投影及 `needs_revalidation` 仍需按票验收。 |
| AIG 默认构建、多角色会话隔离、phase gate、fallback 与 summary-first | 已票据化，未验证实现 | `tickets/02-aig-multi-role-construction.md`，引用 ADR-0017/0023 与 CONSENSUS 61/67/68。 | 早期 View/Fork 库实现不等于完整 Builder/Critic/Refiner/Reader 运行链。 |
| Q134–Q139、Q159：角色化统一检索入口、Memory 无 exact、计划/信封/审计 | 已票据化，未验证实现 | `tickets/03-role-projected-retrieval-entry.md`。 | 必须证明伪造 exact 在 dispatch/lease/audit 前拒绝，且不向 Memory 泄露 exact 控制面。 |
| Q160：退役 Coforge Episode/Insight，保留 SkillRevision | 已票据化，未验证实现 | `tickets/04-retire-episode-insight-keep-skill-revision.md`；票 07/08/11/13/14 也显式继承此约束。 | 尚无证明新 discovery、expand、Hint/Offer 全面停止重新公开退役对象。 |
| Q126–Q133：SkillRevision 调用事件链、LCB、衰减、探索与 quarantine 权威 | 已票据化，未验证实现 | `tickets/05-skill-revision-utility-governance.md`。 | 需要真实事件链、5 outcome/3 lineage 与 10% exploration 的集成验证；不得把 offer/exposure/citation 计为 utility。 |
| Q140–Q146、Q149–Q152：非 Memory exact lane、配额、快照、RE2、命中合同 | 已票据化，未验证实现 | `tickets/06-non-memory-exact-lane.md`。 | exact 与 discovery 的独立配额、ACL 后截断、terminated 中间命中隔离尚未由本审计获得完成证据。 |
| Q147–Q148：typed corpus 与 central use-class | 已票据化，未验证实现 | `tickets/07-skills-only-typed-corpus-discovery.md`。 | 需要证明 adapter 不预裁剪、classifier 不泄露 excluded 数量，且不会把对象升格成 current evidence。 |
| Q153–Q154：8/4 分配、floor/ceiling、暂停空位、确定性交织 | 已票据化，未验证实现 | `tickets/08-allocation-and-deterministic-interleave.md`。 | 需验 `allocationHash` / `finalOrderHash` 稳定性、class 不借位与 exploration 插入位置。 |
| Q156-B：每语料 hybrid RRF | 已票据化，未验证实现 | `tickets/09-per-corpus-hybrid-rrf.md`。 | 旧 `hybrid-fusion-pending-v0` 不能当作该决定已落地；需证明 corpus-local RRF 与单语料退化。 |
| Q157-B：诊断子图类型化文本、BM25-only/top-3 | 已票据化，未验证实现 | `tickets/10-diagnostic-subgraph-typed-text.md`。 | 需证明敏感字段不入文本且没有将该路径与 Q156 的 discovery RRF 混合。 |
| Q155-B：served-anchor 一跳派生展开 | 已票据化，未验证实现 | `tickets/11-served-anchor-derived-expansion.md`。 | 需证明未 served 卡片不能当锚点、E1 失败不污染 E0、退役对象不能经关系重返。 |
| Q143–Q146：预算、截止、取消树、完整性 | 已票据化，未验证实现 | `tickets/12-budget-deadline-cancellation-completeness.md`。 | 需证明 sibling lane 隔离、parent cancellation fan-out 和 terminated lane 零公开命中。 |
| Q146-B/Q155-B/Q160-B：served-only Hint/Offer | 已票据化，未验证实现 | `tickets/13-served-only-hint-offer.md`。 | 必须在 membership/ACL/status 重验后才允许 Hint/Offer；partial Hint 不得吞掉后续 complete Hint。 |
| 多票合并后的完整调用路径 | 已票据化，未验证实现 | `tickets/14-e2e-retrieval-aig-skill-acceptance.md`。 | 票 14 被全部前置票阻塞，不能提前作为“端到端已绿”的证据。 |
| Q115：统一 worker 并发层级 | 历史已验证 | `HANDOFF.md` G5 记录 `WorkerSeatPool`、评测总并发 5、独立诊断子池 ≤3。 | 当前代码/调用方仍未复验。 |
| Q116、Q122：dependency-pattern query 与有界 Claim 邻域 | 历史已验证 | `HANDOFF.md` S13 记录依赖模式查询与冻结 view 内有界邻域。 | 后续统一检索入口改造是否保持该合同需在票 03/07/14 集成复验。 |
| Q120、Q123：grounding 反向索引/干预史 | 历史已验证 | `HANDOFF.md` S8 记录 `(view, position)` 反向干预史、ACL 读取与 revalidation。 | 当前实现及与 Reader READ_VERIFY 的集成未逐键复验。 |
| Q121：L2/L3 不合并（M1–M4′） | 部分覆盖/待复核 | CONSENSUS 将其定为 ADR-0010；早期 View/Fork 分层记录在 `HANDOFF.md`。 | 没有按 M1–M4′ 对现有实现和所有新票作逐项追踪表。 |
| Q117/Q118：Memory 自主监听检索与 Hint 投递节流 | 部分覆盖/待复核 | `HANDOFF.md` S14 记录未决 Hint ≤2、冷却、去重、偏好与 TTL 的节流实现。 | “每条消息完整三段检索、无 workspace 父级预算、模型判断停止”的自主监听合同没有对应当前票或完整验证证据。 |
| Q124/Q125：多根因有界 replay 与模型驱动 ExtractionPayload 合同 | 部分覆盖/待复核 | R6b 验证 adaptive seam、失败子图 brief 与 fork grounding；R9/R9-fix 验证 contract parser、台账对账、拒绝矩阵和用量记账。 | R9 明确记载 `--mode model` 尚未真实运行；多根因子集 replay 也没有本审计可确认的端到端验收。 |
| Round 9 Q50–Q108 | 部分覆盖/待复核 | 当前源码与 `HANDOFF.md` 的 S7–S15、F1/F2、G1–G6/E1 记录可追到多数库级合同；详细分组见下节。 | Q54/Q55/Q61/Q90/Q91 没有实现证据；Q63/Q65 仅部分近似；全量当前测试尚未重跑。 |

## 当前 checkout 静态核查补充（Pi 会话，未运行测试）

本节补充前述“历史验证”口径，而非把静态阅读升级为端到端验证。Cursor 会话 `68ddcada-e3c9-46ea-9719-20472d938d24` 能恢复并通过最小探针，但其复杂只读分析多次空答；本节只采用可审计的 Pi 会话 `skill-node-q162-audit` 返回的路径。

### Round 9（Q50–Q108）追踪结果

- **有历史实现与当前源码路径证据的主体**：Q50（typed facade）、Q52/Q53/Q92/Q93/Q93a（brief/outcome/评估编排与幂等 handoff）、Q56/Q62/Q77（ForkRevision 与投影）、Q59/Q64/Q67/Q71/Q75/Q76/Q80/Q83（Bridge）、Q60/Q106（Hint）、Q66/Q68/Q70/Q73/Q78/Q86/Q88/Q89/Q94（引用、强度与 outcome）、Q69/Q100（并发席位）、Q72（路径约束）、Q74/Q79/Q108（三语料配额/检索）、Q81/Q85（ControlContract）、Q82（评估循环）、Q87（seeded exploration）、Q95–Q97/Q99/Q101（Influence View）。主证据为 `impl/HANDOFF.md` 的 S7–S15、F/G/E1 与 `OpenViking/openviking/{retrieval_facade,causal_bridges,citation_ledger,influence_view,evaluation_orchestrator}.py`。
- **已存在但仅部分覆盖**：Q51/Q57（无明确 `MemoryTaskState` 类）、Q58（父级上限有局部实现）、Q63（无明确 interaction/causal 双 lane）、Q65（无 `InteractionPathWorker` 编排）、Q105（Claim 邻域未等同完整 T_log adapter）、Q98/Q104（`aig_role_chain.py` 与测试存在，但完整生产链仍由票 02/14 覆盖）。
- **Cursor 交叉核查（2026-10-10）**：`impl/cursor-evidence-closure-20261010.md` 确认 Q54 有 `SCORE` 状态但没有 step-reward scorer；Q55 有 benchmark Memory 成员脚手架但没有 per-run Diagnosis runtime；Q63/Q65 分别只有 causal/exact-discovery 的局部通道与 WorkerSeatPool，而没有所需的 Interaction lane/`InteractionPathWorker`；Q61、Q90、Q91 仍无实现证据。该报告未运行测试，且不改变关闸状态。
- **无实现证据**：Q61（跨任务四维语义重排）、Q90（权威 task_id 铸造）、Q91（`debiased_reference_signal` 的离线消费者）。
- **明确宿主延后**：真实 LLM builder/critic/reranker、真实 embedding 索引、HTTP/daemon 与完整上游 ACL 属 `HANDOFF.md` 的“明确出栈后续”，不能由库级对象替代。

### 票 01–05 的当前代码状态

| 票 | 当前代码可确认 | 仍缺证据或实现 | 状态 |
|---|---|---|---|
| 01 | `OpenViking/openviking/session/trajectory_index.py` 有优先级、暂停/预算跳过和 fallback；`trajectory_index_hook.py` 在 commit 后入队；`influence_view.py` 有 coverage/freeze；`influence_projection.py` 有 ACL/supersede API。 | 实际预算持久化仍为 per-session，不是 workspace；无独立 daemon；ACL outbox 自动再投影/消费链未接。 | 部分 |
| 02 | `OpenViking/openviking/aig_role_chain.py` 有 construction mode、角色隔离、三轮上限、phase gate、evidence escalation；有 `test_aig_role_chain.py`。 | 模块仅由测试导入；没有生产接线、真实 LLM Builder/Critic/Refiner 或冻结 L0/L1→View 流程。 | 部分 |
| 03 | `memory_role_retrieval.py` 有 Memory exact 提前拒绝、字段白名单、bound context、最小信封；`retrieval_control.py` 有 lane 终止/完整性结构。 | Memory discovery audit 未闭合 terminated 状态；非 Memory 双 lane、typed corpus 与 12 席位仍依赖票 06/07/08。 | 部分 |
| 04 | Coforge `apps/web/src/server/workspace-memory/memory-discovery-eligibility.ts` 与消费方已拒绝 Episode/Insight，保留 SkillRevision；OpenViking 有 `_RETIRED_KINDS` 协调器。 | OpenViking coordinator 仅测试引用，未接 facade；无迁移证明。 | Coforge 完成；OpenViking 部分 |
| 05 | `OpenViking/openviking/skill_revision_utility.py` 有完整事件链、排除非 utility、30/180 衰减、LCB、10%/5/3 门、quarantine 权威与 hysteresis。 | `SkillUtilityLedger` 仅被测试引用；未与真实 discovery/分配共享 ledger。 | 部分 |

因此，审计从“Round 9 整块无证据”修正为“多数库级合同有历史/静态证据，但仍有明确无证据、部分合同和宿主集成缺口”。此修正**不**构成票 01–05 的完成或放行。

## 票据依赖与可启动性

`impl/tickets/01` 至 `05` 写有技术上的 `Blocked by: None`，但这只说明它们不依赖同波其他票。**它不覆盖 Q164-A 的更高优先级治理闸门。** 因此本审计完成前后，它们均不得自动开工。

票 06–13 有明确同波依赖，票 14 依赖 01、02、05–13；票 14 是集成验收，不是提前合并或提前放行的理由。

## 解除实施闸门前仍需的证据（事实工作，不是重新设计）

1. 在当前目标分支复跑并记录与票 01–05 相关的验证；静态阅读不能替代运行时、跨仓库和 ACL/outbox 集成验证。
2. 为 Q54/Q55/Q61/Q90/Q91、Q63/Q65 的部分合同、Q117/Q118 自主监听、R9 的真实模型运行和 Q124/Q125 的端到端 replay 给出实现证据、明确延期理由或新的有界实现票。
3. 对票 06–14 保持“合同存在、尚未验证实现”的状态；在其前置票通过前，票 14 不得作为端到端完成证据。
4. 上述材料补齐并经用户确认前，不选择第二票波，不放行 01–05，也不启动任何实现。

## 设计 frontier

产品/领域设计 frontier 仍为空。完成上述事实工作后，唯一可能出现的下一轮问题是一个**实现编排**决定：在已列出缺口与风险的前提下，是否继续保持实施闸门，或明确授权一组指定票。该问题在本文件生成时尚未获得用户授权。


## Q165 决定（2026-10-10）

用户选择 **A：继续关闭实施闸门**。在“解除实施闸门前仍需的证据”完成并获得新的明确授权前，不启动任何实现票；后续 Cursor/Pi 工作仅可进行只读核查、测试复验、缺口归档或延期理由整理，不得修改产品代码。
