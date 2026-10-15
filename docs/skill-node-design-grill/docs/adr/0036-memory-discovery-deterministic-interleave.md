# Memory Discovery Deterministic Interleave

**Decision key:** `memory-discovery-interleave/Q154-B`
**Status:** `accepted`
**Decision:** Rank-depth zipper + reuse allocation stable rotation
**Source record:** `/tmp/kiro_b9.log`
**Scope:** 对 `memory-discovery-allocation/Q153-B` 已冻结的 candidate/prior selected sets 分别生成确定性 public array 顺序；不改变 membership、seat counts 或 use class，也不决定 Coforge expansion placement

## 背景

统一 retrieval envelope 已将 discovery 结果分为：

```text
memoryCandidateCards[]
analogicalPriorCards[]
```

`memory-discovery-allocation/Q153-B` 已固定：candidate 最多 8、prior 最多 4、总 cap 12；每 corpus floor=1、ceiling=4；只做 same-class backfill；flex 按 corpus-local rank depth water-fill；同 depth 使用 planHash + allocation policy version + use class 派生 stable rotation；fact paused 时封存一个 prior seat；candidate 内最多一个 discovery-wide exploration card。

因此本 ADR 只决定已选 cards 的 array position。Final ordering 很重要，因为靠前内容会受到模型与人的 attention/primacy bias，但它不能成为第二次 allocation，也不能用排序结果静默删除、添加、重复或跨 class 移动 cards。

## 现有实现约束

### OpenViking

`OpenViking/openviking/session/retrieval_facade.py` 的 `_rank_hits()` 在单 corpus 内使用 BM25 或 BM25/vector fusion。相同 score 时 Python stable sort 保留输入顺序，但输入顺序来自不同机制：fork index 首次出现顺序、branch ID 排序、projection registry 返回顺序或 ledger sequence。旧 `HybridRetrievalFacade` 再将 stateful/fact cards 拼接、调用任意 rerank hook并 clamp 12；它没有 unified typed-corpus final-order contract。

旧 provisional exploration 顺序也绑定旧 verified/provisional 8/4：exploitation prefix 在前、探索卡在 provisional primary 末尾，整个 provisional 又在 verified 后。Q153-B 的 candidate/prior arrays 与 discovery-wide exploration seat 不能继承该顺序。

### Coforge

`memory-similarity.server.ts` 当前只按 `score DESC, kind ASC` 排序；typed corpus 拆分后，同 kind 同 score 仍缺 `id ASC` total tie-break。

`memory-expansion.server.ts` 多条 provenance SQL 没有 `ORDER BY`，结果按数据库返回与 `push` 顺序抢 limit；similar 分支也只有 `score DESC`。后续 `memory-expansion-placement/Q155-B` 已将 expansion 放到 frozen envelope 后的 derived operation，并要求 expanded cards 在进入原 kind corpus queue前取得 versioned path/local total order，不能把数据库物理顺序变成 public rank。

## 所有选项共同遵守的合同

### 两个独立 public ranks

```text
memoryCandidateCards[i].publicRank = i + 1
analogicalPriorCards[i].publicRank = i + 1
```

不存在 envelope-wide discovery rank，也不存在 candidate 与 prior 可比较的 public score。Public rank 只表达 array position，不表达 evidence strength、utility 或执行资格。

### Corpus-local total order

每个 typed corpus adapter 必须输出：

```text
corpusLocalRank
corpusOrderPolicyVersion
nativeScoreBreakdown?  # 只在来源内解释
canonicalCardRef
```

最低 total-order 规则为：native primary ranking features → 该 corpus 显式 status/native tier（若采用）→ canonical native identity bytes ascending。

具体要求：

- Coforge trigram corpus：`score DESC, id ASC`；
- fork/branch：BM25/hybrid 后以 canonical fork/branch ref 收尾；
- projection：score 后以 projection card ID 收尾；
- segment/atom：score 后以 `(sourceSessionRef, sequence, aoId, kind)` 收尾；
- 无 score expansion：Q155 必须定义 relation/path/depth primary key，再以 canonical identity 收尾；未定义前不得进入 initial selected set。

### Pre-allocation identity dedup

同一 native object 通过多条发现路径出现时，按 `(corpus, nativeIdentity, revision)` 合并：保留最佳 corpus-local rank，有界合并并排序 provenance paths；不同 revision 不合并，不跨 kind 猜测语义相同。Dedup 后再执行 Q153 floors/flex，避免同一对象占多个 seats。

### Membership freeze

Q153 输出内容寻址的 `AllocationResult`：

```text
selectedCandidateRefs[]
selectedPriorRefs[]
explorationRef?
seatAssignments[]
allocationHash
```

Final interleave 只能返回两个 selected ref 集合的 permutation。缺少、新增、重复 ref 或 use-class 改变都必须拒绝；不得由 reranker重新截断。

### Replay

相同 planHash、snapshotRef、use-class/allocation/corpus-order/interleave policy versions 与 allocationHash 必须产生相同 arrays 和 finalOrderHash。旧 operation replay 返回已冻结顺序，不使用新 policy现场重算。

## 备选方案

### Option A：Fixed Corpus Blocks

#### 机制

Candidate 固定顺序：

```text
skill_revision → insight → fork/branch → exploration
```

Prior 固定顺序：

```text
projection → episode → segment/atom
```

每个 block 内按 corpus-local total order。Exploration card 从原 corpus exploitation block 排除并固定在 candidate array 最后。

#### 优点

- 实现与 byte-level replay最简单；
- corpus 分组直观；
- exploration 不冒充 top exploitation；
- audit 只需 block ordinal + local rank；
- 迁移容易做 golden tests。

#### 权衡

- 固定前置 corpus永久获得 primacy advantage；
- 前面 corpus local-rank4 仍早于后面 corpus local-rank1；
- block order 暗含跨 corpus 价值排序，却没有共同证据；
- exploration 永远最后，可能实际得不到 attention；
- 新 corpus 接入会改变所有后续 block positions；
- 强调展示整齐而不是跨 corpus coverage。

#### 后果

A 让 Q155 接线简单，但 expanded card 的影响高度取决于它被归入哪个固定 block。

### Option B：Rank-depth Zipper + Stable Rotation

#### 机制

Candidate 与 prior 分别建立已选 corpus queues，每个 queue 已按 corpus-local total order 排序。Final interleave 复用 Q153 allocation 已派生的同一个 class rotation：

```text
candidateRotationRef
priorRotationRef
```

对 exploitation cards 执行：

```text
for depth = 1..maxSelectedDepth:
  for corpus in stableRotation(useClass):
    if selected exploitation card exists at depth:
      emit(card)
```

Depth 是 corpus-local selected exploitation rank depth，不比较数值 score。Q153 只决定每个 queue 有几张，Q154 不补位、不删位。

Exploration placement：

1. 先输出第一轮 exploitation，即每个有 selected exploitation card 的 candidate corpus 最多一张；
2. 紧接第一轮输出唯一 exploration card；
3. 再继续 depth-2、depth-3… zipper；
4. 若其他 corpus 无 exploitation，仍在它们现有首轮后输出 exploration；
5. 若完全没有 exploitation，exploration 成为 candidate publicRank=1；
6. card 始终保留 `selectionMode=exploration` 与 native provisional/cold-start warning，位置不是质量等级。

Prior 无 exploration，直接按 prior rotation zipper。Fact pause hole 不生成 placeholder card，实际 priors 仍使用连续 publicRank 1..N。

Canonical ordering key：

```text
useClass
interleaveRound
explorationAnchorOrdinal
rotationOrdinal
corpusLocalRank
canonicalCardRef
```

普通卡 `interleaveReason=rank_depth_zipper`；探索卡 `interleaveReason=exploration_after_first_round`。

#### 复用 allocation rotation 的原因

如果 allocation 与 presentation 各自派生 rotation，同一请求可能用 A-B-C 决定席位，却用 C-A-B 展示，产生两套无业务意义的伪随机顺序。复用同一 rotationRef 可让两个阶段共享一个 fairness policy，降低位置噪声和审计复杂度，同时不改变 membership。

#### 优点

- 不建立跨 corpus common score；
- 每个 corpus local-rank1 在 deeper cards 前获得展示机会；
- planHash-seeded rotation减少固定 corpus长期前置偏差；
- 复用 allocation rotation，replay只需解释一套 class order；
- exploration既不在最前，也不被永久埋在最后；
- corpus 稀疏时自然退化；
- 新 corpus只需加入 rotation vocabulary；
- 可由离散 ordinal keys完全重建。

#### 权衡

- 不是全局 relevance order；
- floor 的弱 local-rank1 可能早于另一 corpus 的强 local-rank2；
- planHash 不同可导致第一 corpus不同；
- exploration 在首轮后获得较强 attention，必须保留明显 warning；
- corpusLocalRank policy升级会改变顺序，必须版本化；
- consumer擅自按 native score重排会破坏合同；
- 只有 exploration 的 corpus 由统一 anchor而非普通 round表达，需要 audit解释。

#### 后果

若 Q155 让 expansion 参与 initial retrieve，expanded card 必须先进入原 kind corpus queue，完成 identity dedup、local total order和Q153 allocation，再参与 zipper；不得在 final array尾部直接 append。若 expansion 是 envelope 后操作，原 envelope不可修改。

### Option C：Frozen Cross-corpus Reranker

#### 机制

Q153 membership冻结后，将每个 class 的最多 8/4 cards 交给 deterministic permutation-only reranker。它使用统一 feature schema，例如 semantic relevance、same-task/cluster applicability、native status/provenance、freshness、selectionMode、corpus-local rank percentile，以及仅对 skill 有值的 utility_LCB。NA 必须显式表示，不能填 0。

Reranker score 只进受控 audit，不成为 public/global或跨 lane score。相同 score 用 `(corpusKind, canonicalCardRef)` 收尾。Exploration 不参与 exploitation rerank，固定插入 `min(4, len(exploitation)+1)`。

#### 优点

- 可利用跨 corpus query relevance 与 applicability；
- 只改顺序，不破坏 Q153 membership；
- selected set 小，cross-encoder成本可能可控；
- 能优化前几位 attention quality；
- exploration位置仍有硬规则。

#### 权衡

- 建立了 discovery class 内共同排序尺度；
- kind-specific features的 NA处理容易造成隐藏偏置；
- 模型/库/硬件版本会引入漂移和复现成本；
- 文本长度差异可能偏向某些 corpus；
- 内部 score易被误用为 evidence quality；
- timeout/failure需要冻结 fallback语义；
- expansion card必须加入同一 feature schema；
- 当前没有数据证明 central reranker收益。

#### 后果

C 新增中央 ranking deep module。即使 membership不变，治理、fallback与Q155接入成本都高于 ordinal zipper。

## 场景示例

Q153 已选：

```text
candidate exploitation
  fork:  F1 F2 F3
  insight:I1 I2 I3
  skill: S1
candidate exploration
  FX
prior
  projection:P1 P2
  episode:E1
  fact: paused hole
```

Candidate rotation=`insight → fork → skill`，prior rotation=`episode → projection → fact`。

- A：candidate=`S1,I1,I2,I3,F1,F2,F3,FX`；prior=`P1,P2,E1`。
- B：第一轮 `I1,F1,S1`，随后 `FX`，再 depth zipper，得到 candidate=`I1,F1,S1,FX,I2,F2,I3,F3`；prior=`E1,P1,P2`。
- C：可能先 rerank exploitation为 `F2,I1,S1,F1,I3,F3,I2`，再将 FX 插第4；需要解释跨 kind features为何把 F2 放在 F1前。

## 决定

采用 **Option B**：

```text
memory-discovery-interleave/Q154-B
```

接受的完整合同：

1. Candidate/prior 分别拥有 class-local publicRank，不存在 envelope-wide discovery rank或共同 public score；
2. adapters 必须提供 versioned corpus-local total order与 canonical identity tie-break；
3. 同 native object 在 allocation 前按 corpus/identity/revision dedup；
4. Q153 AllocationResult 以 allocationHash冻结 membership；interleave只能做完整 permutation；
5. 每个 use class 按 corpus-local rank depth zipper；
6. 复用 Q153 的 candidate/prior rotationRef，不派生第二套 rotation；
7. candidate exploration card固定在第一轮 exploitation后；无 exploitation时 rank=1；
8. fact pause hole不生成 placeholder，publicRank连续；
9. 每张 card记录 corpusLocalRank、allocationReason、interleaveReason与 tie-break version；
10. 两个有序 arrays 产生 finalOrderHash；相同 plan/snapshot/policy/allocationHash 必须 byte-identical replay；
11. final order不得删增、重复、跨 class或重新截断；
12. consumer不得按异构 native score再次重排。

## 拒绝其他方案

拒绝 A，因为固定 corpus block产生永久 primacy bias，并把 local-rank1 放在其他 corpus local-rank4后；exploration永久末尾也削弱实际探索。

拒绝 C，不是禁止未来离线学习排序，而是当前没有跨 corpus outcome证据证明共同 reranker收益，且它会引入 kind-specific NA、模型确定性、fallback和expansion feature治理。Ordinal zipper已能在不建立共同 score的前提下形成可重放公平顺序。

## Audit

受控 `InterleaveAuditV1` 至少包含：

```text
allocationHash
interleavePolicyVersion
corpusOrderPolicyVersions
candidateRotationRef
priorRotationRef
explorationPlacement
entries[] {
  cardRef
  useClass
  publicRank
  corpus
  corpusLocalRank
  allocationReason
  interleaveReason
  tieBreakVersion
}
finalOrderHash
fallbackReason?
```

Public envelope不内联内部 native scores、eligible counts、rotation seed原文、ACL labels或 excluded counts。Public card可以带 class-local publicRank、kind/status、selection mode和source ref。

## 后果

### 正向

- final order与Q153 allocation共享同一 ordinal/fairness词汇；
- 无跨 corpus common score；
- corpus local-rank1得到早期展示机会；
- exploration获得明确而不过度前置的位置；
- membership与presentation权限分离；
- 相同输入可重建到字节级有序 arrays。

### 成本

- 所有 adapters必须补 total identity tie-break；
- Coforge expansion在进入 initial queue前必须先定义稳定 relation/path/depth order；
- consumer和prompt assembly必须尊重 typed arrays与 publicRank；
- policy升级需冻结旧 operation结果并更新 versions。

## 解锁的下一节点

Q154-B 解锁最终节点：

```text
Q155: Coforge exploration/expansion placement
```

Q155 必须遵守：

1. expansion若参与 initial retrieve，expanded card先进入原 kind corpus queue，完成 dedup、local total order、Q153 allocation与Q154 zipper，不能尾插；
2. expansion若发生在 frozen envelope后，原 envelope不可修改，必须形成新 operation/response并绑定 served anchor proof；
3. 无论位置如何，expanded objects都重新经过 ACL/status/use-class，并服从 class cap、corpus ceiling与总 cap。
