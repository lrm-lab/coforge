# Memory Discovery Cross-corpus Allocation

**Decision key:** `memory-discovery-allocation/Q153-B`
**Status:** `accepted`
**Decision:** Class envelope + corpus floors + bounded same-class flex
**Source record:** `/tmp/kiro_b8.log`
**Scope:** 统一 `memory_discovery` lane 在完成逐对象 ACL/status recheck 与中央 use-class classification 后、public cap=12 之前的 seat allocation；不决定最终 card interleave/ranking 或 Coforge expansion placement

## 背景

`memory-corpus-topology/Q147-B` 已固定 outer `MemoryDiscoveryCoordinator` 消费未经 provider-level public pre-truncation 的 typed corpus adapters，并独占中央 classification、allocation 与 public selection。`memory-use-class-policy/Q148-B` 已固定首版 use class：

```text
memory_candidate
  fork/branch: validated 或带机器可见 warning 的 visible provisional
  insight: active current head
  skill_revision: active/current

analogical_prior
  block_projection / claim_projection
  observed episode
  segment / atom

excluded
  invalidated / retired / superseded / ACL-denied / withdrawn
  关键 status/provenance 缺失且不能安全降级的对象
```

Discovery public cap 已固定为 12。只有 completed discovery 真正 served 的 `memory_candidate` 可以驱动 Memory Hint/Offer；`analogical_prior` 只能启发进一步核验。因此 allocation 必须在行动候选覆盖、导航/历史 prior 覆盖、corpus starvation、单来源垄断、fact pause 与探索机会之间建立可重放边界，而不能退化为异构 native score 的全局 Top12。

## 现有实现约束

### OpenViking

`OpenViking/openviking/session/retrieval_facade.py` 当前有：

```text
CAUSAL_MEMORY_CAP = 12
DEFAULT_FORK_BRANCH_QUOTA = 6
DEFAULT_PROJECTION_QUOTA = 4
DEFAULT_SEGMENT_ATOM_QUOTA = 2
VERIFIED_SLOTS = 8
PROVISIONAL_SLOTS = 4
FACT_LANE_PAUSED = True
```

旧 `HybridRetrievalFacade` 先按 6/4/2 调三个 OpenViking adapters，再对 stateful cards 做 verified/provisional 8/4 slotting；provisional 在 `n>=2` 时采用 `n-1 exploitation + 1 seeded exploration`，verified/provisional shortage 可以互相 backfill；fact paused 时旧 2 席不回填。Q147-B 后，这些参数只是 provider-local migration input，不能继续拥有 unified public selection。

特别地，旧 verified/provisional 8/4 不能改名冒充新的 candidate/prior 8/4：前者表达对象验证状态，后者表达本次 response 允许怎样消费。

### Coforge

`memory-similarity.server.ts` 当前把 episode、active current-head insight 与 active current skill revision 放入同一 trigram SQL union，仅按 `score DESC, kind ASC` 排序，缺少相同 score/kind 下的最终 identity tie-break，也没有 corpus floors。

`memory-expansion.server.ts` 的多条 provenance-edge SQL 没有 `ORDER BY`；similar 分支也只有 `score DESC`，没有完整 tie-break。Expansion nodes 因此尚未形成可供 outer allocation 直接消费的稳定 corpus-local queue。

### 固定约束

1. Discovery public cap 为 12；exact/discovery 不跨 lane 借位。
2. ACL、withdrawal、current-head/current-revision 与 status recheck 在占 public seat 前完成；不可见对象不耗 seat，也不公开 filtered count。
3. Adapter 保留 native identity/status/rank/score/audit，但无权自报 use class。
4. Native scores 只在来源/corpus 内有意义，不建立 OpenViking BM25、Coforge trigram 和无 score expansion node 的共同数值尺度。
5. Candidate/prior 进入不同 typed arrays；prior 不能因 seat shortage 升级为 candidate。
6. Terminated discovery 的 intermediate cards 不进入 public allocation。
7. Allocation、eligible set、seat reason 与 exploration draw 必须版本化并可由 planHash/snapshot 重放。
8. Skill cold-start exploration 保持总 skill exploration 不超过 10%；进入正常 exploitation 仍要求至少 5 个可归因 outcomes、来自至少 3 条 task lineages。

## 备选方案

### Option A：Strict Static Matrix

#### 机制

固定矩阵：

```text
memory_candidate: 8
  fork/branch:     4
  insight:         2
  skill_revision:  2

analogical_prior: 4
  projection:      2
  episode:         1
  segment/atom:    1
```

每个 corpus 只能消费自己的硬配额；corpus 不足时留空，不做同 class 或跨 class backfill。Fact paused 时其 1 席封存。Candidate 的最后 1 席固定为 discovery-wide exploration seat；eligible 只有通过硬门的 visible provisional fork/branch 与 cold-start skill revision，按 planHash 派生 seed、先抽 corpus stratum 再抽 card。无 eligible 时探索席也留空。

#### 优点

- 最容易解释、实现和重放；
- 单一 corpus 不会淹没结果；
- candidate/prior 比例稳定；
- paused fact 不会被静默吞位；
- audit 只需 matrix slot 与 corpus-local rank。

#### 权衡

- 很容易 underfill；
- 同 class 的强候选不能吸收空 corpus 的席；
- exploration 无 eligible 时仍浪费 seat；
- 固定 fork=4 可能无意延续 OpenViking 历史权重；
- 新增 corpus 必须重切整个矩阵；
- 固定 quota 不能适应不同 query 的 corpus supply。

#### 后果

A 形成强可预测、低利用率合同。后续 interleave 较简单，但 expansion 必须进入固定小桶，容易与 initial seeds 争夺过窄配额。

### Option B：Class Envelope + Corpus Floors + Bounded Flex

#### 机制

第一层固定新的 outer use-class envelope：

```text
memory_candidate: 最多 8
analogical_prior: 最多 4
总计:             最多 12
```

该 8/4 不继承旧 verified/provisional 8/4。

第二层在每个 class 内给有 eligible cards 的 corpus 一个 coverage floor：

```text
candidate floors
  fork/branch:     1
  insight:         1
  skill_revision:  1

prior floors
  projection:      1
  episode:         1
  segment/atom:    1（active 时）
```

第三层分配 flex seats：

- 只做 same-class backfill；candidate 与 prior 不互借；
- 每个 corpus 总 ceiling 为 4；
- 不比较 native score；按 corpus-local rank depth water-fill：先各 corpus rank-1，再 rank-2、rank-3；
- 同 depth 的 corpus 顺序由 `planHash + allocationPolicyVersion + useClass` 派生 stable rotation；
- allocation 只决定 selected set 与每 corpus seat count，不决定最终 public card 顺序。

Fact pause：

- unified policy 为 segment/atom 保留 1 个 prior seat；
- paused 时该 seat 标记 `pause_reserved`，projection/episode 不可回填；
- pause 期间最多 8 candidates + 3 priors = 11；
- 这是新增 Coforge corpora 后把旧 2-seat fact reservation 明确收缩为 1 的 outer-policy 变化，不冒充旧 6/4/2 原样延续。

Exploration：

- candidate envelope 内最多 1 个 discovery-wide exploration seat，不增加 cap；
- eligible set 首版包含通过所有硬门的 visible provisional fork/branch 与 cold-start skill revision；
- 先 seeded draw eligible corpus stratum，再在该 corpus 内 seeded draw card，避免大 corpus 仅凭体量垄断；
- skill stratum 只有 rolling skill-exploration rate 仍允许时才参加，继续满足 ≤10%；
- 无 eligible exploration card 时，在 candidate class 内回填 exploitation；
- `selection_mode=exploration` 不改变 use class、validation status 或 provisional/cold-start warning。

受控 audit 至少保存：

```text
allocationPolicyVersion
classCaps { candidate: 8, prior: 4 }
corpusFloors
corpusCeilings
factPauseReservation
seatAssignments[] {
  seatClass,
  corpus,
  corpusLocalRank,
  reason: floor | flex | same_class_backfill | exploration,
  rotationSeedRef
}
explorationAudit {
  eligibleStrata,
  chosenStratum,
  chosenCardRef,
  propensity,
  seedRef,
  skillRollingCapApplied
}
underfillReasons[]
```

Public LaneAudit 只保留非敏感 feature version、returnedCount、truncated 与 opaque nativeAuditRefs，不内联 eligible counts、ACL labels 或小样本分布。

#### 优点

- candidate/prior 各有稳定空间；
- 每个非空 corpus 至少获得一次可见机会；
- same-class backfill 比静态矩阵少浪费；
- ceiling=4 防 episode、fork 或 insight 垄断；
- rank-depth water-fill 不需要跨 corpus score；
- stable rotation 可重放且降低固定字母序偏置；
- exploration 只有一个 owner，避免 OpenViking provisional、skill cold start 与 Coforge 各自重复扣位；
- fact pause hole 和 policy 迁移都显式可审计。

#### 权衡

- 参数与实现比 A 复杂；
- 8/4、floor=1、ceiling=4、fact reservation=1 都是需版本化评估的首版参数；
- class 不互借仍可能 underfill；
- water-fill 要求 adapters 先提供稳定 corpus-local order；
- stable rotation 可能使 canonical plan 不同的查询在 cutoff tie 上选择不同 corpus；
- floor card 可能弱于另一 corpus deeper card，这是 coverage 与纯 relevance 的明确交换；
- exploration mode 与 provisional status 是正交维度，schema 必须同时保留。

#### 后果

B 为后续 interleave 提供了稳定输入：每个 class/corpus 先固定 seat count 与 selected set；最终顺序随后由 `memory-discovery-interleave/Q154-B` 以 stable-rotation rank-depth zipper 闭合。Expanded objects 则由 `memory-expansion-placement/Q155-B` 规定在 derived operation 中回到原 kind queue，并受同一 class cap/corpus ceiling，不能创造第 13 席。

### Option C：Demand-adaptive Pool

#### 机制

只保证存在时至少 1 candidate、1 prior 和最多 1 exploration；其余 9–11 席按 eligible queue depth、native score distribution/score mass、dependency-pattern match、status 与历史 exposure 算 demand weight，再用 largest-remainder 或 weighted deficit round-robin 分配。允许 candidate/prior 在最低保护外跨 class 借位。Fact paused 时 reservation=0，其他 corpus 可填满 12。

#### 优点

- 利用率最高；
- 对 query 与 corpus 密度变化适应强；
- 新 corpus 接入无需重切固定矩阵；
- fact pause 不降低 returned count。

#### 权衡

- 异构 native score 分布会取得 allocation 权力；
- 数量大、文本长或分数尖锐的 corpus 可能持续抢位；
- demand weight 容易演化成隐藏 global rank，重开已拒绝的混池语义；
- candidate/prior 任一可能被压到 1；
- 微小 query 变化可改变 seat counts；
- exposure feedback 可能形成 rich-get-richer；
- demand-adaptive allocation 会要求先建立 score calibration/common ranking，再反过来决定 seats；这与后续已接受的 `memory-discovery-interleave/Q154-B` ordinal zipper 依赖方向相反；
- expansion queue depth 会反过来改变 initial allocation。

#### 后果

C 最大化吞吐，但使 Q153 与后续 ranking/expansion placement 无法保持清晰模块边界。

## 场景对比

ACL/status/classification 后：

```text
candidates
  fork/branch: 7
  insight: 4
  skill_revision: 1

priors
  projection: 5
  episode: 6
  segment/atom: paused
```

- A：fork4 + insight2 + skill1 + projection2 + episode1 = 10；skill 与 fact 空位不回填。
- B：candidate floors 后 5 个 flex 按 rank depth 分配，一种 stable rotation 可得到 fork4/insight3/skill1；prior 只有 3 个可用席，fact 1 席封存；共 11。
- C：可返回满 12，但必须先定义 demand scale，且 episode/fork 的统计分布可能主导。

如果只有 priors：A 最多 3，B 最多 3，C 可让 priors 填满 12。如果只有 candidates：A 最多 8 且常因 corpus 硬配额更少，B 最多 8，C 可填满 12。A/B 把 12 视为 ceiling 而非必须填满；C 优先吞吐。

## 决定

采用 **Option B**，稳定键为：

```text
memory-discovery-allocation/Q153-B
```

接受的完整参数是：

1. outer use-class caps：candidate=8、prior=4、总 cap=12；
2. 六个 typed corpus group 在其 class 内各有 floor=1；
3. 每 corpus ceiling=4；
4. 只做 same-class backfill，不做 candidate↔prior backfill；
5. flex seats 按 corpus-local rank-depth water-fill；同 depth 由 planHash + policy version + use class 派生 stable rotation；
6. fact active 时有 1 prior seat；paused 时成为不可回填的 `pause_reserved` hole，因此最多返回 11；
7. candidate cap 内最多 1 discovery-wide exploration seat；eligible strata 为 visible provisional fork/branch 与 cold-start skill revision；先抽 stratum 再抽 card；
8. skill stratum 继续受 rolling ≤10% exploration gate；
9. 无 exploration eligible 时在 candidate class 内回填 exploitation；
10. allocation audit 逐 seat 记录 floor/flex/backfill/exploration 原因，public LaneAudit 不泄露 eligible counts。

## 拒绝其他方案的理由

拒绝 A，不是因为静态矩阵不可实现，而是它在 corpus 稀疏、fact paused 或 exploration 无 eligible 时产生过多无谓空位，并把历史 OpenViking 权重固化进新统一层。

拒绝 C，不是因为满 12 本身错误，而是 demand-adaptive allocation 必须比较异构 score distribution、queue depth 或 exposure，事实上会提前建立隐藏的跨 corpus common scale，并让 expansion supply 反向改变 initial allocation。后续 `memory-discovery-interleave/Q154-B` 与 `memory-expansion-placement/Q155-B` 已分别用 ordinal zipper 和 post-envelope derived operation保持了这两个边界。

## 后果

### 正向

- outer coordinator 成为 allocation 唯一所有者；
- candidate/prior 语义比例、corpus coverage 与 monopoly protection 明确；
- no-common-score 的边界得到保留；
- exploration 有统一、可审计的 owner；
- paused fact hole 不再隐藏在 provider facade 内；
- 相同 plan/snapshot/policy 可重放 seat assignments。

### 成本与风险

- Coforge seed 与 expansion adapters 必须补稳定 corpus-local tie-break；
- OpenViking 旧 facade 不能在新 coordinator 前继续 public pre-truncation；
- policy 参数需要版本化、离线评估与迁移审计；
- 8/4 不跨回填和 fact pause hole会有意返回少于 12；
- consumer 必须区分 use class、native status 与 selection mode。

## 后续节点的解决状态

Q153-B 解锁的节点现已闭合：

```text
memory-discovery-interleave/Q154-B
memory-expansion-placement/Q155-B
```

Q154-B 只排列 Q153 selected sets，使用 corpus-local total order、allocationHash membership freeze、stable-rotation rank-depth zipper 与 finalOrderHash，不改变 seat counts 或跨 class 借位。Q155-B 将 expansion 放在 frozen envelope 后：expanded objects进入原 kind corpus queue，重新经过 ACL/status/use-class、Q153 allocation与Q154 zipper，并生成独立derived envelope。
