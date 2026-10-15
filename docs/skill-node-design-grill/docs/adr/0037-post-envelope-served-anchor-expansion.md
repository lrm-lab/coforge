# Post-envelope Served-anchor Expansion

**Decision key:** `memory-expansion-placement/Q155-B`
**Status:** `accepted`
**Decision:** Frozen initial envelope 后执行 served-anchor derived expansion operation
**Source record:** `/tmp/kiro_b10.log`
**Scope:** Coforge episode/insight/skill provenance expansion 相对 initial `retrieve(SearchPlan)` 的生命周期、snapshot、budget、ordering、failure、API 迁移与 Hint/Offer grounding；不改变 Q147–Q154 的 corpus/use-class/allocation/interleave 决策

## 背景

本决定建立在以下已接受边界上：

- `memory-corpus-topology/Q147-B`：outer coordinator消费typed corpus adapters；
- `memory-use-class-policy/Q148-B`：balanced candidate/prior/excluded；
- `memory-discovery-allocation/Q153-B`：candidate 8 / prior 4、floor/ceiling、same-class flex、fact pause hole、统一 exploration seat；
- `memory-discovery-interleave/Q154-B`：corpus-local total order、allocationHash membership freeze、rank-depth zipper、finalOrderHash。

Discovery-wide **exploration seat** 与 graph **expansion** 正交：前者是从低曝光/高不确定 candidates 中做 seeded selection，后者是从已知 card 沿 provenance/similarity/interaction/skill lineage 边发现邻居。Expansion 不能创造第 13 席，也不能把 prior升级为candidate。

## 现有实现

### Coforge exploration lifecycle

`memory-exploration.server.ts` 与 `/api/agent/v1/memory` 当前暴露：

```text
start | explore | redirect | close | offer
```

- `start`：designated Memory Agent fence；`startKey`幂等；trigram seeds；TTL 10分钟；默认4步/10结果，硬上限8步/30结果。
- `explore`：anchor必须由同一session served；每步operationId + request hash；one-hop neighborhood；默认limit 5、hard limit 20；step effect与operation ledger同事务提交。
- `redirect`：换query重新调用semantic seed search；这会在统一设计中形成第二个search入口。
- `close`：只允许引用本session served citations并保存summary，但旧citation未经过新的central use-class/Q153/Q154/envelope grounding。
- `offer`：验证Memory Agent、channel/member、cooldown、insight存在与skill active/current，却允许调用者直接给targets，不验证任何frozen envelope membership。

### Expansion engine

`memory-expansion.server.ts` 支持：

```text
similar
interactions
  episode ↔ shared-participant episodes
episodeInsight
  episode ↔ insight provenance
skillGrounding
  episode/insight ↔ active skill
skillLineage
  skill ↔ same-lineage revisions
```

当前多条SQL无`ORDER BY`；rows按数据库返回顺序进入`collected`，先到路径决定保留项；similar也只有score DESC而无identity tie-break。`ExpansionNode`没有snapshot、ACL/status proof、path key、corpus-local rank或audit ref。Workspace filter不足以替代统一逐对象principal/ACL/current-status recheck。

### Hint/Offer缺口

OpenViking当前`HintComposer`仍可只消费revisions/free-form sources，Coforge `publishMemoryOffer`也只验证targets known/active。二者都没有证明source来自completed frozen envelope真正served的candidate，必须按Q146-B收口。

## 不重开的约束

1. 自由文本semantic search只有`retrieve(SearchPlan)`一个公共入口；`redirect`不能保留为隐藏search。
2. Expansion是同一role-scoped retrieval深模块上的bounded traversal，不是第二semantic search。
3. Expanded objects重新经过ACL、withdrawal/current-status、central use-class、Q153 allocation与Q154 zipper。
4. Episode/projection/fact仍是prior；沿边到达不升级trust。
5. 每个expansion response仍受candidate≤8、prior≤4、每corpus floor/ceiling、same-class-only backfill、fact pause hole和总cap 12约束。
6. Expanded card不能尾插到已冻结array；同native object多路径到达在allocation前dedup。
7. Terminated operation的intermediate hits永不公开。
8. 只有completed envelope真正served的candidates可驱动Hint/Offer。
9. Parent/child budget、deadline、cancel、snapshot和principal绑定由服务端签发与验证。
10. 后续expansion不能原地修改parent envelope。

## 备选方案

### Option A：Inline Pre-allocation Expansion

#### 机制

Initial discovery在direct typed adapters后、classification/allocation前自动做一轮expansion：

```text
direct native cards
→ deterministic automatic anchors
→ fixed one-hop relations
→ ACL/status/use-class
→ dedup/local order
→ Q153 allocation
→ Q154 zipper
→ one envelope
```

为避免循环，pre-allocation anchor固定为每个有direct eligible cards的Coforge corpus local-rank1，最多3个；relation集合由versioned policy固定。Expansion是discovery lane required stage，与direct search共享child lease和absolute deadline。任何required expansion dependency失败会使整个discovery terminated，按Q146不公开direct或expanded intermediate hits。

#### 优点

- 一次retrieve即可发现一跳neighbors；
- consumer只处理一个envelope；
- direct与expanded cards一起dedup/allocation/order；
- Hint只需一个source envelope；
- 无额外agent round trip。

#### 权衡

- Agent不能看E0后选择anchor/relation；
- 每次retrieve都增加DB fan-out、延迟和成本；
- direct已足够时仍付扩展成本；
- expansion失败会让可用direct hits一起消失；
- automatic anchor/relation policy强烈影响membership；
- 多anchor/relation增加path audit和candidate pool；
- expansion抢同一child budget；
- 当前graph read没有统一snapshot语义；
- 为隔离relation failure可能被迫在lane内再造partial sub-lanes。

#### 后果

A 将可选探索变成initial recall算法的必经依赖；现有agent-directed `explore`失去意义，failure blast radius最大。

### Option B：Post-envelope Served-anchor Derived Operation

#### Initial retrieve

```text
retrieve(SearchPlan)
→ direct typed corpus cards
→ ACL/status/use-class
→ Q153 allocation
→ Q154 zipper
→ frozen RetrievalEnvelope E0
```

Initial retrieve不自动graph expansion。

#### Derived expansion

Memory Agent看到E0后，按需调用同一retrieval深模块的bounded traversal：

```text
expand(ExpansionPlanV1)
→ verify anchor served in parent envelope
→ issue child snapshot/budget/deadline
→ one public relation, one hop
→ native expansion
→ ACL/status/use-class
→ path/identity dedup + corpus-local total order
→ Q153 allocation
→ Q154 zipper
→ frozen derived RetrievalEnvelope E1
```

`expand`没有自由文本query，也不能redirect，因此不是第二semantic search。

#### ExpansionPlanV1

Public input：

```text
schemaVersion
operationId
parentEnvelopeRef
anchorCardRef
relation: similar | related | collaborators | skills
requestedLimit?: 1..12
expansionChainRef
```

Agent不能自报workspace、principal、ACL、snapshot、deadline或budget。服务端解析parent plan/final order、scope/principal binding，并签发child snapshot、child budget lease、absolute deadline和cancel signal。

#### Served-anchor fence

服务端验证：

1. Parent envelope存在、冻结并属于同一bound principal/task lineage；
2. Parent discovery/expansion operation completed；
3. Anchor确实在parent candidate或prior public array；
4. Anchor当前仍可见且未withdrawn/retired/superseded；
5. Anchor kind支持请求relation；
6. Chain未过TTL/step/result限制。

Invisible、withdrawn与missing anchor使用同一稳定错误。Prior允许作为anchor，例如episode prior沿skillGrounding发现active skill candidate；prior本身不升级。

#### Snapshot

E0只证明anchor当时served。Expansion dispatch时签发`childExpansionSnapshotRef`，绑定parentEnvelopeRef、anchorCardRef、parent scope/principal与native graph watermarks。E1使用自己的snapshotRef；planHash覆盖parent finalOrderHash、anchor、relation、requestedLimit、child snapshot与policy versions。Serving前仍重验current ACL/withdrawal/status。Duplicate replay返回冻结E1，不用新图现场重算。

#### One relation / one hop

一次ExpansionPlan只允许一个public relation和one hop。多hop只能用E1已served card作为新operation的anchor。这样failure、budget和path proof局部化。

`skills`内部映射的native priority固定并版本化为：

```text
skillGrounding → skillLineage
```

首版将这两个native edge classes视为同一public relation的required ordered components；任一required dependency失败则E1 terminated且无partial public hits。

#### Chain limits

迁移现有成熟边界：

```text
chain TTL: 10 minutes
default max steps: 4
hard max steps: 8
cumulative unique served: 30
per-operation requestedLimit: 1..12
Q153 candidate/prior caps: 8/4
fact paused maximum: 11
```

每个expand有独立child lease/deadline/cancel，并计入同一task/orchestrator parent budget。Initial operation的unused child budget不转给expansion。E1 timeout只终止E1，不修改E0。

#### Expansion local order

Expanded object回到原kind corpus queue。首版path/local key：

```text
hopDepth
relationOrdinal
anchorPublicRank
nativeRelationSubtypeOrdinal
nativeTargetRankOrScore DESC
canonicalPathRef
canonicalTargetRef
```

具体：

- similar：trigram score DESC + target ID ASC；
- related：episodeInsight path ref + target kind + target ID；
- collaborators：canonical participant identity + source episode/event range + target episode ID；
- skills：skillGrounding先于skillLineage，各自path ref + target ID；
- 同target多路径保留最佳key，其他path proofs有界排序合并；
- snippets与DB row order不参与tie-break；
- mapping进入`expansionOrderPolicyVersion`。

之后执行Q153/Q154，不能append。

#### Derived envelope与Hint

E1使用RetrievalEnvelope的typed arrays与最小public metadata：

```text
currentEvidenceRefs = []
memoryCandidateCards = expanded selected candidates
analogicalPriorCards = expanded selected priors
current_log_exact = not_dispatched
memory_discovery = completed | terminated
```

Parent/anchor/relation/path proof放受控auditRef。E1有独立operationId、planHash、snapshotRef、allocationHash、finalOrderHash和envelopeRef。

只有E1 memory_discovery completed且card实际served时，expanded candidate才能驱动Hint/Offer。Hint provenance绑定E1、operation/plan/lane/final order hashes与served source refs；服务端受控derivation proof另绑定E0、anchor和relation/path。E0 prior anchor不是Hint source，E1 candidate才可成为source。Traversal exposure不计citation/utility。

#### API迁移

```text
start
  → retrieve(SearchPlan) + 可选签发 expansionChainRef

explore
  → expand(ExpansionPlanV1)
  → 保留Memory Agent fence、operation hash、served-anchor纪律

redirect
  → 删除exploration子命令
  → 新query必须新retrieve(SearchPlan)

close
  → 降为MemoryTaskState/chain checkpoint
  → 可总结chain served refs，但不拥有citation/Hint authority

offer
  → 强制绑定completed E0/E1
  → targets必须是指定envelope真正served的candidates
```

OpenViking Hint composer同样改为消费envelope provenance，不再只凭revision/free-form source。

#### 优点

- Initial retrieve低延迟、少依赖；
- Agent可先看E0再选anchor/relation；
- Expansion failure不丢E0 direct results；
- Parent不可变，E1独立snapshot/hash/replay；
- 复用现有served-anchor、operation hash、TTL、step/result budget；
- Redirect收口到唯一retrieve；
- One relation/one hop局部化failure和audit；
- E1完整复用use-class/allocation/zipper；
- Prior可导航到candidate但不升级；
- Expanded Hint source有真实served envelope证明；
- 不让每次retrieve都支付graph fan-out。

#### 权衡

- 增加agent round trip；
- 新增ExpansionPlan、chain capability与derived audit；
- Parent/child snapshot不同，必须理解derivation；
- 多hop需多operation；
- Chain与per-operation caps共同存在；
- E1仍可能underfill；
- Hint composer与offer API需要迁移；
- Close summary不再具有citation authority；
- 必须持久化terminal result以支持图变化后的duplicate replay。

#### 后果

B将initial semantic recall与agent-directed graph traversal拆成两个不可变操作，保持唯一search入口、缩小failure blast radius，并让expanded candidates通过自己的completed envelope获得Hint资格。

### Option C：Hybrid Micro-expansion + Post-envelope Expansion

#### 机制

Initial retrieve先对每个Coforge corpus local-rank1做固定one-hop micro-expansion，再执行Q153/Q154形成E0；之后仍允许按B做served-anchor E1。Micro expansion有独立内部budget slice。

#### 优点

- E0可能直接包含有价值neighbor；
- 同时保留agent-directed探索；
- 常见一跳模式可减少round trip；
- direct与provenance都影响初始recall。

#### 权衡

- 自动/显式两套expansion生命周期；
- optional micro failure若仍标completed，会制造lane内部partial语义；
- required micro failure则回到A的blast radius；
- 同一neighbor可能在E0/E1重复曝光；
- budget、propensity和audit难解释；
- automatic relation影响membership，interactive relation又形成第二套选择；
- 测试矩阵最大；
- 没有证据证明micro收益；
- “micro”范围容易持续膨胀并退化成A。

#### 后果

C同时承担A/B状态空间，并要求新增“completed但内部策略未完成”的含混语义，削弱LaneAudit清晰度。

## 场景

### Episode prior导航到skill

E0只命中episode E1 prior，图上有`E1 → skillGrounding → S9(active)`：

- A：只有E1被automatic seed policy选中时，S9才进入E0；
- B：E0先served E1；Memory Agent以E1和`skills`发expand；E1-derived envelope真正served S9 candidate后，S9可驱动Hint；
- C：micro可能先把S9带入E0，explicit expansion再次遇到它，需跨envelope解释重复曝光。

### Expansion DB超时

- A：整个discovery terminated，direct hits也不公开；
- B：E0继续有效，E1 terminated且无partial；
- C：必须新增optional degradation或承受A的结果。

### Anchor随后被withdraw

- B在expand时current-status recheck失败，以missing/invisible等价错误拒绝，不读取neighbors；E0仍是历史冻结结果，但不能作为活能力继续使用。

### 换semantic query

所有方案都要求新`retrieve(SearchPlan)`；不得调用redirect。

## 决定

采用 **Option B**：

```text
memory-expansion-placement/Q155-B
```

接受的完整合同：

1. Initial `retrieve(SearchPlan)`只做direct typed-corpus discovery，不自动graph expansion；
2. Expansion是同一retrieval深模块的`expand(ExpansionPlanV1)` bounded traversal，不是第二semantic search；
3. Input包含operationId、parentEnvelopeRef、anchorCardRef、一个public relation、requestedLimit 1..12与expansionChainRef；
4. Parent必须completed/frozen，anchor必须真正served并在expand时通过current ACL/status/withdrawal recheck；
5. Prior可作anchor但不升级；只有derived envelope served candidate可驱动Hint；
6. 每operation one relation/one hop，多hop必须用新served result发新operation；
7. Dispatch时签发独立child expansion snapshot/budget/deadline/cancel，绑定parent/anchor/principal/native watermarks；
8. E1失败/取消不修改E0；terminated E1无partial public hits；
9. Chain TTL 10分钟、default 4步、hard 8步、累计unique served 30；单operation public cap 12且继续受Q153 8/4与fact pause限制；
10. Expanded objects回到原kind corpus，按versioned path/local total order dedup，再执行Q153 allocation与Q154 zipper；
11. E1是独立frozen derived RetrievalEnvelope，拥有自己的operationId、planHash、snapshotRef、allocationHash、finalOrderHash和auditRef；
12. Duplicate replay返回冻结E1，不能用当前graph现场重算；
13. `redirect`删除，换query必须新retrieve；
14. `close`降为chain checkpoint/MemoryTaskState摘要，不拥有citation authority；
15. `offer`和OpenViking Hint composer必须验证指定completed E0/E1的served candidate membership；仅known/active或free-form source不够；
16. Traversal exposure不计citation/utility。

## 拒绝其他方案

拒绝A，因为它把可选graph dependency变成initial retrieve required stage；一处expansion失败会按Q146让可用direct results一起消失，且agent不能基于E0选择anchor/relation。

拒绝C，因为optional micro-expansion需要含混的lane内部partial completion，required micro又退化成A；同时存在自动/显式两套扩展还会增加重复曝光、budget和audit状态，没有当前收益证据支撑。

## Audit

受控`ExpansionAuditV1`至少包含：

```text
operationId
expansionPlanHash
parentEnvelopeRef
parentPlanHash
parentFinalOrderHash
anchorCardRef
anchorPublicRank
anchorUseClass
relation
relationPolicyVersion
childExpansionSnapshotRef
expansionOrderPolicyVersion
childBudgetAuditRef
chainRef
chainStep
cumulativeUniqueServed
nativePathAuditRefs[]
dedupAuditRef
allocationHash
finalOrderHash
terminalReason
```

Public envelope继续遵守Q138最小metadata，不公开parent ACL、hidden edge/eligible counts、budget余额或adapter timeline。Parent/anchor linkage由服务端经auditRef验证。

## 后果

### 正向

- Corpus/exact adapter分支的initial recall、allocation、ordering与expansion生命周期闭合；
- 唯一semantic search入口不变；
- Parent envelope不可变；
- Expansion failure隔离；
- Existing served-anchor/idempotency/chain治理可迁移；
- Expanded candidates合法接入served-only Hint/Offer grounding。

### 成本

- 需要实现ExpansionPlan与derived envelope；
- Coforge expansion SQL必须补deterministic path/identity order与逐对象ACL/status；
- 现有exploration API要迁移，redirect要删除；
- Offer/Hint composer要强制envelope membership；
- Chain snapshot、budget、terminal replay与path audit需要持久化；
- 多hop增加round trips。

## Frontier 扫描结果

Q155 是 corpus onboarding、exact adapter、allocation、interleave 与 expansion placement 分支的最后节点；该分支已闭合。

随后对 37 个 ADR、`CONTEXT.md` 与 `CONSENSUS.md` 的显式 pending/blocked 标记做了机械扫描。ADR 中没有剩余等待用户拍板的状态；命中的旧前向引用均已改写为对应后续稳定键。扫描相关 Memory/AIG 源码后，发现两个独立、既存且仍以 `pending-v0` 标记的 policy seams：

```text
memory-hybrid-fusion/Q156
  OpenViking retrieval_facade.py:
  HYBRID_FUSION_POLICY_VERSION = "hybrid-fusion-pending-v0"

diagnostic-subgraph-text/Q157
  OpenViking retrieval_facade.py:
  SUBGRAPH_TEXT_POLICY_VERSION = "subgraph-text-pending-v0"
```

对 `impl/pending-design-decisions.md` 原 1–20 项的逐条对账另确认：13项已由后续共识闭合；#9/#12/#16 是已定政策下的实现 backlog；#17/#20 是集成成本或可选评测观察；只有原#1对应Q156。完整分类表已追加在该文件的“2026-10-08 全量对账结果”中，以上 backlog 不得重新包装为用户设计问题。

因此整个 Memory/AIG/skill design tree 的 frontier 尚不为空，不能宣称已达到 shared understanding。按一次一个、依赖顺序推进的约定，先处理 Q156；Q157 等 Q156 后再单独展开。
