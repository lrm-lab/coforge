# Corpus Onboarding 与 Exact Adapter 设计决策

**Decision keys:** `memory-corpus-topology/Q147-B`、`memory-use-class-policy/Q148-B`、`memory-exact-content/Q149-A`、`memory-exact-snapshot/Q150-A`、`memory-exact-regex/Q151-A`、`memory-exact-ref/Q152-B`
**Status:** `accepted`
**Decision:** `Q147=B / Q148=B / Q149=A / Q150=A / Q151=A / Q152=B`
**Source record:** `/tmp/kiro_b7.log` 的 final branch section；用户于后续设计轮明确接受全部六项选择
**Scope:** 记录 memory-discovery corpus onboarding 与 current-log exact adapter 的已接受设计；本 ADR 不实现代码

本 ADR 固定统一检索最后一个内部实现分支：一方面，将 OpenViking 与 Coforge 的九类记忆对象通过 typed corpus adapters 接入同一个 `memory_discovery` lane，并由 outer coordinator 独占 classification 与 public selection；另一方面，为 `current_log_exact` 固定基于冻结范围、权威内容、ACL、撤回状态、RE2-compatible matcher 与确定性引用的 exact-search adapter。六项决定均已由用户明确接受；完整 A/B/C 历史保留在下文，用于解释为什么拒绝 provider-level double pruning、物理统一索引、ledger-only exact、God module、host backtracking regex 与 unbounded match spans。

## 分支目的

统一 `retrieve(SearchPlan)` 的外层接口、双 lane、确定性触发、lane-local 结果上限、父预算、deadline、cancellation、partial failure 和 Memory Hint/Offer grounding 已经由前序 ADR 固定。本分支不重开这些外层契约，只补齐两个内部设计面。

第一个设计面是 **memory-discovery corpus onboarding**。同一个 `memory_discovery` lane 最终需要消费以下九类对象：

```text
OpenViking
  fork
  branch
  block_projection
  claim_projection
  segment
  atom

Coforge
  episode
  insight
  skill_revision
```

这里必须决定：adapter 是按来源系统封装还是按 corpus 拆分；native identity、status、score 与 audit 如何穿过统一层而不丢失；九类对象在中央 use-class policy 中怎样映射为 `memory_candidate`、`analogical_prior` 或 `excluded`；以及 Coforge 当前的 workspace fence 如何收紧为逐对象 principal/ACL/status recheck。目标不是把两个系统物理合并，也不是让 adapter 自行声明更高 trust，而是确定统一 discovery 深模块的职责边界。

第二个设计面是 **AO current-log exact-search adapter**。目标处理链为：

```text
SearchPlan.query.exact
→ pinned multi-session snapshot
→ authority-resolved searchable fields
→ literal/regex matcher
→ ACL/withdrawal-before-cap
→ AO/field coalescing
→ deterministic CurrentEvidenceRefs
```

这里必须决定：exact 搜索哪一种内容表示；跨 session 的 snapshot 与 resolver seam 放在哪里；regex 采用什么安全 dialect；以及同一 AO/field 内的多个 occurrence 如何压入一个有界、可验证的 `CurrentEvidenceRef`。

本分支的输出是六项已接受决定及其完整设计空间。Q147-B/Q148-B 已解锁 cross-corpus 12-slot allocation、最终 deterministic interleave/ranking 与 Coforge expansion placement；这些后续问题仍须在下一轮逐项决定，本 ADR 不提前替用户选择。

## 现有实现与文件地图

### 设计基线

- `skill-node-design-grill/docs/adr/0028-pending-t-log-search-and-mixed-retrieval-entry.md`
  - 固定一个公共 `retrieve(SearchPlan)` 入口；
  - 固定 `current_log_exact` 与 `memory_discovery` 两条 typed lane；
  - 禁止建立跨 lane 的统一 score、global rank 或共享 TopK。
- `skill-node-design-grill/docs/adr/0029-pending-memory-search-schema.md`
  - 固定服务端签发并重新验证的 opaque `scopeRef`、`snapshotRef`、`budgetLeaseRef`；
  - 固定 typed exact clause 与 semantic intent；
  - 固定中央、版本化 use-class classifier；
  - 固定 typed `RetrievalEnvelope` 与正交 `LaneAudit`。
- `skill-node-design-grill/docs/adr/0030-exact-lane-clause-presence-trigger.md`
  - typed exact clause 存在即 dispatch exact lane；
  - semantic input 存在即 dispatch discovery lane；
  - regex 文本不会被隐式改写为 semantic query。
- `skill-node-design-grill/docs/adr/0031-exact-hit-limit-and-independent-lane-quotas.md`
  - exact public hard ceiling 为 20，调用方只能请求 1..20 的下调值；
  - discovery public cap 为 12；
  - 两条 lane 不借位、不 backfill；
  - exact 命中在 ACL/withdrawal 后按 `(sourceSessionRef, aoId, matchedField)` 合并并确定性排序。
- `skill-node-design-grill/docs/adr/0032-parent-budget-deadline-and-cancellation-tree.md`
  - 固定父预算、child deadline、取消树和 sibling 隔离。
- `skill-node-design-grill/docs/adr/0033-pending-partial-failure-and-memory-hint.md`
  - 文件名保留 `pending`，但正文已接受 Q146 的 Option B；
  - terminated lane 的 intermediate hits 不进入 public arrays；
  - 只有 completed discovery 的 public candidates 可以驱动 Hint/Offer；
  - Hint/Offer source 必须来自冻结 envelope 真正 served 的 cards。
- `skill-node-design-grill/CONTEXT.md`
  - 定义 lane、exact public hit、coalescing 等领域术语。
- `skill-node-design-grill/CONSENSUS.md`
  - 保存已定外层检索与 Hint grounding 共识。

### OpenViking memory-discovery

主要文件：

```text
OpenViking/openviking/session/retrieval_facade.py
OpenViking/openviking/session/influence_projection.py
```

`retrieval_facade.py` 已有三组 typed storage/search adapter：

1. `ForkBranchAdapter`
   - 只读取 latest ForkRevision；
   - validated revision 进入 verified channel；
   - provisional revision 进入 provisional channel；
   - draft/invalidated revision 不进入 retrieval；
   - fork identity 保留 node 与 revision，branch identity 额外保留 branch ID；
   - workspace label ACL 在排名与 quota 之前过滤。
2. `InfluenceProjectionAdapter`
   - 返回 `block_projection` 与 `claim_projection`；
   - 保留 opaque projection card ID、frozen view revision、entity/session pointer；
   - principal filter 通过 registry 的在线查询路径执行；
   - resolved AO body 只进入 BM25 document，不复制到 public card；
   - supersession 与 withdrawal 仍由原生 registry 生命周期管理。
3. `SegmentAtomAdapter`
   - 以 `(session_id, ao_id)` 为 native identity；
   - 无 ACL label 或 label 与 principal 不相交时 fail closed；
   - 当前 `FACT_LANE_PAUSED=True`，因此默认不召回 segment/atom；
   - 它会自行取得单 session ledger snapshot，不能直接冒充使用 SearchPlan pinned snapshot 的 exact adapter。

`RetrievalCard` 已保留：

```text
kind
channel
in_channel_rank
status_label
source_pointer
payload_ref
score_breakdown
acl_labels
selection_mode
text
```

`HybridRetrievalFacade` 当前还拥有 OpenViking 内部 selection：默认 corpus 配额 6/4/2、verified/provisional 8/4 slotting、seeded exploration、BM25 或 hybrid rank，以及 final cap 12。该 facade 不包含 Coforge 的 episode/insight/skill_revision。如果 outer coordinator 先让它裁到 12，再与 Coforge 结果做第二次裁剪，就会形成双重 cap、双重 allocation 和不可逆的候选损失。

### Coforge group memory

主要文件：

```text
coforge/apps/web/src/server/group-memory/memory-similarity.server.ts
coforge/apps/web/src/server/group-memory/memory-exploration.server.ts
coforge/apps/web/src/server/group-memory/memory-expansion.server.ts
coforge/apps/web/src/server/group-memory/memory-offer.server.ts
coforge/apps/web/src/routes/api/agent/v1/memory.ts
```

`memory-similarity.server.ts` 当前通过一个 SQL union 返回：

```ts
type MemorySeed = {
  kind: "episode" | "insight" | "skill";
  id: string;
  score: number;
  snippet: string;
};
```

现状包括：

- episode 是 immutable raw-memory 对象；
- insight seed 只返回 current head，且 live chain score 必须大于 0；
- skill seed 只返回 active/current revision；
- 三类对象共用 PostgreSQL `word_similarity` 分数；
- SQL 当前只按 `score DESC, kind ASC` 排序，同 score/kind 没有最终 ID tie-break；
- workspace fence 存在，但统一接入后仍需要逐对象 principal、ACL 与 current-status recheck。

`memory-exploration.server.ts` 提供 `start → explore/redirect → close` 生命周期、Memory Agent designation fence、step/result budget、TTL、operation ID 幂等与 served-only citation grounding。seed score 不进入 public citation shape。

`memory-expansion.server.ts` 沿 provenance edge 扩展。`ExpansionNode` 只有 `kind/id/snippet/via`，没有统一 score；多条 SQL 没有 `ORDER BY`，similar 分支也缺少完整 tie-break。结果依赖查询返回顺序与 push 顺序，因此它目前不能直接充当 deterministic cross-adapter final ranker。

`memory-offer.server.ts` 管理下游投递、副作用、sender fence 与 cooldown。它不是只读 retrieval adapter；现有 direct offer input 也没有冻结 envelope 的 served proof，后续必须遵守已定的 served-envelope grounding，但本 ADR 不修改该文件。

### OpenViking AO ledger 与 exact 基础

主要文件：

```text
OpenViking/openviking/session/ao_ledger.py
OpenViking/openviking/session/ao_ledger_reader.py
OpenViking/openviking/session/tool_result_synopsis.py
```

当前 `AORecord` 包含：

```text
ao_id
session_id
sequence
action
observation
skill_invocations
message_ref
created_at
captured_state
```

关键现实约束：

- action 会被 sanitize/truncate，是 canonicalized execution record，不一定等于原始调用字节；
- observation 通常保存 `ToolResultSynopsis`，其中只有 kind/title/summary/structure/notable items/sample，不是完整 raw tool output；
- message 只保留 `message_ref`，正文的权威来源仍是 channel authority；
- `LedgerSnapshot` 一次只冻结一个 session 的 ledger line count、archive IDs 与 issue time；
- `list_ao_ledger()` 支持 pinned watermark 与稳定 cursor，但 listing 本身不是 evidence authorization；
- `get_ao_evidence()` 对单 AO 执行 default-deny source-session ACL；
- reader 的 200 条 page limit 只是内部扫描分页，不是 exact public hit limit；
- 当前没有 multi-session scope manifest、withdrawal/revocation resolver、literal/regex matcher、AO/field coalescer、fragment extractor 或最终 `CurrentEvidenceRef` builder。

生产实现中还没有 `MemoryDiscoveryCoordinator`、`SearchableStepView`、`ScopeSnapshotResolver`、`ExactSearchSlice` 或完整 exact adapter。这些名称在下文只表达设计候选，不描述已经存在的代码。

## 不重开的固定约束

以下边界已由前序决策固定，不属于 Q147–Q152 的选择空间：

1. 公共入口只有一个 `retrieve(SearchPlan)`。OpenViking 与 Coforge 是 `memory_discovery` 的内部 adapter，不新增公共检索工具。
2. `current_log_exact` 与 `memory_discovery` 是独立 typed lanes。它们可以共享 ACL、scope、snapshot、父预算、deadline、cancellation 与 audit，但不共享 score、结果配额、证据语义或 exposure/citation/utility 记账。
3. 合法 typed exact clause 的 presence 确定性触发 exact；semantic input 触发 discovery；exact regex 文本不自动变成 semantic query。
4. exact public hard ceiling 为 20，并允许请求 1..20 下调；discovery public cap 为 12；两条 lane 不借位、不 backfill，也没有 envelope-level global score/rank。
5. exact 处理顺序固定为：scope/snapshot filter → evidence ACL 与 withdrawal/revocation check → 按 `(sourceSessionRef, aoId, matchedField)` coalescing → canonical order → effective public limit。
6. exact canonical order 固定为 scope resolver 的 session/range order，再按 sequence、封闭 field order、first match offset 排序。
7. 不可见命中不消耗 public limit，不公开 filtered count，也不能通过错误差异泄露隐藏对象是否存在。
8. memory card 不能被中央 classifier 升级为 current evidence；exact hit 也不自动产生 citation、adoption 或 utility。
9. use-class 的所有权已经固定在中央、版本化 classifier。Q148 只决定首版 kind/status policy，不得退回 adapter 自报 trust。
10. terminated lane 的 intermediate hits 永不进入 public arrays，固定 `resultState=none` 与 `returnedCount=0`；completed sibling 可以保留自己的已授权结果。
11. 只有 completed `memory_discovery` 的 public `memory_candidate` 可以驱动 Memory Hint/Offer。Exact-only evidence、analogical prior、terminated/unavailable discovery 都不能驱动 Hint。
12. Hint/Offer source 必须来自冻结 RetrievalEnvelope 真正 served 的 candidates，并绑定 envelopeRef、operationId、planHash、completeness、lane audit 与 source card refs。
13. `scopeRef`、`snapshotRef` 与 `budgetLeaseRef` 是服务端 opaque refs。principal、capability、deadline 与 cancel signal 来自 bound context，不由 agent JSON 自报。
14. Native kind、identity、status、source pointer、score breakdown 与 adapter audit 不得在统一层丢失。统一 envelope 不是物理存储迁移。
15. 本 ADR 固定 Q147–Q152 的已接受选择；后续 allocation、interleave/ranking 与 expansion placement 必须以这些选择为前提，不得重建 provider-level selector、放宽 use class、退回 synopsis-only exact、让 matcher 接管 authorization，或绕过安全 regex 与 bounded ref 约束。

## Q147：`memory-corpus-topology/Q147-B` — Memory-discovery Adapter 按 Provider 还是按 Corpus 接入？

**Status:** `accepted`

### 问题背景

`memory_discovery` 必须在一个 public cap=12 的 lane 中消费九类对象。接入拓扑决定谁拥有 native search、初始状态过滤、逐对象 ACL/current-status recheck、use-class classification、12 席 allocation、最终 interleave/order 与 selection audit。

现有 OpenViking facade 已在 provider 内先执行 6/4/2 corpus quota、8/4 verified/provisional slotting、seeded exploration 和 cap 12；Coforge 则用另一套 similarity seed 与后续 exploration/expansion。若简单把两方完整 facade 拼接，outer coordinator 只能看到已被各 provider 预裁剪的列表，无法恢复被丢弃的 corpus candidates。

### 涉及文件

```text
OpenViking/openviking/session/retrieval_facade.py
OpenViking/openviking/session/influence_projection.py
coforge/apps/web/src/server/group-memory/memory-similarity.server.ts
coforge/apps/web/src/server/group-memory/memory-exploration.server.ts
coforge/apps/web/src/server/group-memory/memory-expansion.server.ts
skill-node-design-grill/docs/adr/0029-pending-memory-search-schema.md
skill-node-design-grill/docs/adr/0031-exact-hit-limit-and-independent-lane-quotas.md
```

### Option A：两个 Provider Adapters，保留各自内部 Facade

#### 机制

```text
MemoryDiscoveryCoordinator
├── OpenVikingProviderAdapter
│   └── existing HybridRetrievalFacade
└── CoforgeProviderAdapter
    └── existing similarity/exploration facade
```

OpenViking 先按现有 6/4/2、8/4 与 cap 12 选出 provider-local 列表；Coforge 自行搜索 episode/insight/skill_revision 并形成另一个 provider-local 列表；outer coordinator 最后从两个已裁剪列表中选出 public 12 张 cards。

#### 优点

- 对现有生产代码改动最小；
- 两个系统原有 selection 策略可以完整保留；
- provider seam 清晰，部署、依赖和故障隔离直接；
- OpenViking 当前 seeded exploration 与 paused fact lane 无需立即拆解；
- Coforge 可以继续把三类 seed 放在一个 SQL query 中。

#### 权衡

- 形成 provider-local 与 outer 两层 cap、rank 和 allocation；
- OpenViking 可能在 outer 看见候选前就丢掉更适合全局 12 席的 card；
- outer 无法区分“provider 没有候选”和“provider 内部已裁掉候选”；
- 一个 provider 含六种 kind，另一个含三种 kind，provider 平衡不等于 corpus 公平；
- native score 仍不能直接跨 provider 比较，因此第二层选择必须再定义语义；
- audit 必须同时解释“provider-local 12”与“outer public 12”，认知成本高。

#### 后果

选择 A 后，任何 cross-corpus policy 都只能作用在预裁剪输出上，受到不可逆信息损失约束。未来即使定义精确的 12-slot allocation，也无法保证该 policy 看见每个 corpus 中本应参与竞争的候选。现有 facade 继续拥有部分 public selection 权力，outer coordinator 无法成为唯一 selection owner。

### Option B：Outer Coordinator 拥有 Typed Corpus Adapters

#### 机制

```text
MemoryDiscoveryCoordinator
├── OpenVikingForkBranchAdapter
├── OpenVikingProjectionAdapter
├── OpenVikingSegmentAtomAdapter
├── CoforgeEpisodeAdapter
├── CoforgeInsightAdapter
└── CoforgeSkillRevisionAdapter
```

OpenViking 现有 storage/search adapter 可以复用，但整个 `HybridRetrievalFacade` 不再作为 public discovery 的 provider-level selector。Coforge 当前 SQL union 可以拆为三个 typed adapter，或由一个内部 provider query 返回三个明确命名、尚未做 public allocation 的列表。

每个 adapter 只输出统一的 `NativeMemoryCard`，并保留：native identity/status、principal-visible candidate、native rank/score、source pointer、feature version 与 native audit ref。中央 coordinator 独占以下处理链：

```text
native adapters
→ per-object status/ACL recheck
→ central versioned use-class policy
→ excluded removal
→ discovery-local allocation/interleave
→ cap 12
→ public buckets + LaneAudit
```

#### 优点

- outer 在最终裁剪前能够看见每个 named corpus 的候选；
- use-class、allocation、tie-break 与 final ordering 具有单一所有者；
- native score 可以保留为来源内信息，无需伪装成跨 provider 的共同尺度；
- 每种 kind/status/source pointer 能完整保留；
- Coforge 可在统一 admission 点执行逐对象 principal、ACL 与 current-head/current-revision recheck；
- 新 corpus 有真实 typed seam，不必修改其他 provider 的内部 facade；
- 统一 selection audit 能解释候选如何从 adapter 输出进入最终 12 席。

#### 权衡

- Coforge 的 SQL union 需要暴露三个 named corpus 的候选边界；
- OpenViking 现有 6/4/2、8/4 与 seeded selection 需要下沉为可复用 policy，或由 outer coordinator 重新实现；
- 迁移与等价性测试范围较大；
- adapter 数量增加，coordinator 的内部 interface 需要严格控制；
- 必须避免 old facade 与 new coordinator 同时裁剪；
- outer 仍需另行定义跨 corpus 12-slot allocation 与 deterministic interleave，B 本身不提前回答这两个问题。

#### 后果

选择 B 后，现有 `HybridRetrievalFacade` 成为 legacy/internal compatibility path；新的 public `memory_discovery` 由 coordinator 单独拥有 selection。原始对象和 storage identity 不迁移，只转换为统一 card envelope。Q147 拍板后才可继续决定 12 席的 corpus/use-class 分配。

### Option C：物理合并为单一 Cross-system Index

#### 机制

将九类对象复制或投影到一个共享 table、full-text index 或 vector collection；统一查询、统一 score，并直接取 Top12。原来源系统继续写入权威对象，统一 index 通过 outbox、CDC 或定时重建追赶。

#### 优点

- 查询路径表面上只有一次；
- 排序、分页与缓存接口看起来统一；
- embedding 与索引基础设施可以复用；
- 大规模查询可能减少运行时跨系统 fan-out。

#### 权衡

- 派生投影会掩盖原生 identity 与生命周期；
- ACL、supersession、retirement、invalidated、withdrawal 与 deletion 的同步复杂；
- index lag 可能让已撤回对象继续返回，或漏掉新 active revision；
- 单一 score 混淆不同 corpus 的语义与质量门；
- raw/derived memory 被复制，形成双权威风险和更大的敏感数据面；
- index 更新故障会同时影响所有 memory kinds；
- 必须建设 outbox、rebuild、consistency repair、tombstone 与 stale-read audit。

#### 后果

选择 C 后，统一 interface 被物理数据同步架构耦合。系统必须先解决跨系统一致性与撤回传播，才能声称结果来自当前权威状态；中央 use-class 与 native audit 仍不能省略。该方案的基础设施成本远高于 adapter onboarding。

### 具体示例

查询产生：

```text
OpenViking: 6 fork/branch, 4 projection, 2 segment/atom
Coforge:    3 skill_revision, 5 insight, 8 episode
```

- **A**：OpenViking 先裁到自己的 12，Coforge 也先裁；outer 只能从两份预裁列表再选 12，无法恢复任一 provider 内已丢弃的候选。
- **B**：outer 收到六个 named adapter 的候选与 native rank，在逐对象 recheck 和 Q148 分类后只执行一次 public allocation/cap。
- **C**：18+ 个对象先复制到共同 index，再按共同 score Top12；若某 insight 已退休但 tombstone 尚未同步，仍可能被错误返回。

### 术语解释

- **Provider adapter**：包住整个来源系统或现有 facade 的适配层。
- **Corpus adapter**：围绕一类具有独立 native identity、status 与 search 语义的对象族建立的适配层。
- **Typed adapter**：输出明确 kind 与原生元数据，而不是无类型结果列表的 seam。
- **Pre-truncation**：候选抵达 outer coordinator 前已被上游 limit 截断。
- **Double pruning**：provider 与 outer 各裁剪一次，造成两层信息损失。
- **NativeMemoryCard**：统一层消费的 card envelope；它归一外形，但保留 native identity、status、source pointer、score 与 audit。
- **Cross-system index**：复制多个权威源数据而形成的派生统一索引。

### 决定

**决定采用 Q147=B。** Typed corpus adapters 让 outer coordinator 在 public cap 前看到各 corpus 候选，并集中拥有 classification、allocation、tie-break 与 audit，同时不迁移原生 storage identity。这是用户明确确认的选择；Q147 状态为 `accepted`。

## Q148：`memory-use-class-policy/Q148-B` — 九类对象如何映射为 Candidate、Prior 与 Excluded？

**Status:** `accepted`

### 问题背景

中央、版本化 use-class classifier 的所有权已经固定；本题在作答前需要选择首版 kind×status policy，现已由 `memory-use-class-policy/Q148-B` 固定为 balanced policy。输入可以包含：kind、native status、same-task/cross-task relation、evidence status、synthetic、executable、offer eligibility 与 provenance completeness；输出只能是：

```text
memory_candidate
analogical_prior
excluded
```

Classifier 不能产生 `current_evidence`，adapter 无权自我提升 trust，关键 status/provenance 缺失时必须 fail closed。Q148 要决定首版 policy 在 recall、cold-start、可行动性与安全性之间的严格程度。

### 涉及文件

```text
skill-node-design-grill/docs/adr/0029-pending-memory-search-schema.md
skill-node-design-grill/docs/adr/0033-pending-partial-failure-and-memory-hint.md
OpenViking/openviking/session/retrieval_facade.py
OpenViking/openviking/session/memory_hints.py
coforge/apps/web/src/server/group-memory/memory-similarity.server.ts
coforge/apps/web/src/server/group-memory/memory-offer.server.ts
```

### Option A：Conservative — 成熟行动资产优先

#### 机制

只有成熟、当前有效且具有明确行动语义的资产进入 `memory_candidate`。典型 candidate 包括 active/current skill revision，以及已完成验证、provenance 完整的 validated fork/branch。Active insight、provisional fork/branch、projection、episode、segment/atom 等都降为 `analogical_prior`；invalidated、retired、superseded、ACL-denied、withdrawn 或 provenance 缺失且无法安全降级的对象进入 `excluded`。

Public admission 与 Hint/Offer 生成时都重新检查 current status。即使 adapter 返回 candidate-like channel，中央 classifier 仍可降级或排除。

#### 优点

- Hint/Offer source 范围最窄，直接行动风险最低；
- 成熟资产与导航/经历对象边界清楚；
- policy matrix 和审计较容易解释；
- provisional 错误不会直接驱动投递；
- consumer 不需要处理过多来源种类和 warning。

#### 权衡

- 冷启动与长尾 recall 较弱；
- 现有 provisional ForkCandidate 的行动价值被降级；
- active insight 即使质量较高也只能作为 prior；
- candidate 稀疏时，completed discovery 可能无法生成 Hint；
- 需要明确“成熟”的跨系统等价条件，validated fork 与 active skill 并非天然同一质量尺度。

#### 后果

选择 A 后，Hint/Offer 主要由 active skill revision 与 validated causal asset 驱动。探索性或尚未验证的对象只能帮助后续核验，不能直接成为投递 source。系统将偏向 precision，并接受较低的 early-stage coverage。

### Option B：Balanced — 状态敏感的平衡策略

#### 机制

首版 candidate 包括：

- active/current skill revision；
- active 且仍为 current head 的 insight；
- validated fork/branch；
- visible provisional fork/branch，但必须携带机器可见的 provisional warning。

首版 prior 包括：

- block/claim projection；
- observed episode；
- segment/atom；
- 其他主要用于导航、历史类比或进一步核验的对象。

Invalidated、retired、superseded、ACL-denied、withdrawn 对象进入 `excluded`。关键 status 或 provenance 缺失时 fail closed。Public admission 和 Hint/Offer 生成均重验 source current status，避免检索后状态变化让旧 card 继续驱动投递。

#### 优点

- 与现有 ForkCandidate、active insight 和 active skill 能力兼容；
- 保留 cold-start 与探索能力；
- 将导航/原始经历与可行动候选分开；
- provisional 风险可以由机器读取，而不是只藏在自然语言中；
- projection/episode 不会直接冒充行动建议；
- Q146 的 Hint source union 清晰，可限制为 served skill/insight/fork/branch candidates。

#### 权衡

- provisional fork 可能错误，需要后续 target disposition 与 outcome 纠正；
- active insight 的质量门弱于 validated fork；
- classifier matrix 比 A 更复杂；
- Coforge adapter 必须证明 insight current-head/score 状态和 skill current revision；
- 需要 policy-versioned tests 覆盖 kind×status×provenance 组合；
- OpenViking `HintSource` 若不能表达 insight，需要由后续统一 Hint source union 或 Coforge-specific source type 承载，但仍必须遵守 served-envelope grounding。

#### 后果

选择 B 后，统一 retrieval 保留探索能力，同时把较弱对象限制在 prior。Provisional candidate 可以进入 Hint source 集合，但必须保留 warning 与 native status，且在投递前再次重验。Policy 变化通过版本升级与 audit 表达，不覆写原始对象。

### Option C：Expansive — 除明确无效外都可成为 Candidate

#### 机制

Episode、projection、segment/atom、active insight、active skill 以及所有 visible provisional object 都进入 `memory_candidate`。只有 invalidated、retired、superseded、ACL-denied 或 withdrawn 对象被排除；`analogical_prior` 仅用于极少数明确标记为 historical-only 的对象。

#### 优点

- candidate coverage 最高；
- cold-start 和长尾任务最容易得到可消费结果；
- 表面规则简单，新 kind 默认容易接入；
- 更多对象可能驱动 Hint/Offer，短期看召回率高。

#### 权衡

- 导航卡、原始事实、历史经历与行动建议混为一类；
- episode/projection 可能直接驱动不恰当行动；
- consumer 必须自行理解更多 kind 与限制；
- 中央 use-class 的信任区分价值被削弱；
- Hint/Offer source 过宽，解释、审计与安全验证困难；
- 原始内容中的相关性不等于可行动性，模型容易把“发生过”误读成“应当做”。

#### 后果

选择 C 后，Hint schema 与 downstream evaluator 必须支持更多 source kinds，并承担更重的适用性判断。Public candidate 不再传达较强的行动资格，调用方会重新依赖 kind/status 细节，削弱统一 use-class 的深模块价值。

### 具体示例

一次 discovery 命中：

```text
active skill_revision
active current-head insight
provisional fork
claim_projection
observed episode
```

- **A**：只有 active skill_revision 是 candidate；其余为 prior。若另有 validated fork，它可进入 candidate。
- **B**：skill_revision、insight 与 provisional fork 是 candidates；fork 带 provisional warning；projection 与 episode 是 priors。
- **C**：五者全部是 candidates，都可能进入 Hint source pool。

若 provisional fork 随后变为 invalidated，三种方案都必须在 public admission 或 Hint 生成的 current-status recheck 中排除它，而不是依赖旧检索结果继续投递。

### 术语解释

- **Use class**：对象在当前 response 中被允许怎样使用，不等同于对象的永久类型。
- **Memory candidate**：可继续作为 Hint/Offer 或执行候选评估的对象；不表示自动采用或执行。
- **Analogical prior**：只能启发进一步核验的历史/导航对象，不能直接驱动行动投递。
- **Excluded**：不进入 public response 的对象；为防侧信道，也不公开排除数量。
- **Current head**：版本链当前生效、尚未被 supersede 的 revision。
- **Provisional warning**：明确表示对象尚未完成因果验证的机器可见标记。
- **Navigation object**：帮助找到机制或证据位置、但本身不是行动建议的对象。
- **Fail closed**：状态、ACL 或 provenance 不足时不猜测升级，而是降为 prior 或排除。

### 决定

**决定采用 Q148=B。** 平衡策略延续 active skill、active insight 与 provisional ForkCandidate 的现有价值，同时把 projection、episode 与 facts 留在 prior 层，并保留机器可见的 provisional 风险。这是用户明确确认的选择；Q148 状态为 `accepted`。

## Q149：`memory-exact-content/Q149-A` — Exact Lane 搜索哪一种 Step Content Representation？

**Status:** `accepted`

### 问题背景

AO ledger 不是完整 raw log：action 是 sanitized canonical structure，observation 通常是 deterministic synopsis，message 只有 `message_ref`。只搜索 ledger JSON 会漏掉 raw tool error 与 message body；直接扫描所有 raw archive/channel storage 又可能绕过 pinned snapshot、ACL、withdrawal 与权威来源边界。

因此，Q149 要定义“exact”究竟对什么内容表示成立。该选择会影响无命中的含义、content hash、offset、可重放性与 resolver 责任。

### 涉及文件

```text
OpenViking/openviking/session/ao_ledger.py
OpenViking/openviking/session/ao_ledger_reader.py
OpenViking/openviking/session/tool_result_synopsis.py
skill-node-design-grill/docs/adr/0029-pending-memory-search-schema.md
skill-node-design-grill/docs/adr/0031-exact-hit-limit-and-independent-lane-quotas.md
```

### Option A：Authority-resolved `SearchableStepView`

#### 机制

对 pinned scope 内每个 AO 组装只读字段视图：

```ts
type SearchableStepView = {
  sourceSessionRef: string;
  aoId: string;
  sequence: number;
  fields: {
    action?: AuthoritativeText;
    observation?: AuthoritativeText;
    message?: AuthoritativeText;
  };
};
```

字段语义如下：

- `action`：AO record 中 sanitized、稳定序列化的 canonical action projection；
- `observation`：经 AO/source provenance 在同一 pinned snapshot 下解析的 authoritative raw observation；无法授权或无法解析时省略，不用 synopsis 冒充 raw；
- `message`：经 `message_ref` 在 channel authority 中按 pinned event/snapshot 解析的正文；
- 每个 resolved field 绑定 representation kind、content hash、snapshot identity 与 withdrawal state；
- 用户未指定 fields 时，按封闭顺序 `action → observation → message` 搜索所有可授权字段；
- 字段 unavailable 只进入受控 native audit，不向 public response 泄露隐藏字段数量；
- synopsis 若未来开放，只能作为显式 `representation=synopsis` 模式，不能支持“raw 中不存在该文本”的结论。

#### 优点

- 最接近“搜索真实步骤内容”的 exact 语义；
- 可以命中 raw tool output 与群消息正文；
- message 仍以 channel authority 为唯一权威，不使用 OpenViking 副本冒充主数据；
- 每个字段可绑定 hash、snapshot 与 provenance；
- raw 与 synopsis 的语义不会混淆；
- 字段不可用时 fail closed。

#### 权衡

- 需要 action、observation、message 三类 resolver；
- raw observation provenance 当前不完整，需要补充读取 seam；
- 跨存储读取成本和测试复杂度较高；
- channel snapshot 语义需要明确；
- 某些字段 unavailable 时，exact 结果是不完整的，但 public API 不能泄露隐藏对象数量；
- representation normalization、hash 与 offset policy 必须版本化。

#### 后果

选择 A 后，exact adapter 是 resolver-driven orchestrator，而不是 ledger synopsis scanner。无命中只能表示“在本次已授权、已成功解析并实际搜索的 representations 中无命中”；audit 必须能说明 representation policy 与不可用原因类别。

### Option B：Ledger-only Canonical JSON/Synopsis

#### 机制

只搜索 AORecord 当前可直接读取的内容：canonical action JSON、observation synopsis JSON 与 `message_ref` metadata；不解析 raw observation，也不读取 message body。

#### 优点

- 实现最简单；
- 只依赖单一 ledger snapshot；
- 序列化、性能与重放语义容易固定；
- 无需 channel/raw content resolver；
- 敏感 raw content 不增加新的运行时读取面。

#### 权衡

- 真实错误字符串常只存在于 raw tool result，因而会漏检；
- message body 完全不可搜索；
- 用户容易把“synopsis 无命中”误解为“当前日志无该文本”；
- synopsis generator 的策略变化会改变 exact 结果；
- `message_ref` metadata 命中与 message 正文命中不是同一语义；
- 与 `T_log.search` 的完整 current-log 语义差距较大。

#### 后果

选择 B 后，该能力实际上是 canonical-ledger/synopsis search。接口和文档必须明确限制，不能声称覆盖完整 raw current log；否则“exact”会产生误导性的否定结论。

### Option C：预构建 Unified Full-text Index

#### 机制

在 AO/message 写入或异步处理时，将 canonical action、raw observation 与 message body 投影到统一全文索引，并记录 source identity、representation、snapshot/version、ACL labels、withdrawal/tombstone 与 content hash。Exact lane 查询该索引，而不是实时调用多个 resolver。

#### 优点

- 查询快，适合大 scope；
- 可以复用成熟全文与 regex 索引；
- 减少每次调用的跨存储 fan-out；
- 统一分页、缓存与查询计划较容易；
- 可预计算 normalization 与部分 span 信息。

#### 权衡

- 新增派生敏感数据面；
- ACL、edit、withdrawal、revocation 与 deletion 同步复杂；
- index lag 可能违反 pinned snapshot；
- raw observation/message 被复制，扩大泄露和保留风险；
- 需要 outbox、watermark、rebuild、consistency check、tombstone 与 staleness audit；
- exact 结果取决于 index 是否追上 authority。

#### 后果

选择 C 后，必须定义 index watermark 与 authority snapshot 的一致性关系，以及索引未追平、撤回传播延迟和 rebuild 期间的 failure semantics。Exact adapter 会依赖一套新的基础设施，而不只是内容 resolver。

### 具体示例

Raw tool result 是：

```text
connection refused: ECONNREFUSED 10.0.0.8:5432
```

Ledger synopsis 只有：

```text
tool failed with database error
```

- **A**：经 authoritative raw observation resolver 搜索，命中 `ECONNREFUSED`，ref 绑定 raw representation hash。
- **B**：无命中，因为 synopsis 未保留该字符串；这个结果不能证明 raw output 中不存在它。
- **C**：只有在 index 已同步该 raw observation 且 tombstone/ACL 状态最新时命中；index lag 时可能漏检。

对于 message 中的 `rollback order 417`，A 经 channel authority 命中，B 只能看到 message_ref，C 取决于 message index 同步状态。

### 术语解释

- **Authoritative content**：由原始事实存储持有、可验证来源与当前状态的内容。
- **SearchableStepView**：为 matcher 临时组装的只读步骤字段视图，不是新的持久化权威对象。
- **Canonical projection**：字段顺序与序列化稳定的结构化文本表示。
- **Synopsis**：为节省空间和提供概览而生成的摘要，不等于 raw content。
- **Resolver**：根据 opaque ref、bound principal 与 pinned snapshot 从权威存储解析内容的 adapter。
- **Representation kind**：说明实际搜索的是 canonical action、raw observation、channel message 或其他明确表示。
- **Index lag**：派生索引落后于权威数据的时间差。

### 决定

**决定采用 Q149=A。** Authority-resolved `SearchableStepView` 能保持 pinned snapshot、ACL、withdrawal 与来源权威，同时不让 synopsis 冒充完整 raw log。这是用户明确确认的选择；Q149 状态为 `accepted`。

## Q150：`memory-exact-snapshot/Q150-A` — Multi-session Snapshot 与 Resolver Seam 放在哪里？

**Status:** `accepted`

### 问题背景

`scopeRef` 可能覆盖多个 agent、session、sequence range 与 channel message range；现有 `LedgerSnapshot` 一次只绑定一个 session。Exact adapter 不应把 opaque refs 当作任意路径、自己猜 channel ACL，也不应在执行时现场签发新的 snapshot 替代 SearchPlan 已固定的 snapshot。

Q150 要决定谁将 opaque scope/snapshot 解析为有序、受权限约束的搜索输入，以及 matching module 是否需要理解所有底层存储。

### 涉及文件

```text
OpenViking/openviking/session/ao_ledger_reader.py
OpenViking/openviking/session/ao_ledger.py
coforge/apps/web/src/routes/api/agent/v1/memory.ts
skill-node-design-grill/docs/adr/0029-pending-memory-search-schema.md
skill-node-design-grill/docs/adr/0031-exact-hit-limit-and-independent-lane-quotas.md
skill-node-design-grill/docs/adr/0032-parent-budget-deadline-and-cancellation-tree.md
```

### Option A：Outer `ScopeSnapshotResolver` 生成 Ordered `ExactSearchSlice`

#### 机制

```ts
type ExactSearchSlice = {
  sourceSessionRef: string;
  ledgerSnapshotRef: string;
  sequenceRanges: Array<{ start: number; end: number }>;
  sourceContentResolverRef: string;
  evidenceAclPolicyRef: string;
  withdrawalPolicyRef: string;
};

type ResolvedExactSearchContext = {
  snapshotRef: string;
  orderedSlices: ExactSearchSlice[];
  resolutionPolicyVersion: string;
};
```

Outer retrieval module 使用 bound principal 解析 `scopeRef` 与 `snapshotRef`，冻结 ordered slices，验证所有 slices 属于允许的 task/snapshot authority，并签发只可用于本次 child lane 的 capability-bound content、ACL 与 withdrawal resolver refs。Slice order 写入 audit，并成为 canonical result order 的第一层。Exact adapter 只遍历 slices、解析字段、matching 与 coalescing；它不能接触任意 workspace ID、raw path 或自报 ACL labels，也不能自行签发新 snapshot。

#### 优点

- authorization/scope resolution 与 matching 分离；
- exact adapter interface 小而稳定；
- multi-session 顺序明确且可重放；
- file、channel、remote authority resolver 可替换；
- 测试可以注入 in-memory slices，不需要完整文件/数据库环境；
- raw watermark 不会变成 bearer credential；
- 符合 opaque refs 与 bound context 的既有边界。

#### 权衡

- 需要 `ScopeSnapshotResolver` 与 capability-bound resolver registry；
- resolver refs 的生命周期、replay 与失效要管理；
- 不同 authority 的 snapshot 一致性必须显式描述；
- 调试不能直接查看 raw path，需要通过受控 auditRef；
- outer module 需要验证 scope/snapshot/budget/principal 的相互一致性。

#### 后果

选择 A 后，exact adapter 不拥有 authorization；它只消费已解析、按序、受能力约束的 slices。新增存储类型通常只新增 resolver，不修改 matcher。Multi-session canonical order 在 matching 前已冻结。

### Option B：Exact Adapter 自行解析 ScopeRef 并打开所有 Stores

#### 机制

Exact adapter 接收 `scopeRef` 与 `snapshotRef`，自行查找 session 目录、channel DB、ACL registry、withdrawal registry 与 archive；它在内部完成 authorization、snapshot routing、字段解析、matching、coalescing 和排序。

#### 优点

- 组件数量少；
- 初始接线直观；
- 所有 exact 逻辑集中在一个类或 package；
- 无需设计 capability-bound resolver registry。

#### 权衡

- adapter 同时承担 authorization、snapshot、storage routing 与 matching，形成 God module；
- 测试依赖完整文件系统、数据库和 ACL 环境；
- 容易使用错误 principal，或现场签发新 snapshot；
- 新增 storage 类型会触碰 matcher；
- raw path 与 authority knowledge 扩散；
- security review 很难单独验证 resolver 或 matcher 边界。

#### 后果

选择 B 后，存储、权限或 snapshot 变化都会修改 exact matcher 模块。模块内部耦合增强，取消、deadline 与 partial dependency failure 也更难隔离和测试。

### Option C：SnapshotRef 指向预物化 Temporary Search Corpus

#### 机制

Outer resolver 先把所有 session/range/channel slice 的已授权内容复制到一个按 canonical order 排列的 immutable temporary corpus；`snapshotRef` 或其解析结果指向该 corpus；exact adapter 只搜索这个临时数据集。

#### 优点

- matcher 极其简单；
- multi-session 顺序天然固定；
- 同一临时 corpus 可重复执行多个 literal/regex 查询；
- 容易把 matcher 放入 sandbox 或独立 worker；
- 底层 authority fan-out 在物化阶段一次完成。

#### 权衡

- 复制大量 raw、跨 session 的敏感内容；
- temporary corpus 自身需要 ACL、加密、TTL、deletion 与 access audit；
- 物化后发生 withdrawal/revocation 时如何处理不明确；
- 生成成本高，父取消后还需可靠清理；
- 多个 authority 的内容被聚合到一个新资产，爆炸半径增大；
- corpus identity 与原 snapshot authority 的关系需要额外证明。

#### 后果

选择 C 后，系统新增受控临时数据资产及其完整生命周期，而不只是 adapter seam。必须定义 materialization complete/failed、撤回后的 invalidation、TTL 与 secure deletion 语义。

### 具体示例

Scope 包含：agent-A session sequence 1–40、agent-B session sequence 8–22，以及 channel 中两条 messages。

- **A**：resolver 生成 `A → B → channel` 的 ordered slices 与受限 handles；adapter 按该顺序搜索并用同一顺序排序 refs。
- **B**：adapter 自己打开两个 session 目录与 channel DB，并在内部判断三处权限和 snapshot。
- **C**：先将三段内容复制为临时 corpus，再对该 corpus 搜索；若随后一条 message 被撤回，必须决定是否使整个 corpus 失效。

### 术语解释

- **ScopeSnapshotResolver**：把 opaque scope/snapshot refs 解析为受控、冻结读取切片的模块。
- **Search slice**：一个来源 session/range 或 channel range 的有序搜索输入。
- **Capability-bound resolver**：只能在指定 principal、scope、snapshot 与 child operation 中读取内容的解析器。
- **Bearer credential**：仅凭持有即可访问资源的凭证；raw watermark 不应退化为这种凭证。
- **God module**：承担过多不相关职责，导致测试、安全审查和演化困难的模块。
- **Materialized corpus**：预先复制并整理好的搜索数据集合。

### 决定

**决定采用 Q150=A。** Outer resolver 负责 ordered capability-bound slices，exact adapter 只负责内容解析后的 matching、coalescing 与 ref 构造，权限和存储知识不会扩散到 matcher。这是用户明确确认的选择；Q150 状态为 `accepted`。

## Q151：`memory-exact-regex/Q151-A` — Regex 采用哪种执行语义与安全边界？

**Status:** `accepted`

### 问题背景

Typed exact clause 已支持 `syntax="literal" | "regex"`。普通 Python/JavaScript backtracking regex 可能因恶意或复杂 expression 产生 catastrophic backtracking 与 ReDoS。只在 AO row 或 field 之间检查 deadline/cancellation，无法中断一次正在阻塞的危险 match，因此 regex dialect 必须与已定的 deadline/cancellation 语义兼容。

### 涉及文件

```text
skill-node-design-grill/docs/adr/0029-pending-memory-search-schema.md
skill-node-design-grill/docs/adr/0030-exact-lane-clause-presence-trigger.md
skill-node-design-grill/docs/adr/0032-parent-budget-deadline-and-cancellation-tree.md
OpenViking/openviking/session/ao_ledger_reader.py
```

当前代码没有 exact literal/regex matcher；本问题决定未来 matcher policy，不选择具体第三方 package 或实现语言。

### Option A：RE2-compatible Linear-time Dialect

#### 机制

- `regex` 只接受 RE2-compatible 的线性时间语法子集；
- 拒绝 backreference、lookbehind 与其他无法保证线性复杂度的特性；
- expression 长度或 code-point 数有 server hard limit；
- compile error 是 request-level invalid input，不伪装成零命中；
- `literal` 模式完整转义 expression，不解释 regex 元字符；
- case-insensitive 语义使用固定、版本化的 Unicode case-fold/engine policy；
- 每个 field match 仍受 child budget、deadline 与 cancel signal 约束；
- matcher dialect、normalization 与 case policy version 写入 `LaneAudit.featureVersions` 或 native audit。

#### 优点

- 时间复杂度可预测，天然抵抗 catastrophic backtracking；
- 无需为每次 match 创建 sandbox process；
- 适合在大量 AO fields 上扫描；
- 父预算与 deadline 更容易可靠执行；
- 语法限制和版本可以清晰审计；
- literal 继续保持真正 literal，不与 regex 混淆。

#### 权衡

- 不支持完整 PCRE/Python/JavaScript regex 功能；
- 熟悉 lookaround/backreference 的用户会遇到明确拒绝；
- 跨语言实现的 Unicode 与 case-fold 细节仍需版本化；
- 需要良好的 validation error，说明不支持的 feature；
- 仍需限制 expression size 与输出 spans，线性时间不等于无限成本。

#### 后果

选择 A 后，公共 `regex` 明确表示安全、版本化子集，不承诺兼容 host runtime 的全部正则语法。Unsupported syntax 在执行扫描前失败；matcher 可以在主进程运行，但仍接受预算与取消治理。

### Option B：Host Regex In-process 加 Cooperative Checks

#### 机制

直接使用 Python `re` 或 JavaScript `RegExp`。在开始下一个 row/field 前检查 deadline、budget 与 cancellation；单次 match 由 host runtime 同步执行。

#### 优点

- 实现简单；
- 语法功能丰富，用户熟悉；
- 无额外依赖或 IPC；
- 可快速复用当前语言生态的 regex API。

#### 权衡

- 单次 match 可陷入 catastrophic backtracking，外层 cooperative check 无法介入；
- 恶意 expression/input 可长时间占用 CPU；
- 父取消不能及时停止阻塞中的 match；
- Python 与 JavaScript 的语法、Unicode 和 edge cases 不一致；
- 一个危险 field 会阻塞整个 lane，甚至影响 sibling 与服务线程。

#### 后果

选择 B 后，系统不能可靠满足已经固定的 child deadline/cancellation 语义。即使 row 之间检查很频繁，也无法约束单次危险匹配；需要接受这一可靠性缺口或另加不可见的实现限制。

### Option C：Full PCRE/Python Regex in Sandboxed Worker

#### 机制

每个 query 在受限 process/worker 中编译和执行完整或较完整的 host regex；worker 配置 CPU、memory 与 wall-time limit，超时或取消时强制 kill。主进程通过 IPC 传入 expression 与字段，接收 spans 或 failure。

#### 优点

- 可以支持丰富 regex 语法；
- 强制终止能力强；
- runtime crash 与 ReDoS 被隔离；
- 可以独立限制 CPU/memory/time；
- 对需要 backreference/lookaround 的高级查询更友好。

#### 权衡

- process/IPC 成本高；
- 大量 raw fields 跨 process 边界传输；
- worker pool 生命周期、清理与资源配额复杂；
- 敏感内容的进程边界与 crash dump 需要治理；
- 仍需固定语法、Unicode、case 与版本；
- timeout 会转化为 runtime/dependency failure，LaneAudit 语义更复杂。

#### 后果

选择 C 后，exact search 变成较重的 sandbox execution system。系统必须定义 worker startup failure、partial scan、timeout、kill、retry、sensitive-buffer cleanup 与 parent cancellation 的一致行为。

### 具体示例

Expression：

```regex
(a+)+$
```

输入是很长的 `aaaa...ab`。

- **A**：线性时间引擎安全完成，或在 compile 阶段拒绝不属于安全 dialect 的 feature。
- **B**：backtracking 可能长时间占用 CPU，程序无法到达下一次 deadline check。
- **C**：worker 超时后可被 kill，但需要承担 IPC、worker pool 与 failure mapping 成本。

另一个 expression `(?<=error:)\s+\w+` 含 lookbehind：A 明确拒绝；B/C 可能支持，但 B 保留 in-process 风险，C 需要 sandbox 生命周期。

### 术语解释

- **Regex dialect**：允许哪些正则语法与执行语义的规则集合。
- **RE2-compatible**：排除易导致非线性回溯特性的线性时间正则子集。
- **Backtracking**：引擎反复尝试不同匹配路径的执行方式。
- **Catastrophic backtracking**：路径组合爆炸导致匹配时间极端增长。
- **ReDoS**：利用恶意正则或输入消耗 CPU、造成拒绝服务。
- **Backreference**：在正则中引用前面捕获组实际内容的特性。
- **Lookbehind**：检查当前位置之前的文本而不消耗字符的高级特性。
- **Case fold**：Unicode 不区分大小写匹配使用的规范化规则。

### 决定

**决定采用 Q151=A。** RE2-compatible 线性时间 dialect 最符合多 AO 扫描、父 deadline 与 cancellation 的既有可靠性约束；literal 模式保持完全转义。这是用户明确确认的选择；Q151 状态为 `accepted`。

## Q152：`memory-exact-ref/Q152-B` — 同一 AO/Field 的多个匹配如何表示？

**Status:** `accepted`

### 问题背景

一个 public exact hit 已固定按 `(sourceSessionRef, aoId, matchedField)` 唯一，因此不能把每个 occurrence 作为独立 hit；否则同一长字段可以占满 exact public limit。另一方面，`CurrentEvidenceRef` 仍需告诉 consumer 命中位置，并避免一条重复文本生成无限大的 response。

Q152 要决定一个 coalesced ref 保存多少 spans/fragments、是否提供 occurrence 总数，以及怎样区分“field 内 span 截断”和“lane 级 evidence ref 截断”。

### 涉及文件

```text
skill-node-design-grill/docs/adr/0029-pending-memory-search-schema.md
skill-node-design-grill/docs/adr/0031-exact-hit-limit-and-independent-lane-quotas.md
OpenViking/openviking/session/ao_ledger.py
OpenViking/openviking/session/ao_ledger_reader.py
```

`CurrentEvidenceRef` 的最终生产 schema 尚未实现；下列类型仅说明选项机制。

### Option A：First Match 加 `totalOccurrences`

#### 机制

一个 ref 只返回 offset 最小的 match 与该已授权 field 内的 occurrence 总数：

```ts
type CurrentEvidenceRef = {
  firstMatch: {
    start: number;
    end: number;
    fragment: string;
  };
  totalOccurrences: number;
};
```

Matcher 仍扫描完整 field 以计算总数，但只保留第一个 span/fragment。Identity、representation、hash、snapshot 与 evidence ref 等基础字段仍由最终 schema 携带。

#### 优点

- schema 最小；
- 单 ref response size 稳定；
- 足以证明该 field 至少有一次命中；
- UI 可以先展示第一个位置；
- fragment policy 较容易实现和测试。

#### 权衡

- 后续重要匹配位置全部丢失；
- first match 不一定最有解释价值；
- consumer 如需第二个位置，必须再次读取完整 field；
- total count 在 redaction/normalization 后的语义必须说明；
- 虽然只返回一个 span，仍可能需要扫描完整 field 才能给出准确总数。

#### 后果

选择 A 后，exact ref 主要是 field 定位入口，而不是多个 occurrence 的有界摘要。Selective drill-down 需要额外读取步骤，UI 高亮能力有限。

### Option B：Bounded Match Spans 加 `totalOccurrences`

#### 机制

```ts
type ExactMatchSpan = {
  start: number;
  end: number;
  fragment: string;
};

type CurrentEvidenceRef = {
  kind: "current_log_match";
  sourceSessionRef: string;
  aoId: string;
  sequence: number;
  matchedField: "action" | "observation" | "message";
  representation: "canonical_action" | "raw_observation" | "channel_message";
  contentHash: string;
  snapshotRef: string;
  evidenceRef: string;
  matches: ExactMatchSpan[];
  totalOccurrences: number;
  spansTruncated: boolean;
};
```

规则如下：

- `matches` 按 offset 升序；
- 每个 ref 只返回 policy-bounded 的前 N 个 spans；
- `totalOccurrences` 只统计该已授权、实际搜索的 field representation；
- `spansTruncated=true` 表示同一 field 还有未列出的 occurrences；
- fragment 使用固定、版本化的前后文窗口，并在 Unicode 边界安全截断；
- `contentHash` 绑定实际 searched representation；
- offset unit、max-spans、fragment window 与 normalization policy 全部版本化并进入 audit；
- field 内 `spansTruncated` 与 lane 级 `truncated` 分开：前者是一个 ref 内未列出更多位置，后者是还有独立 `CurrentEvidenceRef` 未返回。

#### 优点

- 保留多个有用匹配位置；
- 单 ref 仍有硬界；
- offset 与 content hash 可验证；
- replay 在 representation 与 policy version 不变时稳定；
- 适合 UI 高亮和 selective drill-down；
- 明确区分 field 内截断与 lane public result 截断。

#### 权衡

- schema 比 A 更大；
- 必须固定 offset unit、fragment window 与 max-spans policy；
- 准确 `totalOccurrences` 可能要求扫描完整 field；
- representation 或 normalization 改变会改变 hash 与 offset；
- Unicode grapheme、code point、UTF-8 byte 或 UTF-16 code unit 的选择会影响跨语言 consumer；
- fragment 本身扩大 raw 内容暴露面，必须保持有界并服从 evidence ACL。

#### 后果

选择 B 后，系统必须选择并版本化 offset unit，且把 fragment/max-spans policy 写入 LaneAudit。Ref 成为可验证、有界的 match summary；consumer 不必为查看多个早期位置立即读取完整字段。

### Option C：返回全部 Match Spans/Fragments

#### 机制

同一 ref 内返回该 field 的所有 occurrences 与 fragments，不设 per-field 上限。Public hit identity 仍只有一个，但 payload 随 occurrence 数增长。

#### 优点

- 信息最完整；
- consumer 无需再次下钻；
- 适合离线分析和完整高亮；
- 不需要 `spansTruncated` 或 max-spans policy。

#### 权衡

- 单个 field 可生成巨大 response；
- 恶意重复文本会造成 memory、serialization 与 token 放大；
- exact public hit cap 无法约束单 hit 大小；
- 大量 fragment 增加 raw 内容泄露面；
- deadline/cancellation 后很难区分完整 occurrence list 与 partial list；
- network、audit 与 cache 成本不可控。

#### 后果

选择 C 后，“有界 exact response”目标被破坏。即使 public hit 数不超过 20，单个 ref 也可能携带数千 fragments，绕过结果上限的资源保护意图。

### 具体示例

一个已授权 raw tool result 中，`timeout` 出现 27 次：

- **A**：返回第一个 span 与 `totalOccurrences=27`。
- **B**：若 policy 的 N=5，则返回前 5 个 spans、`totalOccurrences=27`、`spansTruncated=true`。
- **C**：返回全部 27 个 fragments；虽然只占一个 public hit，payload 仍可能很大。

若 exact lane 还有第 21 个独立 AO/field hit，而 effective limit 为 20，B 可同时表达：某个已返回 field 的 `spansTruncated=true`，以及 lane audit 的 `truncated=true`。两者不能混为一个标记。

### 术语解释

- **Occurrence**：expression 在同一 field representation 中的一次匹配。
- **Span**：一次匹配在文本中的 start/end 位置。
- **Fragment**：匹配周围的有界上下文片段。
- **Offset unit**：start/end 使用 UTF-8 byte、Unicode code point、UTF-16 code unit 或其他单位中的哪一种。
- **Content hash**：实际 searched representation 内容的稳定哈希。
- **Coalescing**：把同一 `(session, AO, field)` 的多个 occurrences 合并为一个 public ref。
- **Spans truncated**：同一 field 还有未列出的 match positions。
- **Lane truncated**：还有未返回的独立 `CurrentEvidenceRef`。

### 决定

**决定采用 Q152=B。** 一个 ref 携带有界 spans、准确 occurrence 总数、独立 `spansTruncated` 与 representation hash，能同时支持可验证定位和响应硬界。这是用户明确确认的选择；Q152 状态为 `accepted`。

## 后续问题的解决状态

### Cross-corpus 12-slot allocation

Q147-B 与 Q148-B 已经把 allocation 的输入与语义边界固定下来：

- allocation 由 outer `MemoryDiscoveryCoordinator` 在 typed corpus adapters、逐对象 ACL/status recheck 与中央 use-class classification 之后执行；
- 输入是尚未经过 provider-level public cap 的 named-corpus candidates，不是两个 provider 各自预裁剪后的列表；
- 首版 `memory_candidate` 包括 active/current skill revision、active current-head insight、validated fork/branch，以及带机器可见 warning 的 visible provisional fork/branch；
- block/claim projection、observed episode、segment/atom 属于 `analogical_prior`；invalidated、retired、superseded、ACL-denied、withdrawn 或关键状态/provenance 缺失对象被排除；
- discovery public cap 12 保持不变；12 席内部已由 `memory-discovery-allocation/Q153-B` 固定为 candidate 8/prior 4、corpus floor=1/ceiling=4、same-class backfill、fact pause hole 与统一 exploration seat。

### Final deterministic interleave/ranking

Q147-B 排除了跨 provider 数值 score 直排，Q148-B 固定了 candidate/prior 分栏。这些顺序问题已由 `memory-discovery-allocation/Q153-B` 与 `memory-discovery-interleave/Q154-B` 闭合：native score 只作 corpus-local feature；allocation 使用 rank-depth water-fill；final arrays 复用 stable rotation 做 zipper，并以 canonical identity 完成 total tie-break。

不得恢复 OpenViking 旧 facade 的 6/4/2、8/4 和 cap 12 作为 provider-local public selector；这些只可作为后续 policy 设计的历史输入。

### Coforge exploration/expansion placement

`memory-expansion-placement/Q155-B` 已选择第二种：initial retrieve 冻结 direct E0 后，由 served anchor 发起 one-relation/one-hop derived expansion operation，生成独立 E1；E0 不被修改，E1 重新经过 ACL/status/use-class、Q153 allocation 与 Q154 zipper。

## Exact adapter closure

Q149-A、Q150-A、Q151-A 与 Q152-B 已闭合 exact 内部契约：

- exact 搜索 authority-resolved `SearchableStepView`，不以 ledger synopsis 冒充 raw current log；
- outer `ScopeSnapshotResolver` 将 opaque scope/snapshot refs 解析为 ordered、capability-bound `ExactSearchSlice`，exact matcher 不自行打开任意 stores 或签发 snapshot；
- regex 使用有表达式硬上限的 RE2-compatible 线性时间 dialect；unsupported syntax 在扫描前作为 invalid input 拒绝，literal 始终完整转义；
- public ref 按 `(sourceSessionRef, aoId, matchedField)` coalesce，携带有界、offset 有序的 match spans、`totalOccurrences`、独立 `spansTruncated` 与 searched-representation `contentHash`；
- representation/normalization/hash/offset/max-spans/fragment-window/matcher 版本进入 feature/native audit；
- resolver dependency failure、field unavailable、request invalid 与 lane termination 必须保持机器可分。

## 接受状态

```text
memory-corpus-topology/Q147-B
memory-use-class-policy/Q148-B
memory-exact-content/Q149-A
memory-exact-snapshot/Q150-A
memory-exact-regex/Q151-A
memory-exact-ref/Q152-B
```

完整 A/B/C 选项与取舍保留在本 ADR。上述稳定键是 accepted decisions；后续实现和设计必须以带选项后缀的键引用，不得继续使用无后缀 pending key 冒充已定状态。
