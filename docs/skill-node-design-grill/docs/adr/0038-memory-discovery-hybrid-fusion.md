# Memory Discovery Hybrid Fusion

**Decision key:** `memory-hybrid-fusion/Q156-B`
**Status:** `accepted`
**Decision:** Per-corpus dual-retrieval union with equal Reciprocal Rank Fusion
**Source record:** `/tmp/kiro_b11.log`
**Scope:** OpenViking `memory_discovery` 内每个 typed corpus 的词法/向量候选召回、退化语义、确定性顺序与审计；不改变 Q147–Q155 的 corpus topology、use class、allocation、interleave 或 expansion 规则。

## 背景

当前 OpenViking `session/retrieval_facade.py` 的 hybrid 逻辑先以 BM25-positive cards 建候选池，再在该池内分别对 BM25 与 cosine 做 min-max normalization，并使用：

```text
0.25 × normalized BM25 + 0.75 × normalized vector similarity
```

排序。它有两个结构性问题：

1. 向量只参与 BM25 已命中的对象，语义相关但词面零重叠的 card 永远不会被发现；
2. 任一向量异常会令共享 rank plan 回退，使其他本可完成向量检索的 corpus 也随之失去向量召回。

例如，事实记忆写作 “answer tersely”，当前任务查询为“用户不喜欢冗长回复”。若没有共同词，BM25 为零，即使向量相似很高，该事实仍无法进入候选集合。

这里的 fusion 仅形成**单一 corpus 内的 corpus-local total order**。它不得把异构 corpus 的原始 BM25/cosine 分数变成全局可比较分数，且不得绕过既有 central use-class、Q153 allocation 或 Q154 interleave。

## 不重开的约束

1. typed corpus adapter 仍只报告原生对象、身份、状态、来源内排序与受控 audit；outer coordinator 仍独占 ACL/status recheck、use-class 和 public selection。
2. Fusion 发生在每个 corpus 的 native ordering 中，早于 Q153 floor/ceiling/flex allocation，且不产生 envelope-wide global score。
3. 每个 corpus 必须有版本化、完整、确定性的 total order，并以 canonical identity 作最终 tie-break。
4. Vector failure、timeout、unavailable embedding 或 completeness proof failure 只能影响对应 corpus；不得终止 completed sibling corpus，也不得将整个 `memory_discovery` lane 伪装为 global BM25 fallback。
5. 退化 corpus 仍必须遵守同一 ACL/status、use-class、allocation、interleave、deadline、budget 与 audit 合同。
6. Q153/Q154 决定 seat membership 与 class-local public order；fusion 不得二次截断、跨 class 回填或按异构分数全局重排。

## 备选方案

### Option A：Lexical-gated min-max fusion

保留当前 BM25-positive gate；向量只重排已词法命中的 cards。

优点是实现和运行成本最低，排序可预测。缺点是保留语义零词面重叠对象不可发现的盲区；BM25/cosine min-max 对候选集敏感，也继续将任意向量异常扩大为共享 rank-plan 降级。

### Option B：Per-corpus dual union + equal RRF

对每个 corpus 独立运行两种召回：

```text
BM25 top 32
vector top 32
→ canonical-identity union and dedup
→ equal Reciprocal Rank Fusion, k = 60
→ canonical identity tie-break
→ versioned corpus-local total order
```

对象只要在任一通道进入 top-32 即可被发现。融合分数为：

```text
RRF(card) = 1 / (60 + bm25Rank) + 1 / (60 + vectorRank)
```

缺席的通道贡献为零；不把原始 BM25 和 cosine 数值直接相加或归一到共同尺度。

每个 corpus 必须产生 vector completeness proof，证明该 corpus 的向量候选是否以同一 snapshot、index/model/policy version、ACL/status boundary 和 requested depth 完整可用。若该 proof 缺失或向量路径失败，该 corpus 单独退化为其 BM25 top-32 的 deterministic local order，并记录 versioned fallback reason；其他 corpus 继续自己的 dual union + RRF。

### Option C：Dual union + outcome-calibrated score fusion

先按 B 取并集，再以历史 outcome 学得的校准器融合 lexical/vector 分数。

这在有高质量、跨 corpus/use-class 可治理的训练与反事实评测数据时可能提高长期效果；但当前尚无足以支撑可解释训练、漂移治理和线上回退的 evidence。它会过早引入跨对象尺度与模型治理问题。

## 决定

采用 **Option B**：

```text
memory-hybrid-fusion/Q156-B
```

接受的完整合同：

1. 每个 typed corpus 独立取 BM25 top-32 与 vector top-32；
2. 两列表先按 canonical native identity 去重并取并集；同一对象在两路均出现时保留两个 rank contribution；
3. 使用 equal RRF，固定 `k=60`；权重相等，fusion policy version 进入 corpus-local ordering/audit；
4. RRF 只比较同一 corpus 内的 cards；其后以 canonical identity 做最终 deterministic tie-break；
5. 每个 corpus 需要 vector completeness proof；proof 包含适用的 snapshot/index/model/policy 与 native retrieval completion 依据，具体敏感细节只入受控 audit；
6. 向量异常、超时、embedding/index unavailable 或 completeness proof failure 时，仅该 corpus 退化为 BM25 top-32 local order；不重跑或降级已成功的 sibling corpus；
7. BM25 也不可用或该 corpus 没有 authorized eligible card 时，由既有 corpus-local failure/empty semantics 表达；不得以未授权对象补位；
8. Fusion output 作为 adapter 的 versioned corpus-local total order 输入，继续经过中央 ACL/status recheck、use-class、Q153 allocation、Q154 zipper 与 allocation/final-order hashes；
9. Public envelope 不公开 raw ranks、vector completeness details、index/model internals 或 hidden candidate counts；这些与 per-corpus fallback reason 进入受控 native audit。

## 场景

### 语义强、词面为零

用户偏好对象为“answer tersely”，查询为“用户不喜欢冗长回复”。

- A：BM25 为零，card 不进入候选；
- B：vector top-32 包含该 card，进入 union，并以 RRF 参与其 corpus-local order；
- C：同 B 可发现，但还需要当前没有的数据驱动校准器解释分数。

### 单一 corpus 的向量索引超时

Fork corpus 的向量索引超时，而 skill corpus 的双路召回完成。

- B：Fork corpus 用 BM25 top-32 deterministic order；skill corpus 仍用 RRF；两者随后按各自 local order 参与现有 allocation/zipper。
- 不允许：因为 Fork 向量失败而重跑所有 corpus 的 BM25-only plan，也不允许公开部分未完成 vector candidates。

### 同一对象双路命中

一个 active skill 在 BM25 rank 2、vector rank 7：

```text
score = 1/(60+2) + 1/(60+7)
```

它只作为一个 native card 进入 union；两个 rank 是该 card 的两个 RRF 贡献，而不是两个 public seats。

## 拒绝其他方案

拒绝 A，因为 lexical gate 会系统性丢失语义相关而词面零重叠的记忆，且将向量异常的影响扩大到整个 shared rank plan。

拒绝 C，因为 outcome-calibrated fusion 需要当前不存在的可靠训练数据、跨 corpus 治理、漂移控制与可解释回退；在这些前提具备前，RRF 提供更可审计的 rank-only 融合边界。

## Audit

每个 corpus 的受控 fusion audit 至少记录：

```text
fusionPolicyVersion
bm25CandidateDepth = 32
vectorCandidateDepth = 32
rrfK = 60
bm25CompletionRef
vectorCompletenessProofRef | vectorFallbackReason
nativeIdentityDedupRef
corpusLocalOrderVersion
canonicalTieBreakVersion
```

Public `LaneAudit.featureVersions` 可以标明启用的 fusion policy，但不得泄露单对象 raw score/rank、hidden candidate count、向量服务拓扑、敏感模型版本或 ACL-filtered 对象。

## 后果

### 正向

- 语义召回不再受 BM25-positive gate 限制；
- RRF 避免直接混合不可比较的 BM25/cosine 数值；
- vector failure 的 blast radius 收窄到单一 corpus；
- 输出继续满足 Q153/Q154 的 deterministic allocation/interleave contract；
- 为未来以真实 outcome 评估校准融合提供可审计基线。

### 成本

- 每个 corpus 增加双路候选检索、union/dedup 与 completeness proof；
- 需要持久化 per-corpus vector fallback 和 ordering audit；
- 现有 lexical-gated min-max 行为与测试必须迁移；
- BM25/vector candidate depth、RRF k、proof schema 和 tie-break 需版本化。

## Frontier

`memory-hybrid-fusion/Q156` 已闭合。下一项按依赖顺序处理独立源码 policy seam：`diagnostic-subgraph-text/Q157`。它不改变本 ADR 的 fusion 合同。
