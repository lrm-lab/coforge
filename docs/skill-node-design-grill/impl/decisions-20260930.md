# 实现期代定决策 · 2026-09-30（续 #124、#125）

> 延续 `decisions-20260929.md`（#116–#123）。同一位授权：用户 2026-09-29「你来定吧」把实现期阻塞问题交给编排侧（ZCode）裁定，用户随后「让cursor继续」＝按既定波次推进。两条件均属**实现细节**：设计账本（`CONSENSUS.md` 叙述 1–106、#1–#115）没有规定，不定就写不下去。

## #124 Phase 2 的 adaptive 修订不与 Phase 1 fallback 撞 revision_id

**裁定**：post-run 视图在同一次 commit 里会有两条修订，身份分开——

| 构造 | `revision_id` | `construction_mode` | 子图 |
|---|---|---|---|
| Phase 1（`_index_commit` 的 `fallback_session`，无提供方时唯一路径） | `post-run:{session_id}:{task_run_id}` | `fallback` | 空 |
| Phase 2（`extraction_index_builder`，有提供方时） | `post-run:{session_id}:{task_run_id}:adaptive` | `adaptive` | 模型划定 |

`job_id` 两条都仍是 `post-run:{session_id}:{task_run_id}`（队列身份＝一次 commit 一个作业，不变）。

**理由（硬约束，不是偏好）**：

1. `ViewSupersedeIndex.register` 是**追加**语义，不按 `revision_id` 去重（`influence_view.py:1742-1748`）。沿用同一个 id 会在同一 `(session_id, purpose)` 键下留下两条同 id 修订。
2. `retrieval_facade._revision()`（`:1670-1683`）明确要求 id 唯一：**匹配到多条就直接抛** `view revision ... is not unique in the supersede index`。也就是说同 id 会让诊断侧（`retrieve_historical_subgraphs` 的第一步）对这份修订**永久报错**，不是「歧义」而是「读不了」。R6a 两个工具、`expand_causal_neighborhood` 的 `(view_revision_id, claim_id)` 兼容入口都走这个查找。
3. 叙述 74（Q111-A）要求「后续构建产生 superseding revision，旧 revision 保留为历史证据」。同 id 覆盖或改名去重都会破坏这一条；分开 id 则两条都在 `history` 里，`latest()` 自然返回后注册的 adaptive。
4. 内容寻址的幂等仍然成立、且语义更准：`_content_hash_registered_locked` 只比 `content_hash`（覆盖 blocks/claims/coverage/retrieval_subgraphs，**不含** `frozen_at`、`construction_mode`、`revision_id`）。同一路径重放同内容 → 不注册、不 supersede、不告警。

**代价（如实记）**：同一 task run 在索引里留两份修订，`revisions_for_purpose` 的候选集多一条 fallback 条目——fallback 无检索子图，永远不会成为诊断命中候选，只是白扫一遍。另：adaptive 与 fallback 的 `revision_id` 不同，`process_next` 会触发 `_notify_revalidation_locked(fallback_id)`，即每次成功 supersede 打一条 `needs_revalidation was not persisted` 告警——这正是 #119 记下的残留（该回调生产上仍无消费者），本波不新增消费者。

**残留（新增，低危）**：模型非确定性 + 同一 `task_run_id` 重放不同内容时，同一 id 仍会出现两条（`_content_hash_registered_locked` 只挡同内容）。这条**在既有 fallback 路径上本来就存在**（Phase 1 重放且台账变化时同 id 两条），不是本波引入；一并记进 `pending-design-decisions.md`，不自行改库语义。

## #125 本波不碰提取模型的输出契约；载荷产出契约与评测同批定

**裁定**：R6b 只做「插座 + 服务端调用点」，**不改** Phase 2 提取路径的 prompt／输出 schema。理由：

1. 设计把「谁写 blocks／claims／子图／失败标记」定成了提取模型（叙述 29／92／99，决策 #101／#108），但**没有规定模型吐出的契约**（字段名、怎么表达一个检索子图与失败标记）。这是模型面契约，不是接线细节。
2. 今天把模型输出变成 `ExtractionPayload` 需要动四处：生成的 operations 模型（`schema_model_generator.py:335`，`extra="ignore"`）、协议骨架（`extraction_output_protocol/json_protocol.py:80-93`）、指令正文（`session_memory/session_extract_context_provider.py:198-255`）、解析层的额外字段过滤（`session_memory/utils/json_parser.py:375-382`）。**这是改 prompt**，会改变既有长期记忆提取行为，应当与评测同批判定。
3. R6c 的评测复跑本来就要跑（`skill-node-design-grill/eval/`）。用插座 + 夹具载荷能先把读侧、诊断侧、门控全部量完；等评测有了基线，再决定契约长什么样、谁来生成。

**代价（如实记）**：本波之后，Phase 2 的带提供方调用在生产上**仍没有提供方**，只能由注入驱动（评测夹具、将来的跨仓库集成）。也就是说「adaptive 视图进 `views.json`」这条路是**可被注入、但生产尚空**——与 #119 记的残留是同一件事的下一层。

## 126（R6d 后裁定）：生产不给投影通道接 `content_resolver`，fallback 形状的投影卡保持「内容盲」

**依据（本波实测）**：投影文档 = 摘要 + card_id + semantic_type + resolver 给的 AO 正文（`retrieval_facade.py:1158-1164`）；fallback 的摘要是占位串 `segment <id> sequences a-b`（`influence_view.py:1661`）。生产唯一构造点 `retrieval_wiring.py:72` **不传 resolver**，`content_resolver` 在整个 `openviking/` 里只出现在测试与适配器自身。
**裁定的理由**：R6d 的对照臂给出了决定性读数——**同座位数下投影通道（15.4%@5／36.4%@10）与 atom 通道（15.7%／36.4%）打平**。给 fallback 形状接 resolver，等于让投影通道复制 atom 通道已经承担的正文匹配，**买不到可测的增量**；而自适应视图的摘要是模型写的、自带语义，不接 resolver 也仍可被 BM25 打中。**故：不接，记为可接受限制**（fallback 卡在无 resolver 时只有段 id 的 token 可匹配；内容由 segment_atom 通道承担）。
**代价与可逆性**：仅当将来出现「只查投影通道、不查 atom 通道」的 profile，或自适应视图摘要质量不足时，才需要回头接；届时接法是把带 ACL 的 AO 正文读取（`get_ao_evidence` 那类默认拒绝的入口）路由进 resolver，**不改本裁定之外的任何设计**。若真要接，注意正文会进 BM25 文档但**不会**写回卡片或 source_pointer（H1 已定的约束）。
**记账面**：`pending-design-decisions.md` 第 18 条。

## 127（R6e 后裁定）：L1 的主口径换成「候选池全局排序（max-BM25）」，旧口径只留作基线对照

**背景**：第 19 条记的口径伪影，R6e 用数据结案——同一候选池只换合并方式，A12 从 15.2%→59.0%@10，A4 从 36.4%→56.0%。旧口径「按关键词并集首次出现」把座位数折进了名次。
**裁定**：L1 的主口径＝**候选池按 max-BM25 全局排序**（dia 分数＝覆盖它的卡片里最高分；平局先按首次出现序、再按 dia id）；`legacy` 口径保留，只为与冻结基线 `eval/l1-locomo-hitk-full.json` 对账；`rrf`（k=60）作交叉检查但**不**作为主口径（实测低 4.6–6.9 个百分点）。池构建不变，只改名次。
**代价与可逆性**：主口径一换，历史数字（36.4% 那一族）不能与新数字并列陈述；`l1_locomo_hitk.py` 的冻结基线仍由 legacy 口径守（R6e 已复现 0%/56.0%/61.8%）。若将来要把 legacy 也换掉，必须同时换掉冻结基线文件并留档，属另一条裁定。
**记账面**：`pending-design-decisions.md` 第 19 条由此结案。

## 128（R6e 后裁定）：L1 上不再投「零 LLM 结构代理」；下一波加非饱和指标（全 gold 覆盖率）

**依据**：R6e 后 atom 通道 59.0%@10、词法参考 T 61.8%@10——**只差 2.8 个百分点**，而这 2.8 已是排序口径的极限；剩下约 38% 的题是词法根本不匹配。所以任何**词法手段**的结构代理（摘要截短、同实体桥……）在此指标上都测不出结构的价值，只会量到噪声。
**裁定**：原计划的 R6f「结构代理臂」**取消**（自证无效的测量不花一浪）。替代顺序：(A) 给 L1 增补**不被词法饱和的指标**——「全 gold 覆盖率@k」／平均覆盖率／MRR，复用现有候选池与各臂，零 LLM，作为 #125 的验收尺；(B) 设计**诊断侧离线评测**（失败→历史子图→fork 的召回，见 R4a）——那是结构的主场，词法基线不该白拿分，但必须标注「基于夹具」；(C) L2／L3 仍被 paused live 栈与模型额度挡住。
**理由面**：R6e 实测的 2.8 个百分点差就是这段推理的全部数字依据；详见 `R6e-verification.md` 第 5、6 节。

## 129（R7a 后裁定）：多证据题换尺子——按 gold 条数分组的覆盖率是能力判据，`any-hit@10` 降为陪衬

**背景**：#128 要求「增补非饱和指标」，R7a 做完了（`1f388e851`）。指标定义：`coverage@k = |gold ∩ 前 k| / |gold|`、`all_gold@k = 全部 gold 落在前 k`、`mrr = 前 10 内第一条 gold 的 1/rank`（`mrr > 0 ⇔ coverage@10 > 0`）。

**实测（n=1982，零 LLM，全量口径 `ranked`）**：

| gold 条数 | 题数 | A12 `all_gold@10` | T `all_gold@10` | A12 `coverage@10` | T `coverage@10` |
|---|---:|---:|---:|---:|---:|
| 1 | 1559 | 61.6% | 65.3% | 61.6% | 65.3% |
| 2 | 240 | 17.1% | 17.5% | 34.2% | 33.5% |
| ≥3 | 183 | 1.1%（2 题） | **0.0%** | 18.3% | 19.0% |

cat 1（multi-hop，282 题，其中 276 题是多 gold）：`all_gold@10` = A12 9.2%／T 9.6%／B12 6.4%；同一批题 `any-hit@10` = A12 47.5%／T 44.7%。

**裁定**：能力判据（含 #125 的验收）改为**按 gold 条数分组的 `all_gold@10` 与 `coverage@10`**，多跳读数取 **cat 1** 与 **`gold_n ≥ 2`** 两处；`any-hit@10` 保留为诊断量但**不单独作为能力判据**。

**依据（为什么必须换）**：`any-hit` 在两个子群上方向相反——cat 1 上 atom 的 `any-hit@10` 反超 T 2.8 个百分点（47.5% vs 44.7%），而 `all_gold@10` 是 T 略高（9.6% vs 9.2%）。同一个 59.0% vs 61.8% 的「2.8 个百分点差距」，在单证据上是「差 3.7 个百分点」，在多证据上是「都收不齐」。**一个混合平均同时掩盖了两种相反的事实**。

**代价与可逆性**：非饱和区（多证据）的绝对数很低（`all_gold@10` 1–17%），任何改动都容易在这上面「涨几个点」而带噪声（≥3 条那组只有 183 题、其中 T 是 0/183）。用它下结论时必须同时报题数与 `coverage@10`（部分覆盖比全收更稳）。旧的两张表（按 category 的 `any-hit`）继续保留在跑分输出里，不删。

**记账面**：`R0-wave-plan.md` 的 R7a 行；`R7a-verification.md` 第 6、8 节。

## 130（R7a 后裁定）：结构价值的测量位置——L1 fallback 视图里结构不在场，内容轴与结构轴要分开测

**依据（我自己的旁证探针，3 个会话的多 gold 题）**：把多证据题拆成「池召回」与「前 10 召回」两段（`pool_recall = |gold ∩ 候选池| / |gold|`，任何重排的上界）：

| 会话 | A12 pool／top10 | B12 pool／top10 | T pool／top10 |
|---|---|---|---|
| conv-26（38 题） | 31.4%／22.6% | 28.7%／20.6% | 39.5%／19.1% |
| conv-44（41 题） | 22.4%／12.4% | 23.0%／11.5% | 45.5%／16.7% |
| conv-49（51 题） | 41.1%／31.2% | 41.6%／30.6% | 56.1%／33.7% |

三条读数：(1) 多证据题的上界是**池召回**（A／B 22–42%），不是排序；(2) 12 座时排序确实丢 9–12 个百分点；(3) **T 的优势在池宽（它扫所有有词重叠的消息），它的排序损失反而是全场最大（20–29 个百分点）**。

**裁定**：L1 现行接线（fallback 视图＝一条消息一块、`claims=0`、**没有跨消息的边**）**在结构轴上无话可说**——因果通道的独门资产（顺链拉证据进池）根本没上场，所以：

1. **R7c（oracle 摘要臂）只测内容轴**：用数据集人工标注换块摘要，量「摘要内容值多少钱」，必须标成**乐观上界**（oracle，不是可达值）；它也**不能**用来论证结构价值。
2. **结构轴**两条路：(a) 带边的视图——即 #125 之后的模型写 claim／子图路线；(b) 诊断侧离线夹具（R7b，R3／R4a 起点）。两者都还没做，**这是当前「结构值多少钱」仍然无数字的唯一原因**，不是结构被证伪。
3. 若将来要在 L1 上测「顺链拉池」，评测臂需要**无座位上限或大座位**的对照（现口径的池 = 关键词数 × 座位数 ≤ 36 张卡，池召回被座位直接掐住）。

**记账面**：`R0-wave-plan.md` 的 R7c／R7b 行；`R7a-verification.md` 第 7、8 节。

## 131（用户 2026-09-30 要求后裁定）：skill benchmark 泛化测试的口径与三个缺口

**用户原话**：「让cursor测一下skill相关的benchmark，测试influence graph和fork的抽取，并看能不能泛化到新的任务」。派发件：`R8a-brief.md`。

**勘察事实（我逐条核过，不是推测）**：

| 事实 | 值 |
|---|---|
| 语料 | `evol_bench/SkillsBench/results/sb-train-wsb-dsv4flash-r1/work-warm-skill-batch/episodes/0001..0014`，14 个 train episode（42 个 train 题中只录了 14 个） |
| 轨迹规模 | 合计 **444 次工具调用**（单条 10–78），记录 23–161 条 |
| attempts 记录 | **只有 7 行**：5 recorded success（0002/0004/0005/0006/0007）＋ 2 recorded failure（0001/0003，`PI_CANCELLED: context deadline exceeded`，≈1800.03s＝agent 预算耗尽） |
| 其余 7 个（0008–0014） | **无 attempts 行**（该 run 08:01 被外部掐断；0014 的 transcript 是坏 JSON）。尾部形状：4 个在工具调用/结果处戛然而止（0008/0010/0012/0014），3 个以文本结尾（0009/0011/0013） |
| **裁决** | **零 grader 裁决**。`final_output` 是模型自己写的总结，不是判分；`grader` 字段只有验证器元数据 |
| 模型写的诊断 | 5 份（0002/0004/0005/0006/0007），全部结论 `NO_SKILL`；是**窄用途 prompt（skill 抽取门）的产物**，不是中性摘要，且**两个失败 episode 没有诊断** |
| 关键结构事实 | **`InfluenceClaim` 与 `RetrievalSubgraph` 至今从未在真实语料上被构造**——生产构造点只有 `influence_view.py:1573` 的 `_fallback_link`，其余全在 `tests/`。R7a 已给出原因：L1 fallback 视图没有跨消息边（#130） |

**裁定**：

1. **测试分三层**：L1 影响图抽取（每 episode 一个 adaptive 视图，走生产 `freeze_extracted_view`，**首次带 claims**）；L2 失败子图＋fork（走生产 `write_failure_subgraph_fork`，含幂等/ACL 负例/读回三门）；L3 **检索级**泛化（留一任务 n=14、跨 family 切片、45 个 test 题面），每问都配词法基线。
2. **抽取用确定性 stand-in，必须标注**。忠实版本（模型写 claim／子图）＝账本 #125 的提取模型调用，要**用户授权额度**；本波零 LLM、不调用任何模型，stand-in 的抽取质量本身作为读数报出。
3. **「泛化到新任务」在本语料上只能测到检索级**。任务成功率级的泛化需要 paused live 栈＋模型额度（`eval/NEXT.md` 的「不要动」清单），本波**不许碰**，只写成缺口。
4. **失败集两口径都报**：窄口径 = 2 recorded failure ＋ 4 打断 = 6；宽口径 = 再加 3 个「文本结尾但无记录」= 9。**`unrecorded` 一律不许写成成功或失败**——没有裁决就没有成败。
5. **跨 family 切片是判据所在**：R7a 教训（`R6e-verification.md` §5）是词法在饱和区测不出结构价值；能区分结构与词法的，只有「query 与答案无表面词重合」的那一片。若结构在该片不优于词法基线，**如实报**，那是合格结论。

**记账面**：`R0-wave-plan.md` 的 R8a 行；`R8a-brief.md`；验证后写 `R8a-verification.md`。若 R8a 证实「抽得出、写得出、但泛化不优于词法」，则结构轴的价值仍缺数字，下一步只剩 #125（模型抽取）或 R7b（诊断侧夹具）两条路。

## 132／133／134（R7c 验证后裁定）：内容轴结案、投影通道的惰性、卡片 id token 与控制门形状

派发件 `R7c-brief.md`；提交 `b86d566ee`（＋编排侧补的机械 lint 修复 `a550e3be0`）；独立验证见 `R7c-verification.md`。

**#132 内容轴结案（不是缺口所在）**。证据（n=1982，ranked）：T 61.8%@10／53.5% all@10／mrr 0.4346；A12（atom，12 座）59.0%／50.6%／0.3012；`oracle.no_resolver.12` 59.4%／49.9%／0.3160；`oracle.with_resolver.12` 61.1%／52.4%／0.3086；`oracle_only.with_resolver.12` 63.8%／54.6%／0.3679。三条读数：(a) 无 resolver 时唯一评分面是摘要，人工摘要与原文打平（49.9% vs 50.6% all@10）——**同座位下人写摘要换不来超过原文的收益**；(b) 最好摘要臂只在 hit@10／cov@10／all@10 高出 T 1–2pp，hit@5 与 mrr 明显落后（捞得全、排得后）；(c) 标注与问题同源（人写、措辞重叠），这是**乐观上界**。结论：**#125 的价值不在「摘要更好」，而在边与子图**，即 R8a 要测的东西。

**#133 投影通道在无 resolver 时是惰性的**。生产 fallback 块摘要是脚手架文本（`segment <id> sequences a-b`，`influence_view.py:1663`），而投影卡片的可评分内容来自 `summary` 字段，所以 `placeholder.no_resolver` 取回 0 张（除 3 题 `card` 撞 id）。这澄清了历史读数：**R6d/R6e/R7a 的 B 臂由 resolver 提供的原文驱动**，不是投影卡片自身摘要的能力。#126（生产不接 resolver）因此要补一句：生产接的投影通道在 fallback 形状下本来就没有内容可检索。

**#134 卡片 id token 与控制门的形状**。`_opaque_card_id` 返回 `{kind}-card-<hex>`（`influence_projection.py:147-160`），**每张投影卡片 id 都含字面 token `card`**，故任何含 "card" 的查询命中全部卡片。实测本题集 3／1982 题（conv-47/48/50），gold 命中 0、锚点臂数字零漂移。R7c 全量退出码 1 正是控制门「placeholder＋no_resolver 必须 0 张卡片」被这 3 题触发——**门想守的东西守住了**（控制臂 gold 命中 0），是门的表达形式过严。今后写法：**「placeholder 臂不得产生 gold 命中」**。与 R2b 修的 `payload_ref` 泄漏同类，记残余。

**记账面**：`CONSENSUS.md` #132/#133/#134；`R7c-verification.md`；`R0-wave-plan.md` 的 R7c 行结项。

## 135–139（R8a 验证后裁定）：抽取侧成立、L3 尺子作废、fork 语义收窄、证据门缺口、lint

派发件 `R8a-brief.md`；提交 `9494708c2`（只新增 `benchmark/causal_memory/sb_influence_extraction.py`，1954 行）；独立验证见 `R8a-verification.md`。用户口径：编排侧只做总体调度与独立验证，仓库改动一律交给 cursor（本条之后的机械修复也走 cursor）。

**#135 抽取侧成立（这是本波真正的收获）**。四处独立复算全部对上：逐 episode 的 block／influence／skip／`omitted_between_claims` 我从原始 `2*.jsonl` 自己实现规则重数 14/14 逐格一致、工具调用 444 次一致；人口数（5 success／2 failed／7 unrecorded）我从 `attempts.jsonl` 自己读，与报告 0 处不一致；15 个 fork 用生产 `CausalExperiencesStore.get_fork_node`／`get_revision` 读回，七个 section 与我自己的重算逐字段相等、字节数逐行相等，锚点 15/15 ＝「子图 failure 证据 ＝ 时间上最后一个 block 的 AO」且被 position block 覆盖，无 `imagined_*` 证据类别；两次独立运行（我的 work dir `/tmp/zcode-verify/r8a-mine/` 与 cursor 的 `/tmp/sb-influence/`，`work = args.out.parent` 互不覆盖）report 递归比对 **0 差异**。意义：`InfluenceClaim`／`RetrievalSubgraph` 第一次在真实语料上被构造，生产校验链在 20–158 block 规模上零误拒，跨 episode／跨 family 的 facade＋投影注册＋fork serving 端到端可用。

**#136 L3 的数字不可报（尺子不合格，不是实验失败）**。两条独立缺陷，都是我自己量化出来的：
1. **容量不对称**。`_card_patterns` 给 fork/branch 卡片的是**整条 `tail_patterns`**（≤12 block 全集）、给 block/claim 卡片的是该 block／claim 的 pattern 列表，而 `_lexical_hits` 写死 `"patterns": [item["pattern"]]` 恒 1 个。实测结构卡片 pattern 数：均值 1.70／中位 1／**最大 6**，单 pattern 卡片占 54%。把结构臂每张卡片削到 1 个 pattern：中性（取首个）**154 → 116/218＝53.2%**，事后最优（取能命中的那个，乐观上界）**149/218＝68.3%**，词法保持 103/218＝47.2%。**51 个优势里约 38 个只来自「一张卡片带多个 pattern」**。
2. **键太粗**。`pattern = {tool}:{command 首词}`，全语料 **41 个键／444 次事件**；`run_command:cd` 163 次（36.7%）＋`bash:cd` 120 次（27.0%）合计 **63.7%**；一张「只含最高频 pattern」的卡片单独命中 **77/218＝35.3%** 的后半段事件；上界（后半段 pattern 在语料中存在的比例）197/218＝90.4%。也就是说这个指标在量**工具词汇重合**，不是因果价值：命中一个 `bash:cd` 说明不了任何事。
结论：结构臂高出词法臂的部分可由容量与键粒度解释，故 L3 现在只能读作「**接口跑通**」（45 个 test 题面能取回 540 张卡片／180 张 failure-fork 卡片，是接口演示而非泛化指标）。重测规则进 R8b，且**先冻结再打分**：同容量臂（1 pattern／卡片，中性＋上界并报）、词法臂给到与结构臂**相同数量的不同 pattern**、只换 family 的对照臂、以及「只含最高频 pattern 的卡片」这条平凡基线；更彻底的修法是更细的 pattern 键作为**并存变体**报告（不替换原键）。

**#137 fork 的 failure 语义收窄**。narrow 6 个 episode ＝ transcript 结束在工具交换中途（4×`cut:toolCall`＋2×`cut:toolResult`），wide 再加 3 个；2 个 `recorded failed` 的 error 都是 `PI_CANCELLED: context deadline exceeded`（agent 超时），另 7 个无裁决。**这里的 failure ＝ 轨迹被截断，不是答错**。引用 6/9 必须带这句，否则会被读成失败归因；这也解释了 `subgraph_rule` 为什么把失败锚点定义成「截断邻域」。

**#138 生产证据门缺口（R8a 自身安全，#125 之前收口）**。`validate_view(draft)` 签名里没有台账 ⇒ 结构上不可能校验 evidence 的台账可解析性；它只查「跨 omitted 的 skip 两端必须有证据」与「有 failure 标记必须有证据」。探针（`/tmp/probes/r8a_forge_evidence.py`）：伪造 influence claim 的 `source_evidence_refs[0].ao_id`＋`evidence_content_hash` → **冻结成功、`validate_view` 零告警**；伪造子图 `failure_evidence_refs[0].ao_id` → **冻结成功**；对照（伪造 claim 端点 block id）→ 被 `dangling_claim` 拒，说明门不是坏的、是缺台账。写方 `write_failure_subgraph_fork` 从 `failure_evidence_refs[0]` 取锚点但不校验 position 覆盖锚点，调用方自带 `position_ref` 时伪造锚点的 fork **真的被写了**（`ad3069ac-…`）；`default_failure_grounding_position` 会抛 `covered by 0 blocks`，而 R8a 的 `_fork_payload` 先调了它 ⇒ **R8a 的 15 个 fork 安全**。裁定：收口成本低，做**不动签名**的那一半——让 `write_failure_subgraph_fork` 内部校验 position 覆盖锚点，并加一条负例测试证明伪造锚点写不进去；给 `validate_view` 补台账属于签名改动，留给 #125 落地时一并做（那时模型才会写幻觉证据）。进 R8b。

**#139 lint**。10 处 `E402`（`sys.path` 注入后 import）；同目录 `l1_locomo_*.py` 干净。进 R8b 做机械修复，并用「重跑 report 与 `9494708c2` 产物 0 差异」证明无行为变化（R7c 的 `a550e3be0` 同法）。

**记账面**：`CONSENSUS.md` #135–#139；`R8a-verification.md`；`R0-wave-plan.md` 的 R8a 行结项并新增 R8b 行；R8b 派发件 `R8b-brief.md`。

## 140–143（R8b 验证后裁定）：检索级负结果、锚点缺口收口一半、R7c 残留结案、lint 哈希级证明

派发件 `R8b-brief.md`；提交 `28cea1478`（E402）＋`20175df19`（同容量臂／细键／锚点校验）；独立验证见 `R8b-verification.md`。产物三次独立运行哈希一致（`4193af1d…` 时代与 `1d7e401e…` 时代各一次我自己的重跑）。

**#140 检索级负结果（这是本波要的答案）**。用户的问题是「能不能泛化到新任务」。修好尺子后的回答是：**在本语料＋零 LLM 词法尺子下，检索级泛化测不出因果子图的价值**，三条独立证据同向：
1. **削减规则决定分数**。把结构臂每张卡片削到 1 个 pattern：中性（排序后第一个）116、中性（自然顺序第一个）146、事后最优上界 **154 ＝ full**。`oracle == full` 说明**多 pattern 卡片在「多带 pattern」上贡献为零**；而 146 与 116 的 30 次差只取决于「留下哪个 token」——自然顺序留下的是 142 个 pattern 里 79 个 `bash:cd` ＋ 24 个 `run_command:cd`（73%），正是覆盖 63.7% 事件的那两个键。
2. **同族排除后优势消失**。报告给了「同族排除＋全 pattern」＝结构 135 vs 词法 136；我补算了缺的那个决定性组合「同族排除＋cap1」＝**128 vs 136**。0009 是活标本：全语料结构 19、同族排除后 1，而词法两处都是 19；0013 镜像相反。
3. **细键压差距，且平凡基线反超**。细键（`{tool}:{首词}:{第二词}`，词表 114）下结构 42 vs 词法 26（粗键是 51）；而**一张只含 `run_command:cd:root` 的卡片得 32 > 12 座词法臂 26**。一个硬编码 token 打败一整条检索臂。

裁定：本语料上**不再调这把尺子**（再调就是凑数）；结构轴的价值**既未被证实也未被证伪——它没被测到**（尺子量的是工具词汇重合）。下一步只有两条路，且都不要「跑一把看看」：**R7b（诊断侧夹具）**必须先定**查询表示**（否则诊断侧查询同样退化成 shell token，词法照样白拿分）；**#125（模型驱动抽取）**需要用户的模型预算授额。R7a/R7c/R8a/R8b 四波对检索级的累计结论应表述为「**L1 侧的因果通道在词法可达范围内没有余量**」。

**#141 #138 收口一半**。写方已加锚点校验（`position_kind="block"` 时 position 必须覆盖 `failure_evidence_refs[0]`，不动签名）；同一探针前后对照：伪造锚点修复前**写入成功**、修复后**抛错且零写入**。负例测试入 tests（16 passed），正例 15 个 fork 读回一致。`validate_view` 无台账那一半留给 #125。

**#142 R7c 残留结案**：159 可复现，是**我**上次扫错字段（`qa.evidence` 而非 `conv["observation"]`）。五项数字（159／538／750／2531＋10／5882＋40.0%）与检查点全同，`R7c-verification.md` 的怀疑撤回。

**#143 lint**：10 处 E402 修复后，产物与 R8a 时代**逐字节相同**（哈希一致，跨三次独立运行）；顺带发现 `20175df19` 对 `subgraph_forks.py` 做了 `ruff format`（该文件此前就有格式漂移），无害但扩大了审阅面，以后同类拆分进单独提交。

**两条编排侧的自我更正（记在案，供流程参考）**：① R8a 验证件 §4.1 曾把「51 个优势里 38 个」归因于每卡片 pattern 容量——实为我的探针用了 `sorted(patterns)[:1]`，真机制是「留下哪个 token」（见 #140）；② R7c 验证件曾把 159 记为「未复现」——实为我读错字段（见 #142）。两次都是**验证脚本自身的口径**出错，不是被测物出错；说明验证结论也必须写清「我按哪个口径算的」。

**记账面**：`CONSENSUS.md` #140–#143；`R8b-verification.md`；`R8a-verification.md` §4.1 就地更正；`R0-wave-plan.md` 的 R8b 行结项并写入「下一步只有 R7b／#125 两条路，且 R7b 先定查询表示」。

## 144–145（R7b 设计，2026-10-01）：诊断侧查询表示与判别力尺子

用户 2026-10-01：「按你的建议来」（＝先做 R7b 的查询表示设计，不花钱、不占模型预算，再派实现）。

**#144 查询表示**。诊断侧检索的 query ＝ **失败子图本身**（发起方的冻结修订＋失败子图＋AO 台账＋workspace 标签），**七段／branches／guidance／诊断结论都不进**。理由：那些是诊断的产出，不是输入；塞进去就变成「两边都在比模型写的文本」，正是 R8b 踩过的坑。现场事实（我逐条读过代码）：生产诊断侧通道**本身就是词法通道**——`RetrievalSubgraphAdapter.retrieve_historical_subgraphs` 用 `_subgraph_retrieval_text`（**明确丢弃** roles／relation types／failure marker／ids／原始 AO 文本）跑 BM25，且该文本表示自标 `SUBGRAPH_TEXT_POLICY_VERSION = "subgraph-text-pending-v0"`、R4a 派发件写明是「实现侧占位，不是已定设计」。所以本波的干净提法是：**把生产丢掉的那些字段拿出来，问它们能否表达散文表达不了的区分**。

**#145 尺子**。诊断侧**无裁决**（2 个 `recorded failed` 都是超时、7 个无裁决、无修复链）⇒ 不复用「哪条臂赢」。L1＝**规则生成**的受控对（散文逐字节相同、只改类型化字段），四轴 `boundary`／`anchor_incidence`／`coverage_crossing`／候选侧 `overlaps_anchor` 都取自设计既有概念；三个探针：洗牌（塌回随机带）、散文互换（词法跟散文、结构不跟）、隔离（签名无散文 token＋词法臂真调生产）。L2＝真数据切片只报排名一致性与分歧点归因，一致就写「惰性」。L3＝只产对 `SUBGRAPH_TEXT_POLICY_VERSION` 的决策输入，**不改生产代码**。所有标签要求写进派发件：L1 一律标「基于夹具，判别力 ≠ 效果量」，报告不许出现「结构臂更好」。

**记账面**：`CONSENSUS.md` #144／#145；`impl/R7b-design.md`（设计正文）；`impl/R7b-brief.md`（派发件，已派 cursor）。

## 146–148（R7b 验证，2026-10-01）：通过；三处判决锐化

cursor 提交 `8d3c25a97`（只加 `r7b_discriminability.py`＋`r7b_structural_signature.py`，`openviking/`＋`tests/` 零改动）。我的独立验证（`R7b-verification.md`）：

**#146 机械部分全部复现**。三次独立运行（cursor 两次＋编排侧一次，各用不同 `--out`／work dir）产物**逐字节相同** `2c77d55f…`；洗牌统计我用同一 `random.Random(20261001)` 自己重跑 1000 次，`mean=0.501833`／`repeat0=0.416667`／分位 `[0.291667, 0.708333]`／带 `[0.295876,0.704124]` 逐位相同；L2 的 **6 查询 × 5 候选结构名次我用自己按规则文本实现的六条冻结规则重算，30/30 相同**。候选池只有 5 的成因我查到了：**只有 narrow 6 份主修订在 `revision` 载荷里带子图**，其余 8 份 `retrieval_subgraphs` 为空（`0009／0011／0013` 的子图只在 `revision_wide` 里）⇒ 5 个候选是整个池子，不是抽样。归因复核：把类型化字段全部钉死后，唯一会动名次的加权字段是 `relation_profile`（`0001`=(8,2) 且 skip 边在索引 2,3,5,6；其余五个 (10,0)），`member_gap` 六个值都不同但人人都在扣、不重排，余下的分歧是平局规则 `(session_id, subgraph_id)`。

**#147 表示缺口（要带进 #125 的发现）**。设计 §3 要 `boundary` 承载 R8a 的 `cut:toolCall`／`cut:toolResult`／`text_end`（「死在等结果」≠「死在没发出去」）。实现的规则是「尾部角色 ＋ 前一块到尾块的影响边」：尾部非 `agent_action` → `text_end`；是 `agent_action` 且有条 influence 边 → `result_cut`；否则 `call_cut`。真切片上 narrow 6 个尾部**全是 `result_cut`**，而 R8a 逐 episode 是 `cut:toolCall`×4（0001／0003／0008／0012）＋`cut:toolResult`×2（0010／0014）——我核到块一级：两种尾块角色都 `agent_action`、都有那条 influence 边，区别只在**块摘要散文**（`pattern:bash:cd …` vs `tool_result exit_code: 0 …`），而签名按隔离要求不读散文。⇒ 轴 A 负极 `call_cut` 在真数据上**无实例**、夹具读数**不可外推**；轴 B 正极 `influence_both` 同理。要这个区分就得让**抽取侧**写成类型化字段。

**#148 读法约束**。L1 的查询**就是**正极（`query`／`pos` 同一次 `_pole(positive)`＋同源散文）⇒ 结构列 24/24 只是匹配器敏感性；24 对散文逐字节相同 ⇒ 生产 BM25 必然打平 ⇒ 名次由夹具会话名前缀（`p-` 正极／`n-` 负极）决定，**每对都是 `neg` 排第一**，故词法列只有 top-3=1 与 MRR=0.5000 可读（证明「散文相同时生产通道别无信号」，不是「词法臂差」）。L2 池子 6×5，Spearman 绝对值不作结论。

**记账面**：`CONSENSUS.md` #146–#148；`impl/R7b-verification.md`；`R0-wave-plan.md` 的 R7b 行结项、累计结论行改为「下一步：① #125（要模型预算授额，兼收 #138 剩半）② 若要结构轴先让抽取侧把截断种类写成类型 ③ R7d 待用户确认」。

## 149–152（R8c 设计，2026-10-01）：把「截断种类」写成类型化字段，用 R7b 的尺子重测

用户 2026-10-01：「让cursor来做吧」（在我给的两条候补里＝**不花模型预算**那条：收口 #147；#125 仍等模型预算授额）。

**动机**。#147 查明：设计 §3 要 `boundary` 承载 R8a 的 `cut:toolCall`／`cut:toolResult`，但视图里 `tool_call` 与 `tool_result` **都是 `agent_action`**，区别只在块摘要散文里 ⇒ 真切片 6 个尾部全被标成 `result_cut`（4 个 R8a 记的是 `cut:toolCall`），轴 A 的负极**在真数据上没有实例**。本波把「抽取侧已经算出来、又被视图丢掉」的事实写成类型，然后看 `boundary` 能不能按设计意图恢复、真切片上生产丢掉的字段里还剩几个非恒定。

**#149 生产 schema（加性）**。`InfluenceBlock.block_kind: str = "unknown"`（**留默认值**：10 处构造点只有抽取侧需显式传，R7b 两件与 7 个测试文件字节不动）；`BLOCK_KINDS`＋`BLOCK_KIND_ROLES`；**一致不变量**——新字段是 `role` 的**细化**不是并列信息，`validate()` 要求 `block_kind != "unknown"` 时 `BLOCK_KIND_ROLES[block_kind] == role`，冲突即拒；`unknown` 只用于旧载荷缺键；`to_dict`／`from_dict` 往返。**`retrieval_facade.py` 一行不动** ⇒ 词法通道看不见新字段。

**#150 抽取侧只传不推**。`item["kind"]` 是 parse 期（`:634-655`）与尾部判定（`:693-701`）算出来的，AO 台账 action 载荷里本来就写着 `block_kind`（`:752`）；构造 `InfluenceBlock` 时传下去即可（`:822-867` 是漏传点）。**禁止重新推断**（不读摘要、不看 `pattern:` 前缀、不从 `role` 反推）。

**#151 三条铁丝**（新文件跑，R7b 两件字节冻结）：① 打分规则未漂——v1 检查点上重算的结构名次与 R7b 报告 **30/30 全等**；② 词法通道看不见新字段——14 条 `_subgraph_retrieval_text` 在 v1／v2 载荷上**逐条哈希相同**；③ 接线判据——`boundary_v2` ＝ R8a `tail_shape` **14/14**（这条是接线正确性，两者同源，报告不许写成「结构臂更准」）。另报新字段分布与 v1／v1+新字段两套名次（消融）。

**#152 不做／不许读成**。不做 `position_kind="cut"` 的语义落地、不做 `validate_view` 台账校验（仍留 #125）、不动 `l1_locomo_hitk.py`；**不许**把「新字段在真切片上非恒定」读成「结构有价值」（仍无裁决无修复链、池子 6×5）；L1 标「基于夹具，判别力 ≠ 效果量」，L2 只报分布与一致性。

**记账面**：`CONSENSUS.md` #149–#152；`impl/R8c-design.md`（设计正文）；`impl/R8c-brief.md`（派发件，已派 cursor）。

## 153–156（R8c 独立验证，2026-10-01）：加性字段成立，两处外溢进判决

cursor 交回 `7bafc6324`（生产＋抽取＋新测试）＋`19c8cf934`（新尺子），合起来 4 个文件，未 push。我按「查 diff 只限加性、三条硬门自己复算、测试两个提交对照、报告里每条数字」全套验完：**通过**。

**#153 判定**。生产 diff 是**字面加性**（`influence_view.py` 23+/0−）；抽取是**透传带 fail-fast**，词表来自画布尾部改写（不是 R8c 的推断）；**抽取与尺子各三方独立运行逐字节相同**（`790f9d2f…`／`c1f19e2e…`，`TOOL_CALLS_SUM` 444 与 R8a 对上）；三条硬门自算成立（v1 检查点结构名次 30/30、检索文本 v1／v2 14/14 哈希相同、`boundary_v2` 与 R8a `tail_shape` 14/14）；878 块不变量 0 违例、878/878 旧载荷读成 `unknown`；受影响区同一命令 HEAD 238 通过／基线 234 通过、0 失败；3 个收集错误两提交相同，`influence_view.py` 的 C420 与 format 漂移在基线就在。**我的口径更正**：硬门 ③ 的 14/14 是**修订级尾部**的陈述（8 份修订没有子图；我最初按子图成员取尾块只得到 6/14，是我错）。**未能复现的一处**：cursor 说相关集里有 1 项 `acl …warns_once` 失败、撤掉本波改动也失败——我这一轮跑的任何子集都是 0 失败，如实记录差异，结论不变（可复现的比较里两边都 0 失败）。

**#154 外溢一：15/15 条 fork 的 `content_hash` 都变了（报告未提）**。v1↔v2 抽取报告递归比对只有两类差异：新键与全部 fork 的 `content_hash`。机制＝`compute_content_hash` 覆盖 `[block.to_dict() …]`。身份（`fork_revision_id`）／幂等键／`fork_node_id` **0 变化**，`l3`／`control` 深度相等，15 写→9 节点不变。判定：内容哈希的正当行为，非 bug；但**外部可见**——跨版本比对不能拿哈希当锚。

**#155 外溢二：报告的消融没覆盖「类型化边界进签名」**（两列都把 `boundary` 钉在 v1）。我补算：6/6 查询同类 top-1、与 `rank_v1_plus` 列差 14/30 个名次、`0001` 一行五候选同分 14 靠平局规则（会话名序）；反向记：`v1+` 列在 `0001` 上会选出异类 `0010`，换类型化边界才扳回同类 ⇒ 非惰性，但**仍不是效果量**。

**#156 残留**：`block_kind` 只有抽取侧写；生产 fallback（`build_minimal_fallback_view`、`_with_diagnosis_root_sink`）落 `unknown`，而 `trajectory_index.py:518`／`extraction_write.py:168` 会走它 ⇒ 那些视图合法但类型字段全空；「新草稿不许 `unknown`」靠抽取脚本 fail-fast 而非生产不变量；`orchestrator` 在本语料 0 实例。`position_kind="cut"` 的锚点语义仍未做（本波只类型化了块级种类）。

**记账面**：`CONSENSUS.md` #153–#156；`impl/R8c-verification.md`（含提交审计、三方哈希、硬门 1–4 复算、消融复算、外溢两条、测试与 lint 对照）；复算件 `/tmp/probes/r8c_gates.py`、`r8c_gates2.py`、`r8c_ablation.py`、`r8c_v2rank.py`、`r8c_lexical_arm.py`，重跑件 `/tmp/zcode-verify/r8c/`。

## 157–163（R9：#125 抽取模型的输出契约，2026-10-01）：先做零模型那半边

用户 2026-10-01「可以」（在我把 #125 要预算授权与 R7d 要不要做两条摆出来之后）。我把 R9 立起来并**冻结了设计**（`impl/R9-design.md`），派发件是 `impl/R9-brief.md`。核心判断：**#125 现在能做的、且能独立验收的一大半是零模型调用**——契约与管道。真模型的冒烟单独一次、有界、要用户点名提供方。

**#157 走 Phase 2 专门调用**。长期记忆提取那条路的四处过滤（`extra="ignore"`、协议骨架、指令正文、L3 过滤器）**一行不改**：改它会改掉所有用户的长期记忆行为且**无法**被 `skill_trajectory_mode=causal` 门住。代价（causal 模式每次 commit 多一次调用）只在**显式注入提供方**时发生；本波不读配置、不建 `ov.conf`。

**#158 契约「只选不造」**。身份（AO 区间、`ao_id`、`snapshot_watermark`、`inspected_ao_ids`）必须能在快照里查到；**只有 `evidence_content_hash` 要模型回抄**（「它确实读了给你的行」的唯一可检证据）；**派生字段一律不问模型**（块的 `source_refs`／`source_content_hashes`、证据的其余七字段、coverage 的两个区间表全由解析器从快照算）——问模型要输入已经决定的事，只会引噪声。块＝同 participant 同 segment 的连续且互不重叠区间；失败标记仍只由模型写。

**#159 输入＝台账本身，提供方的形状是「工厂」**。模型看的是钩子已经分页的那批行的冻结投影（形状无关地保留键、规范顺序、逐值截断 ＋ 六字段投影 zip 原始行），不加新数据源、不走 ACL 闸门、不加读取次数。**改设计的一处**：我原稿要给 `Builder`／`ExtractionProvider` 加第 4 个位置参数让台账进 builder，动手前查了测试面——`tests/test_trajectory_index.py` 有 15 处三参 builder，加了就全断；于是改为 `ExtractionProviderFactory = Callable[[Mapping[str, Any]], ExtractionProvider]`，钩子在同一处 `provider = factory(snapshot)` 后走**一字不改**的 `extraction_index_builder` ⇒ `Builder`／`ExtractionProvider`／`_build_locked`／`extraction_write.py`／`trajectory_index.py`／`set_extraction_provider` **全部零改动**，既有测试一行不改。快照 dict 加 `ledger_rows` 新键（加性 ⇒ fallback 视图逐字节不变，水位算法仍只用六字段投影算，否则会改所有 fallback 的 `content_hash`、破坏 `(session_id,purpose,content_hash)` 幂等）。

**#160 #138 后半在提取侧输入边界收口**。对账放在解析期（`ao_id` 在不在快照、回抄哈希对不对、水位对不对、`inspected_ao_ids` 是否 ⊆ 快照、区间是否连续且互不重叠、claim／子图成员是否都已声明），任一条不成立即 `ExtractionContractError`，**不修、不部分接受、不降级**。`validate_view(draft)` 签名保持无台账（纯结构门）——能查台账的地方只有提取侧。手写草稿直调 `freeze_extracted_view` 的残留照旧存在，如实记账。

**#161 标记存模型写的，台账事实只进报告**（报一致率）。**#162 测量计划**：先三门零调用（往返 14/14、拒绝矩阵全拒零写入、无提供方时生产零变化＋禁令路径 0 行 diff），真模型跑到后只报合规率／丰度／标记一致率／成本，**不报检索价值**（#140 未被推翻，真切片仍无裁决无修复链）。**#163 不做**：四处不碰、`validate_view` 不改、不读配置、不接 `content_resolver`、不做 `position_kind="cut"`、不做 R7d，六个禁令文件一行不改。

**预算信封（要用户点一次）**：`--mode fake` 零调用（随本波交付）；`--mode model` 最多 14×(1+1) 次调用，`max_tokens` 与整轮 token 上限写成冻结常数、**触上限即停下报数**。**本环境没有模型提供方凭据**（只有 `CURSOR_API_KEY`，`ov.conf` 不存在且我不建）⇒ 要真跑，请点名提供方（模型名）＋凭据怎么进。

**记账面**：`CONSENSUS.md` #157–#163；`impl/R9-design.md`（设计正文）、`impl/R9-brief.md`（派发件，已派 cursor）；`impl/R0-wave-plan.md` 的 R9 行与累计结论 ①。

## 164–167（R9 独立验证，2026-10-01）：零模型半边成立，两处洞当场派修

cursor 交回 `a5ac33a37`（生产契约＋接线＋测试）＋`22ccf40f1`（跑分件），6 个文件 ＋2489／−15，未 push。我按老规矩全套验：**主体通过**，并且**又逮到两处报告没说的洞**（都和 R8c 那次同一性质：门绿了，但绿在没有覆盖的地方）。

**#164 通过的部分**。生产 diff 只三处加性；`Builder`／`ExtractionProvider`／`_build_locked`／`trajectory_index.py`／`extraction_write.py` 零改动（工厂形状 —— 我原设计要加第 4 个位置参数，动手前查出会打断 15 处三参 builder 用例，改设计后交回件正是工厂）。往返门我**连跑两次**，`report.json` SHA256 `29b8f36e…` 与 cursor 所报**逐字节相同**。**我另写一份只照设计文本的编码器**（`/tmp/probes/r9_my_encoder.py`），把 14 份 JSON 喂给**生产**解析器与 `freeze_extracted_view`，再用**我自己写的**递归比对器（自测过：顺序洗牌判等、植错逐路径报出）与画布比 ⇒ 四段 payload 逐路径全等、两次冻结同哈希。**我自己写的 5 个端到端篡改**（经完整钩子接线）与 **9 个解析器级篡改**全部被拒、视图存储零新修订、对照 payload 解析通过。测试同一命令：HEAD `2 failed／79 passed` vs 基线 `2 failed／35 passed`，同两条 caplog 失败（基线就在），差额 44 ＝新测试。三条预检（我在派发后、交回前自己跑的）：coverage 两张表可从块区间复算 **14/14**、分页台账复现画布身份 **14/14**、画布词表审计（`evidence_role` 1634/1634 同一常数）。**顺手查出一条实现陷阱并写进设计**：原始台账行**没有 `content_hash` 键**，模型输入必须从六字段投影取哈希。

**#165 洞一：往返门是闭路**。`snapshot_from_revision()` 从画布 `inspected_refs` **合成**快照并写死 `captured_state="committed"` ⇒ 14/14 不覆盖「真台账 → 契约」，而且把一处真实差异盖住了：我换真台账快照后 **1634/1634 条证据 ref** 不一致——画布是常数 `committed`、台账行是 `live`。判定**不是缺陷**（两值都合法、视图侧不校验词表、无下游分支；解析器按台账行推导更诚实），该改的是跑分件：加 `--snapshot-source {canvas,ledger}` 并把差异**显式报出**。

**#166 洞二：真跑会把 token 报成 0**。调用不传 tools ⇒ 两个生产后端返回裸字符串 ⇒ 响应无 `usage` ⇒ `_account` 取到 0，而用户的预算按 token 算。正路：用量记在**句柄**上（`_token_tracker`，公开 `get_token_usage()`），取前后差值即可。**同批查出的好消息**：`_run_completion` 的「线程里 `asyncio.run`」桥在生产**一定**被走到（`resume_queued_commit` 是 async），但安全——OpenAI 兼容后端按事件循环缓存客户端（`LoopScopedAsyncClientCache`）、litellm 每次建短命客户端；日后接持有主循环客户端的后端才会炸，记在案。

**#167 残余**：`captured_state` 跨版本比对不可当锚；身份子串规则是**既有生产锐边**（短身份串误伤，如 `task_run_id="t"` 时 `sg-tail` 被拒，交回件忠实镜像，非本波引入）；未知键严格拒绝属设计要的 fail-closed，但真跑时装饰性多余键会吃修复额度；本波**一次模型都没调**（环境无凭据），真跑要用户点名提供方＋凭据，且只报合规率／丰度／标记一致率／成本。

**处置**：`impl/R9-fix-brief.md` 已派 cursor（零模型调用，只动跑分件／生产模块的记账／测试）⇒ 待验证。**记账面**：`CONSENSUS.md` #164–#167；`impl/R9-verification.md`（含提交审计、往返门复现、真台账交叉复算、拒绝矩阵、端到端、测试对照、残余六条）；复算件 `/tmp/probes/r9_*.py`。

## 168–170（R9-fix 独立验证，2026-10-01）：两处洞都堵上，代码里长出来的边界也都读过了

**#168 交回件成立**。`d51684adc`（父 `22ccf40f1`）3 个文件 ＋695／−28：跑分件 424／生产契约 131／测试 140，**禁令路径 0 行 diff**（`l1_locomo_hitk.py` 字节不变、无 `ov.conf`、`influence_view.py`／`retrieval_facade.py`／`extraction_write.py`／`trajectory_index*.py` 一行未动）。生产侧那 131 行**只改记账**：`_account` 加前后读数、`_measured_usage` 定优先级（响应 `usage` 优先，否则**句柄差值**），**没有放宽任何校验**——三处冻结上限的检查一字未改。**最强证据**：`report.json` **整文件 SHA256 仍是 `29b8f36e08370b05a2577daf76e0473e1f84e09920ef6f86938f629ba5fff7e5`**（画布列逐字节未动 ⇒ 生产推导没被顺手改）。受影响区同一命令 HEAD **2 failed／84 passed** vs 基线 **2 failed／35 passed**（差额 49 ＝契约测试文件，同两条既有 caplog 失败）；`ruff check`／`format --check` 对三个改动文件全过。

**#169 台账列按 #165 的要求落地，我把结论钉死到直方图**。`--snapshot-source {canvas,ledger}` 只对 `--mode fake` 生效；台账列用**生产分页**建快照（不是画布合成），`captured_state_delta = {"canvas": "committed", "ledger_rows": "live", "refs": 1634}` **显式报出**。我拿报告逐条 diff 数：台账列 **1634 条 diff 全部落在 `captured_state` 路径上，其余 0 条** ⇒ 真台账快照下四段 payload（`blocks`／`claims`／`coverage`／`retrieval_subgraphs`）与画布**语义全等**，唯一差异就是那一处、且不再被合成快照盖住。缺台账目录 ⇒ 退出码 **1**、报「拒绝退回画布快照」（我第一次用管道量的退出码，`$?` 取到的是 `tail` 的——重测不带管道才是 1，记下来）。

**#170 `--mode model` 与三条读数边界**。① **模型模式无画布回退路径**（我最后一条开放问题）：`run_model_episode` → `episode_snapshot()`，那条路**先往真台账写**（`sb._append_ledger`）再分页／投影／算水位；`snapshot_from_revision`（画布合成）**只**被 `_run_fake_file` 调；`snapshot_from_ledger` 缺目录／缺文件即抛；`--mode model` 无句柄时**退出码 2、明说不退回 fake**。② 我自己的句柄桩探针 5 条全对：`handle_tracker` 差值 50／30／80 → `total=80`；纯 `unavailable` **报字符串而非 0 当花费**；响应 `usage` **优先于**句柄；超上限抛 `ExtractionLimitError`。③ 聚合侧不把残缺求和读成总数：`_aggregate_tokens` 只要有一个 episode 没测到就整体返回 `unavailable`。

**两条新残余**（照写）：(a) **`unavailable` 的那次调用不吃累计上限**——`_account` 在 `MAX_TOTAL_TOKENS` 检查前就返回（单次上限仍在：`max_tokens` 照发、`finish_reason=length` 照抛）。**非本波引入**（修前 usage 恒 0 同样不触发累计上限），且真跑时两个生产后端都有句柄计数 ⇒ 走的是 `handle_tracker` 路；(b) **`--mode model` 的控制台回声**仍打印 `snapshot_source=<参数值>`（默认 `canvas`），而 JSON 报告**没有这个字段**、路径也证过无回退 ⇒ 只是控制台一行措辞的口径问题，留作下次顺手修。**§167 的六条残余不变**（其中 `--mode model` 仍**一次未真跑**）。

**记账面**：`CONSENSUS.md` #168–#170；`impl/R9-verification.md` §7（提交审计、两条发现的收口、我自己的句柄桩探针、测试对照、新残余）；`impl/R0-wave-plan.md` 的 R9-fix 行（已翻成「已验证」）与累计结论 ①。

## 171–175（R9m 真模型跑通，2026-10-01）：模型写出的真边与真子图落地，两条缺口待裁定

用户指令：「模型驱动抽取，写真正的边和子图」。这是 `--mode model` 的**第一次真跑**（#167 残余⑥ 就此关闭）。

**#171 成立，且有独立验证**。14 集 → **10 集写出真视图**（67 块／**58 条真边**／10 子图／**155 条证据 ref**），4 集被**生产视图规则**拒；`repairs=0`、`truncated=0`、`usage_source=handle_tracker`、**494,146 tokens**（另冒烟 3 次 210,394）。生产侧：真台账 → 生产投影 → 真模型 → **fail-closed 解析** → 生产冻结 → supersede 注册。**我的独立验证**：把每集**保留的模型原始响应**用**生产解析器**重解析、用**生产冻结器**重冻结，与视图存储里的修订 **`to_dict()` 相等 10/10**；155 条证据逐条在真台账上复算（存在性／推导哈希／`sequence`／`session`／水位／`captured_state`）**0 例外**；67 块（连续／同 participant 同 segment／不重叠／区间自洽）**全过**；4 个失败集在视图存储里**零修订**、读路径照常 fallback；标记一致率 **7/10**（0002／0006 模型标失败而台账尾非切、0008 反之）。

**#172 两条缺口，我一条没自行改**。**A 通道叙述前缀**：14 次响应 **11 次**在 JSON 前带 25–93 字符叙述（仅 0003／0008／0014 纯 JSON）⇒ 生产「只接受 JSON」＋1 次修复额**拦得住修不回**（#170 的 0002 两次都带叙述），**严格口径约 3/14**；但**剥掉前缀后 0002 的响应体被生产解析器接受**（10 块／9 边／2 子图）⇒ 病灶在**通道包装句**、不在模型产出。本轮处置＝**操作侧适配器剥离并逐条记账**（前缀字符数／原文／原文哈希进 `call-record.json`），**生产解析器一个字没放宽**。取舍：(a) 维持严格＋剥离留适配器〔本轮〕(b) 生产 prompt 写死「首个字符必须是 `{`」(c) 解析器接受文本里唯一的 JSON 对象 —— **建议 (a)＋(b)，不建议 (c)**。**B 契约门与视图门之间没有修复机会（4/14 死在这里）**：4 集全是同一视图规则 `omitted_range_skip_required`——两块之间存在**被略去的行**时，连接它们的边**必须** `relation_type=skip`，模型写了 `influence`；而 `render_contract_prompt` **从没讲过这条规则**（只列「influence, skip」两个值）、`parse_contract_response` 也**不查** ⇒ 修复额（只对解析期 `ExtractionContractError` 触发）用不上。取舍：(a) prompt 写清 (b) 解析期镜像该规则并抛 `ExtractionContractError` 让修复轮用上 (c) 两者都做 —— **建议 (c)**。

**#173 四条模型行为事实**：① `block_kind` 一律 `unknown`（输入每行的 `action.block_kind` 里就写着 `tool_call`／`tool_result`，67 块里 62 块写 `unknown`；prompt「unknown is allowed with any role」在邀请它跳过类型化）② `inspected_ao_ids` 只声明自己引用的行（0001 声明 28、块覆盖 82；契约只要求「证据 ⊆ 声明」）③ **子图没有选择性**：10 集全是「1 个子图包住全部块」⇒ 作为检索单元不携带额外信息 ④ **块粒度是宏观阶段**（每集 4–10 块 vs 画布 82 块量级）。

**#174 R9m-fix（`42d4400e1`）经独立验证**：首跑暴露「一集失败拖垮整轮」（`run_model_episode` 不接异常 ⇒ 14 集在第 2 集终止、报告零字节），修后**单集隔离**（失败记 `compliant=False`＋`error.{type,message}`＋当时的 calls/repairs/usage，整轮继续写报告）、汇总加 `failures`／`failed_episodes`、模型模式如实写 `snapshot_source=ledger`。**我独立验**：两条零模型**字节钉仍在**（canvas `29b8f36e…`、ledger `4cddafd2…`）、禁令路径 0 行、ruff 过；**我自己的两个探针**——(A) 假句柄对全部 14 集返回非 JSON ⇒ 28 次假调用、14 条失败记录、报告照写、退出码 0；(B) 0002 真实响应回放 ⇒ 记成失败不崩。**两处口径更正**：(i) `test_stub_vlm_token_cap_raises` 原 6 行被改是**行为变更的必然结果**（cursor 主动说明），新断言＝失败记录三要素，且提供方层另有上限用例保住牙齿；(ii) 那两条 caplog 用例今天**三棵树全通过**（HEAD／`42d4400e1~1`／R8c 基线，含隔离运行）而上午两次都是 2 failed ⇒ **对日志环境敏感、非本波引入**，#164／#168 的结论不变。

**#175 模型通道现状（影响后续所有派发）**：**Cursor 计量额度本月耗尽**（Sonnet／Gemini／GPT-5.x／Opus 全拒，**重置 2026-10-21**，本机仅 `composer-2.5` 与 `cursor-grok-4.5-high` 可跑，本轮全用后者）；**GLM 无可用量**（pay-as-you-go 429 余额不足；两把 coding-plan 密钥四种协议组合全 401）；**未碰** `credentials.json` 里的 `oauth:*` 活会话令牌。凭据只从环境文件进、不进 argv。

**记账面**：`CONSENSUS.md` #171–#175；`impl/R9m-model-run.md`（跑通记录：结果表、独立验证七类、两条缺口、四条行为事实、环境事实、不许读成、产物路径）；`impl/R9m-fix-brief.md`＋`R9m-fix-cursor-raw.log`；`impl/R0-wave-plan.md` 新增 R9m 行与累计结论 ①；产物 `/tmp/r9m/corpus/`、`/tmp/r9m/calls-corpus/`、复算件 `/tmp/probes/r9m_verify.py`、`/tmp/probes/r9m_run.py`。
