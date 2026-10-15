# Round 10 待答问题清单（已全部答复，本文件仅留档）

> 2026-09-24 更新：Q109–Q125 全部落定（多数按推荐，例外：Q116=B、Q118=B、Q120=B）。最终答案见 round-10-answers.md；共识已入 CONSENSUS.md（叙述 72–85 / 总账 #81–#94）；ADR 0010–0013 已立。

（生成于 2026-09-24。已答：Q116=B、Q122=A、Q124=A、Q125=A。以下 13 题待拍板，文末附答题模板。每题完整论证见 round-10-questions.md。）

## A. post_run 索引管道（Q102 重定案打开的新分支）

❓ **Q109** - **post_run_index 视图采用什么覆盖策略？**
query-neutral 视图没有失败目标也没有诊断 query，Q97 的稀疏覆盖规则不直接适用。
- A. 有界目的性覆盖：以"task 目标 + observed outcome"为组织 query，覆盖任务执行路径相关的 AO/Segment 子集，必须带 coverage_manifest（含 omitted ranges 与理由），沿用 Q97 结构约束（无环、root→sink 弱连通、skip 标注）
- B. 全轨迹覆盖（Q97 明确避免的"昂贵日志重写"）
- C. 固定滑动窗口摘要（如只索引最后 N 个 AO——丢任务早期因果链）

➡️ 推荐 A。

❓ **Q110** - **post_run 索引管道归谁所有，成本与留存如何治理？**
每条 causal 轨迹跑一次 LLM 构图（Builder/Critic/Refiner）是持续成本；Q92 的 orchestrator 只管评测状态机。
- A. 独立服务端异步索引服务（与 outbox/aggregator 同模式）：workspace 级预算与速率上限；队列优先级 = evaluation 任务 > 失败轨迹 > 成功轨迹；预算耗尽/超限降级为 deterministic fallback view 或明确没有 projection；supersede 的旧 view revision 与 projection 退出索引只留审计；workspace 可暂停
- B. 由 EvaluationOrchestrator 顺带驱动所有索引
- C. 不设预算，轨迹 commit 即同步建图

➡️ 推荐 A。

❓ **Q111** - **多 commit 会话中 post_run 视图如何演化？**
一个 session 可能多次 commit，字面执行"每 commit 生成"会产生重叠视图串。
- A. 以 session（或 task run）为视图主体：后续 commit 产生 superseding InfluenceViewRevision，旧 revision 保留为历史证据但 projection 退出索引；diagnosis 派生仍可引用任意历史 revision
- B. 每个 commit 独立一份视图，全部保持可检索
- C. 只有 session 结束（.done）才生成一份

➡️ 推荐 A。

## B. 混合检索配额与投影治理

❓ **Q112** - **三类 corpus 的配额如何与既有的 12 候选 / 8-4 通道合成？**
Q79（每次 ≤12、verified 8/provisional 4）与 Q102 重定案（三 corpus 各自配额）没有合成规则。
- A. 分层配额：Interaction lane 维持独立候选预算（不占 12）；causal-memory lane 内 12 为查询级总帽，默认 Fork/Branch 6、Block/Claim projection 4、Segment/Atom 引用展开 2，role profile 可调但总帽不变；8-4 通道切分只对有状态语义的对象生效，事实类 corpus 按各自规则进榜并带来源标签
- B. 每 corpus 各 12（总量最多 36）
- C. 取消 corpus 配额，合并统一 Top 12

➡️ 推荐 A（6/4/2 数字可再调，规则先定）。

❓ **Q113** - **Influence projection 是否永远停在 provisional 通道？**
CONSENSUS #61 说投影进 provisional 检索；被 validated ForkRevision grounding 之后呢？
- A. 通道跟随 grounding 状态：被 validated ForkRevision grounding 的 block/claim projection 可进 verified 通道并带 provenance 标签；未被 grounding 或只被 provisional/invalidated 引用的保持 provisional。projection 本身仍不是证据原件
- B. projection 永远 provisional
- C. projection 单独走第三条通道

➡️ 推荐 A（与 Q122-A 定下的 M4' 记账隔离互补：Q113 管排通道，M4' 管投影命中算不算引用——投影命中只记索引级 exposure，成为 ForkRevision/Hint 来源后才进因果账本）。

❓ **Q114** - **来源 ACL 变化时，已发布的 projection 如何处理？**
已全局可见的摘要卡片在来源 session 权限收紧后构成侧信道。
- A. projection 继承来源 AO/Segment 安全标签；ACL 变更事件经 outbox 触发受影响 projection 的再投影/撤下（redact 或退出索引），引用它的 Fork grounding 标 needs_revalidation（证据失效驱动，沿用变质模型）；下钻路径 redacted 节点仍是断点
- B. projection 一经发布不再更新，ACL 只在下钻时生效
- C. projection 不带来源内容只放 ID

➡️ 推荐 A。

## C. 账本一致性

❓ **Q115** - **worker 并发上限的账本一致性确认。**
现存三个数字：Round 7"并行子诊断 ≤3"、Q69"评测迭代统一并发 5（共用槽位）"、Round 8 dossier"≤4 候选/1 path/≤首诊 50%"。
- A. 确认层级规则：评测迭代内统一并发 5；独立诊断 run（非评测迭代）沿用 ≤3 sub-diagnosis worker；dossier 增量再诊断预算规则不变；CONSENSUS 第一节第 22 条补注
- B. 全部场景统一 5
- C. 三处数字不改，按上下文各自解释

➡️ 推荐 A。

## D. Q116=B 自主监听模式的追问

❓ **Q118** - **自主监听下，什么消息才触发完整检索？**
- A. 两级门控：每条消息先过服务端廉价相关性过滤器（确定性规则+轻量相似判定，决策可审计），判定"任务相关新信息/状态变化"才触发三段式完整检索；消息风暴时限频合并（如同一 task lineage 每 N 分钟至多一次）；被过滤消息只进 MemoryTaskState 滚动上下文；阈值 workspace 可配
- B. 每条消息都跑完整三段式检索，Memory 自己判断停止
- C. 固定周期检索，与消息节奏无关

➡️ 推荐 A。

❓ **Q119** - **自主投递的节流与打扰控制？**
- A. 每任务投递治理：同一 task lineage 对同一 target agent 的未决（未 disposition）Hint 数上限（默认 2）、冷却窗口、同 provenance 去重（只刷新 TTL 不重发）；target agent 可声明偏好（defer-all、按类型过滤）；用户可要求静默；超时未处理只记 exposure（沿用 Q89）
- B. Memory 判断有价值就投递，不设上限
- C. 所有 Hint 投递前需用户确认

➡️ 推荐 A。

❓ **Q120** - **普通任务中 Memory 检索的预算与权限归属？**
评测迭代有父级总上限（Q58）；普通任务没有。
- A. workspace 级 Memory 服务预算独立记账（与 post_run 索引预算分开）；capability = 频道成员身份 ∩ 来源 session ACL；检索沿用 Memory profile 与配额；无 evaluation 父级时以 workspace 上限为父级，耗尽即本任务停止主动检索（可被 @memory 显式唤醒一次）
- B. 每次触发无上限
- C. 计入被投递目标 agent 的预算

➡️ 推荐 A。

## E. 架构决策

❓ **Q121** - **是否合并 L2 与 L3 为一层？**
（经双重独立评审，五面承重墙分析见 round-10-external-review.md / round-10-cursor-raw.md）
- A. 不合并对象模型，走中间路线：M1 检索/投影接口统一（统一卡片信封 schema + 分层配额表 + 单份 ranker feature spec，与 Q112-A/Q113-A 同一件事）；M2 influence_grounding 附带内容寻址冻结快照（view revision id + 位置 + 摘要 + hash）+ supersede/ACL 变化时 needs_revalidation 联动；M3 定位重述——post_run 视图是 AO 台账的派生**轨迹索引**、DIV 是诊断工作集，系统只有一层长期因果记忆（L3），写入拟议 ADR-0010；M4' 投影引用账隔离——投影命中只记索引级 exposure，不进 citation/utility/fork 聚合/簇/verified 通道
- B. 合并 L2/L3 为一个对象模型与一层生命周期
- C. 只做 M3 文档定位重述

➡️ 推荐 A。

❓ **Q123** - **future path 与影响图如何关联？**
（已澄清"反向索引"语义：正向=fork 自带 grounding 字段是权威数据；反向=倒排表 (view_revision_id, position)→fork 列表，outbox 维护的派生索引；效果是双向导航，语义刻意不对称——反向必须过 ACL、标"干预史"、绝不改变 Claim 状态）
- A. 不把分支写入影响图。对已是 influence_grounding 目标的 block|edge|cut 建反向索引；READ_VERIFY 可读对应 Fork/Branch 轻量摘要与该分支验证状态，单独标"干预史"；不改变 Claim 状态、不进 citation/utility；视图 supersede 或 ACL 变化走 needs_revalidation
- B. 真实/想象分支成为 Influence 节点出边，与 Claim 共用一套状态
- C. 不做反向索引

➡️ 推荐 A。

## F. ADR 立项

❓ **Q117** - **Round 9 的哪些决策集群立 ADR？**
（若 Q121=A，0010 内容扩展为含 M1-M4' 与定位重述）
- A. 立四个：0010 Influence View 层与 post-run 索引；0011 Hypothesis/EvidenceBridge 分型与假设图治理；0012 ForkRevision 三阶段生命周期与 Memory→Diagnosis→Memory 评测循环；0013 Memory 消费侧记账：Hint/Disposition/Followthrough/效用与 ACL-safe 聚合
- B. 一个大 ADR 包圆 Round 9
- C. 暂不立直接实施

➡️ 推荐 A。

---

## 答题模板（直接在下划线处填 A/B/C 或补充说明）

```
Q109: _
Q110: _
Q111: _
Q112: _（若 A，配额数字 6/4/2 是否调整：_）
Q113: _
Q114: _
Q115: _
Q117: _
Q121: _
Q123: _
Q118: _（若 A，限频窗口 N 默认值：_）
Q119: _（若 A，未决上限/冷却默认值是否调整：_）
Q120: _
```
