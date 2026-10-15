# 需求一致性审计与协作关系（2026-10-12）

**状态：已确认的需求治理整合；不授权实施。** 本审计不证明任何产品代码已经实现，也不改变 **Q165-A 实施闸门保持关闭** 的决定。

## 1. 已确认的权威层级

1. [ADR-0043](./adr/0043-aig-native-fork-overlay-and-guided-remediation.md) 与 [`CONTEXT.md`](../CONTEXT.md) 的 Q166–Q189 是 Fork/AIG **新写模型**的最高权威。
2. [`CONSENSUS.md`](../CONSENSUS.md) 对未被 ADR-0043 明确取代的横切合同继续有效，尤其是 AO ledger、ACL、provenance、append-only 审计、检索、效用和安全/预算门。
3. ADR-0010、ADR-0012、早期轮次和交接材料中冲突的 Claim/Cut/独立 ForkRevision 写模型，只保留为 legacy 只读审计和显式迁移的历史依据。
4. `impl/` 中的计划、覆盖审计、票据和 pending 清单属于执行或证据材料：它们不改变产品模型，不证明当前实现已完成，也不构成实施授权。

## 2. 现行协作关系与依赖图

```text
AO ledger / Segment / Interaction DAG（事实、ACL、provenance）
  → 冻结事实 AIG revision（AO-derived Block + 原生继承/影响边）
    → ReaderReport（冻结的只读证据结论）
      → Reader ForkProposal
        → 服务端验证与持久化 ForkNode overlay（base_revision_id + anchor_block_id）
          → BranchStepRef / StrategyPattern / BranchEvaluation
          → 受控先例检索与 GuidanceDocument

OutcomeContract + OutcomeEvidencePolicy
  → Reader TaskOutcomeAssessment
    → confirmed failure 才可产生可执行 GuidanceDocument
      → 服务端 target selection
        → ACL + permission + budget + safety + capability + idempotency 全部门
          → linked child remediation run
            → GuidanceExecutionReport → production-direct evidence（仅对齐行动）

ReplayEligibility
  → 隔离 replay run / 独立 Replay AIG
    → FirstActionAlignment 与前缀/整支对齐
      → replay-direct evidence；不得污染生产事实 AIG
```

所有箭头都受 ACL、watermark/provenance、内容哈希、幂等、预算和追加审计约束。Memory 的职责是 ACL-scoped 检索入口和已批准 `GuidanceDocument` 的发布者；它不能构图、归因、写 Fork 或自行选择/派发目标 agent。

## 3. 冲突、协同与裁决

| ID | 材料关系 | 冲突或协同 | 裁决 |
|---|---|---|---|
| C1 | ADR-0043 / CONTEXT 与 CONSENSUS #61–#71、ADR-0010 | 旧模型将 Claim 作为可投影、可 grounding 的对象；新模型禁止新写 Claim。 | 新写只用事实 Block、原生边和 Block-anchored overlay；旧 Claim 只读。未涉及 Claim 的索引/ACL/审计要求继续协同。 |
| C2 | ADR-0043 与 ADR-0012 | 旧模型以独立 `ForkRevision`、cut grounding 和 Diagnosis 写 Fork 为中心。 | 新写由 Reader 冻结报告后的 proposal 和服务端持久化的 `ForkNode overlay` 取代；ControlContract、幂等和历史证据约束仍可复用。 |
| C3 | Reader / Critic / Memory / 服务端 | 旧文档易使图审查、任务结果、Fork 写入和 remediation 职责混叠。 | Critic 只评图；Reader 独占结果评估与 ForkProposal；Memory 只检索/发布；服务端独占验证、target selection 与 gated dispatch。 |
| C4 | Q164-A 与 Q165-A | 两个标识均被用于“实施闸门关闭”。 | **Q165-A 是唯一现行标识；Q164-A 是覆盖审计中的历史别名。** 任何未来开闸必须显式引用 Q165-A。 |
| C5 | 实施计划与覆盖审计 | P00–P12 是依赖图；覆盖审计列出证据缺口。 | 两者协同定义未来实施的前提，但 gate 关闭时只可用于细化、审查、测试准备和只读复验。 |
| C6 | 历史 handoff / pending 清单 与现行规范 | 历史材料含已被取代的模型，且“pending”标题可能被误读为当前 frontier。 | 保留原文作为决策证据，加入现行模型注记；不得将其作为新写要求或实现授权。 |

## 4. 已死、已取代或仅历史适用的需求

以下要求不删除记录，但在 **新写模型**中已失效；它们仅能用于只读 legacy 数据、审计或显式迁移理由：

- 创建新的 `InfluenceClaim`，或让 Claim 拥有独立状态、projection、grounding/验证生命周期。
- 以 `block|edge|cut` 作为新 Fork grounding，或用 Claim 邻域/Claim dependency query 支撑新 Fork 写入。
- 创建独立于冻结 AIG 的 L3 `ForkRevision`，或由 Diagnosis 直接生成/写入 Fork。
- 将 imagined node 升格为事实 Block，或使 replay AIG 写回生产 AIG。
- 将历史 Claim/Cut/Fork 静默转换为新 Block grounding、永久双写，或让其参与新 Pattern、GuidedBranch 和检索演化。
- 把 `Q164-A` 作为可放行实施的现行 gate 标识。

## 5. 因依赖关系而调整的方案

| 原方案/风险 | 依赖事实 | 调整后的要求 |
|---|---|---|
| 直接重写旧 ADR/交接文本 | 历史文本仍是迁移和审计的来源证据。 | 保留历史原文；只增加明确的取代范围注记和到 ADR-0043 的链接。 |
| 因 `ready-for-agent` 票或历史测试而启动实现 | 覆盖审计尚未提供当前 checkout、跨仓、ACL/outbox/宿主集成的闭环证据。 | 保持 Q165-A 关闭；只做只读核查、验证复跑、缺口归档、延期理由或测试准备。 |
| 对 legacy 数据做一次性“兼容”转换 | 新旧模型的事实边界和身份模型不同。 | 采用 expand → migrate → contract；新建 overlay，并记录 legacy fork ID、原 grounding snapshot 和迁移理由；先双读兼容，后停止旧写入。 |
| 自动 remediation 将建议视为执行结果 | 直接证据取决于事实 AIG 和实际行动对齐。 | 只在 linked child remediation run 中执行；通过 `GuidanceExecutionReport` 和对齐规则追加证据，偏离不自动反驳策略。 |

## 6. 已闭合的问题与后续前提

本轮已确认：

- **Q-R1（权威层级）：** 采用第 1 节的层级；ADR-0043/CONTEXT 优先，CONSENSUS 补充适用，历史材料不再定义新写模型。
- **Q-R2（历史文档处理）：** 保留历史原文并加入取代范围注记，同时维护本集中审计。
- **Q-R3（gate 标识）：** Q165-A 为唯一现行标识，Q164-A 仅为历史别名。
- **Q-R4（交付边界）：** 本轮只更新需求治理文档；不改产品代码，不声称设计已实现，gate 继续关闭。

当前产品/领域设计 frontier 为空。未来是否重新打开 Q165-A 不是当前问题：它依赖覆盖审计所列的当前分支验证、跨仓/ACL/outbox/宿主集成证据，以及用户对明确实施范围的新授权。

## 7. 本次文档对齐范围

- `CONSENSUS.md`：更新 ADR 索引范围并声明现行模型的取代边界。
- `docs/adr/0010-*.md`、`docs/adr/0012-*.md`：保留历史 ADR，标注 ADR-0043 的精确取代范围。
- `handoff-subgraph-retrieval-20260929.md` 与 `impl/pending-design-decisions.md`：标为历史/执行性材料，防止误用为现行新写规范。
- `impl/decision-coverage-audit-20261009.md`：把 Q165-A 设为现行 gate 标识，并保留 Q164-A 的历史可追溯性。
