# 子图检索实现波次计划（R 系列）

日期：2026-09-29。编排：ZCode；实现：cursor-agent。设计依据：`skill-node-design-grill/CONSENSUS.md` 叙述 86–106 / 决策表 #95–#115，`CONTEXT.md` 检索术语，`handoff-subgraph-retrieval-20260929.md`。

实现仓库：`/home/zhoujie22/river2_0/OpenViking`，分支 `feat/causal-subgraph-retrieval`（从 main 切出）。不 push。

## 现状（2026-09-29 勘查）

- 整套 causal 子树（`influence_view`、`influence_projection`、`trajectory_index`、`retrieval_facade`、`causal_*`）**只有测试和 benchmark 在调用**，没有生产入口；`TrajectoryIndexService` 没挂到 session commit。
- 已存在：`influence_view.py` 的 block/claim/coverage/skip 校验（含 `omitted_range_skip_required`）、`SKIP`/`INFLUENCE` 词表、`InfluenceViewRevision` 冻结与 content_hash、投影与 6/4/2 配额常量、`expand_claim_neighborhood`（库方法，按 `view_revision_id + claim_id` 取参）、`VerifiedSimilarityEdge`/簇存储。
- 缺：BM25（今天是子串匹配＋常数分）、fact 通道暂停、fork 卡片的七段／分支摘要、检索子图（子图概念本身没有）、失败标记、诊断子图命中、跨任务子图相似检索、`TrajectoryIndexService` 的接线。
- 偏差：fork 与 branch 共用一个 6 的语料配额（设计里也是"fork/branch"一个语料，保持）。

## 波次

| 波 | 内容 | 决策 | 状态 |
|---|---|---|---|
| R1 | 初排 BM25／混合档、fact 通道暂停、邻域展开只走 influence | #95 #96 #97 #115 | 完成 `988148ad8`，已验证 |
| R1b | CJK 分词修正（R1 暴露：`\w+` 把整段中文当一个 token，违反 Q127-A） | #95 | 完成 `12f783d19`，已验证 |
| R2 | fork／branch 卡片带七段快照与分支动作摘要；展开工具改成按 claim 投影卡片 id 取参、只挂 Memory Agent | #113 #114 #98 | 完成 `c63995f8e`，已验证 |
| R2b | 卡片 id 改成不透明确定性哈希（R2 暴露：id 里带 view revision 与 claim id） | #98 #66 | 完成 `145adc72b`，已验证 |
| R3 | 检索子图：提取模型把动作划成子图写入冻结 view、失败标记随子图写入（不铸 subtask_id） | #101 #103 #104 #107 #108 #110 #111 | 完成 `63c915d5a`，已验证（`R3-verification.md`） |
| R4a | 诊断子图检索（读）：语料＝历史 post_run_index 视图上的子图，只由失败子图发起，最多 3 份命中、不足不回填、旁路子图不返回、每份带该子图内接地的 fork（七段＋分支摘要） | #101 #102 #103 #104 #113 | 完成 `3cb319824`，已验证（`R4a-verification.md`） |
| R4b | 每个失败子图各写一份普通 fork（不合成一份、不绑同一次结果；无失败结果的子图不写；任务级结论不单独再检索）＋ R4a 暴露的两处小修（查询侧 ACL、`_revision` 报错） | #105 #106 #107 | 完成 `ef21efb8c`＋`32218e516`，已验证（`R4b-verification.md`） |
| R5a | 把 `TrajectoryIndexService` 挂到 session commit：Phase 1 钩子（causal 门、legacy 无副作用）、真实 AO 台账进 fallback 视图、落盘路径约定、入队与 `process_next(policy)` 驱动 | #82 #83 #110 #111 #112 | 完成 `e298e0158`，已验证（`R5a-verification.md`） |
| R5b | 提取模型写入侧：把模型给的 blocks／claims／coverage／子图＋失败标记落成 `adaptive` 冻结视图；`Builder` 插座（配了提供方才生效） | #101 #108 #110 #111 #112 | 完成 `8f6b4efdc`，已验证（`R5b-verification.md`） |
| R5c | 生产侧标签来源（#116/#117）＋ `ProjectionRegistry` 接线（含 supersede 撤卡）＋ revalidation 回调接线 ＋ fork 写入侧的门（#118） | #82 #85 #86 #116 #117 #118 | 完成 `17d6310ba`，已验证（`R5c-verification.md`） |
| R6a | 读侧接线：门面构造（`retrieval_wiring`，fork store 根＝owner user 根）＋ 两个 MCP 工具（`retrieve_causal_cards`／`expand_causal_neighborhood`，调用期门控）＋ 记数与 skill 文档；只增不改 | #93 #96 #97 #98 #120 #121 | 完成 `f9ec022f9`，已验证（`R6a-verification.md`） |
| R6a-fix | 卡片解析补 principal 门（展开侧漏了；我实测 intruder 拿到 entities=2／edges=1） | #116 #117 #123 | 完成 `a3977bbe3`，已验证（`R6a-fix-verification.md`） |
| R6b | 诊断侧接线：Phase 2 增加**带提供方**的同一次钩子调用（#119＋#124 的身份）＋ 诊断子图检索与 fork 写入的服务端调用点（不进工具面，#122）；模型输出契约不在本波（#125） | #101 #105 #106 #107 #119 #122 #124 #125 | 完成 `2619df677`＋`5aebd83cb`，已验证（`R6b-verification.md`） |
| R6c | L1 离线 zero-LLM 评测**复跑＋归因**：HEAD 与 base 在参考臂 T 上逐行相同；P 臂 0%＝fact 通道暂停（#87/#88）、掰回开启后 15.2% vs base 17.3%＝BM25 取代子串初排（#86）。**未改 `benchmark/` 任何文件** | #86 #87 #88 | 完成（`R6c-l1-rerun-20260930.md`） |
| R6d | 给**因果通道**出第一个离线数字：新增同目录跑分件（既有基准文件逐字不动）把「确定性 fallback view ＋ 注册 `ProjectionRegistry` ＋ resolver」接起来，profile 带投影座位（评测方案 arm B）。**结果：B = hit@5 15.4%／hit@10 36.4%（306／722 of 1982），空并集 0；P 仍 0%（#87/#88 暂停）、T 仍 56.0%／61.8%** | #86 #87 #88 | 完成 `fbb816f50`，已验证（`R6d-verification.md`；含我另跑的同座位 atom 对照与全量逐题复现） |
| R6e | 修尺子：新增「候选池全局排序」（max-BM25）口径，保留旧口径对照，同尺重测 atom（4／12 座）与投影（4／12 座）。**结果：A12 15.2%→**59.0%@10**（T 61.8%）；座位 4→12 由 −21pp 变 +3.0pp；投影比同座位 atom 低 2–3pp** | #127 #128 | 完成 `60bed6d6e`，已验证（`R6e-verification.md`） |
| ~~R6f~~ | ~~零 LLM 结构代理臂（摘要截短／同实体桥）~~ **取消**：#128——L1 指标已被词法打到天花板（59.0% vs T 61.8%，差 2.8pp），词法代理测不出结构价值 | #128 | 取消（理由见 `decisions-20260930.md`） |
| R7a | L1 增补**非饱和指标**：全 gold 覆盖率@k／平均覆盖／MRR，复用现有候选池与各臂（零 LLM），作为 #125 的验收尺。**结果：单证据（n=1559）A12 `all@10` 61.6%（T 65.3%）；2 条证据（240）=17.1%（T 17.5%）；≥3 条（183）=1.1%（T 0.0%）。cat 1 multi-hop 的 `all@10`＝A12 9.2%／T 9.6%，而 `any-hit@10` 是 47.5%／44.7%** | #128 | 完成 `1f388e851`，已验证（`R7a-verification.md`；中途被 CLI 断网打断，续跑后全量重跑） |
| R7b | **诊断侧离线评测**（失败子图 → 历史子图／fork 召回；结构的主场）：设计 `R7b-design.md`（裁定 #144／#145）——查询表示＝失败子图本身（不含模型文本）；尺子＝规则生成的**判别力夹具**（散文逐字节相同、只改类型化字段，四轴取自设计既有概念）＋真数据切片，三探针（洗牌／散文互换／隔离），一律标「基于夹具，判别力 ≠ 效果量」，不改生产代码。**结果（`8d3c25a97`，已验证 #146–#148）**：三次独立运行产物逐字节相同 `2c77d55f…`；结构臂夹具判别率 1.0、洗牌均值 0.501833 落在冻结带内、散文互换词法 24/24 跟散文而结构 0/24、隔离 0/304 token；**真切片上生产丢掉的字段（boundary／角色／覆盖／fork 种类）全是常数**，唯一会动名次的是 `relation_profile`（`0001`=(8,2) vs 其余 (10,0)）与平局规则，池子只有 6 查询 × 5 候选。**两处判决锐化**：L1 的查询**就是**正极（构造等价，只算敏感性测试），词法列的 0 来自等散文打平后被夹具命名序决定；**`boundary` 实现拿不到设计 §3 要的 `cut:toolCall`／`cut:toolResult` 区分**（两种尾部都是 `agent_action`），轴 A 负极在真数据上无实例、不可外推 | #128 #130 #144 #145 #146 #147 #148 | 完成 `8d3c25a97`，已验证（`R7b-verification.md`） |
| R7c | **oracle 摘要臂**：用数据集自带人工标注（`observation` 锚到 `dia_id`）当块摘要，量「摘要内容值多少钱」（**只测内容轴**，视图仍无边）——oracle／oracle_only／placeholder 三变体 × 有／无 resolver × 4／12 座，锚 T／A12 的 any-hit **与新指标**（cov@10 54.3%、all@10 50.6%）。**乐观上界，须标「oracle」**；含断点续跑。**结果：内容轴结案（#132）——人工摘要与原文打平（`oracle.no_resolver.12` all@10 49.9% vs A12 50.6%），最好臂只在 hit@10／cov@10／all@10 高出 T 1–2pp、hit@5 与 mrr 落后；并暴露投影通道无 resolver 即惰性（#133）与卡片 id 的 `card` token（#134）** | #128 #126 #129 #130 | 完成 `b86d566ee`＋`a550e3be0`（机械 lint），已验证（`R7c-verification.md`） |
| R8c | **类型化 `block_kind`＋尺子重测**（收口 #147；用户 2026-10-01「让cursor来做吧」，走不花模型预算那条）：生产侧只做加性字段 `InfluenceBlock.block_kind`（默认 `unknown`、与 `role` 的一致不变量、不动 `retrieval_facade.py`），抽取侧把 parse 期已有的 `item["kind"]` 传下去（禁止重新推断），新跑分件在**不改 R7b 两件**的前提下重测：硬门 ① v1 检查点上结构名次与 R7b 报告 30/30 全等 ② 14 条 `_subgraph_retrieval_text` 在 v1／v2 载荷上逐条哈希相同 ③ `boundary_v2` ＝ R8a `tail_shape` 14/14；另报新字段分布与 v1／v1+新字段两套名次（消融）。设计 `R8c-design.md`、派发件 `R8c-brief.md`。**结果（已验证 #153–#156）**：三条硬门自算全部成立（30/30、14/14、14/14）、878 块不变量 0 违例、旧载荷 878/878 兼容、受影响区 0 失败；**#147 的类型侧缺口已填**（真切片上 `call_cut` 4 个／`result_cut` 2 个，不再是 6 个 `result_cut`）。**两处补记**：加性字段让 **15/15 条 fork 的 `content_hash` 漂移**（身份／幂等 0 变化，跨版本比对不能拿哈希当锚）；报告的消融**没覆盖类型化边界**那一列，我补算＝6/6 同类 top-1、与 `v1+` 列差 14/30 个名次、`0001` 一行靠平局规则 | #147 #149 #150 #151 #152 #153 #154 #155 #156 | 完成 `7bafc6324`＋`19c8cf934`，已验证（`R8c-verification.md`） |
| R7d（候补） | **扩池上界臂**：突破产品座位预算（如座位 64 或「关键词全部候选入池」），量「把证据拉进池」的天花板。依据 R7a 实测多证据题池召回只有 22–42%，池宽被座位预算掐住 | #130＋待设计项 20 | 待裁定（要用户确认才算不越设计；产品默认不动） |
| R8a | **skill benchmark 上的影响图＋fork 抽取与跨任务泛化**（用户 2026-09-30 要求）：把 SkillsBench 录制轨迹（14 个 train episode／444 次工具调用）抽成带关系边的影响图（**第一次在真实语料上构造 `InfluenceClaim`／`RetrievalSubgraph`**），对打断 episode 写 failure fork，再测**检索级**泛化（留一任务、跨 family 切片、45 个 test 题面），全程零 LLM、只读、词法基线对照。**结果：抽取侧全部成立（#135）——14/14 冻结零误拒、444 次调用与人口数逐格复现、15 个 fork 七段与锚点独立读回一致、两次独立运行 0 差异；但 L3 泛化数字作废（#136），尺子两处缺陷：每卡片 pattern 容量不对称（削到 1 个 pattern 后 154→116／上界 149，词法 103）＋ pattern 键只有 41 个／444 事件（两个 `cd` 键覆盖 63.7%，单个最高频键单独命中 35.3%）；并查出生产证据门不查台账（#138）与 fork 语义＝截断非答错（#137）** | #132／#133（内容轴结案、投影惰性）＋ #131（本波口径）＋ 待设计项 20 | 完成 `9494708c2`，已验证（`R8a-verification.md`），裁定 #135–#139 |
| R8b | **重测 L3（先冻结再打分）＋收口证据门＋机械 lint**：同容量臂（每卡 1 pattern 的中性／oracle 上界）、词法同容量臂、只换 family 对照臂、最高频 pattern 平凡基线、更细 pattern 键并存变体；`write_failure_subgraph_fork` 内部锚点校验（不动签名）＋负例测试；10 处 `E402` 机械修复；R7c 残留重数。**结果：尺子修好后是清晰的负结果（#140）——检索级测不出因果子图价值：削减规则决定分数（116／146／154＝full，摆幅 30 次命中）、同族排除即消失（135 vs 136，补算 128 vs 136）、细键压到 16 且一个 token 的卡片 32 > 词法 26。锚点缺口收口一半（#141，前后对照探针证伪→拒绝）。R7c 的 159 结案（#142，是编排侧读错字段）。lint 哈希级证明（#143）。两条自我更正记在案** | #136 #138 #139 #134 | 完成 `28cea1478`＋`20175df19`，已验证（`R8b-verification.md`），裁定 #140–#143 |
| R9 | **#125 抽取模型的输出契约（先把零模型调用那半边做完并验收）**：用户 2026-10-01「可以」授权立起。生产侧**新增** `openviking/session/extraction_contract.py`（「只选不造」JSON 契约：身份抄输入、派生字段不由模型写、解析器在**提取侧输入边界**逐条对账 ⇒ 收口 #138 后半；＋模型提供方**工厂**）；接线只三处加性（钩子留 `ledger_rows`＋`extraction_provider_factory`、`session.py`／`session_service.py` 透传），**`trajectory_index.py`／`extraction_write.py`／`Builder`／`ExtractionProvider`／`_build_locked`／`set_extraction_provider` 零改动**（原设计要给 `Builder` 加第 4 个位置参数，实测会打断 15 处既有三参 builder 测试 ⇒ 改成工厂）；新跑分件 `r9_model_extraction.py`：`--mode fake` 往返门（画布 14 个 payload 编码成契约 JSON 再经**生产**解析器冻结 ⇒ 与画布修订语义相等）＋拒绝矩阵＋假 VLM 单 episode 端到端；真模型 `--mode model` **要用户单独点名提供方与凭据**（本环境无模型凭据）。设计 `R9-design.md`（#157–#163）、派发件 `R9-brief.md` | #125 #138＋#157–#163 | 完成 `a5ac33a37`＋`22ccf40f1`，**已验证（`R9-verification.md`；裁定 #164–#167）**：往返门我复现逐字节相同（`29b8f36e…`）、另写编码器经生产解析器与真台账快照交叉复算、自写 14 个篡改用例全拒且零写入、测试两树对照、三条预检 14/14 |
| R9-fix | **补上「真台账」那一列 ＋ 真实 token 记账**（我独立验证时发现的两处洞，都零模型调用）：`--snapshot-source {canvas,ledger}`（台账列用生产分页建快照、`captured_state` 差异 **1634/1634** 显式报出，不用合成快照盖住）；响应无 `usage` 时从**句柄** `get_token_usage()` 取差值、报告加 `usage_source`。设计依据 #165／#166 | #165 #166 | 完成 `d51684adc`，**已验证（`R9-verification.md` §7；裁定 #168–#170）**：画布列逐字节未动（整文件 SHA256 仍 `29b8f36e…` ＝生产推导没被顺手改）、台账列 14/14 且我数出 1634 条 diff **全是 `captured_state`**（其余 0 条）、缺台账退出码 1、我的句柄桩探针 5 条全对、`--mode model` 证过**无画布回退路径** |
| R9m | **真模型跑通：模型写出的真边与真子图**（用户 2026-10-01「模型驱动抽取，写真正的边和子图」；`--mode model` 的**第一次真跑**）。模型通道＝**Cursor CLI**（本机唯一可用；操作侧句柄，生产零改动）；全程真台账＋生产 fail-closed 解析＋生产冻结。**结果：10/14 集写出真视图（67 块／58 条真边／10 子图／155 条证据 ref），4 集被生产视图规则拒，0 修复、0 截断、494,146 tokens**；独立验证：模型原始响应经生产解析器＋冻结器重放与存储修订 **10/10 `to_dict()` 相等**、155 条证据在真台账上复算 **0 例外**、67 块区间全合法、失败集**零修订**、标记一致率 7/10。**两条缺口待用户裁定**：A 通道叙述前缀（11/14 响应带 25–93 字符前缀 ⇒ 严格口径约 3/14；操作侧剥离并逐条记账，生产解析器未放宽）＋ B 契约门与视图门之间无修复机会（4/14 死于 `omitted_range_skip_required`，prompt 从未讲这条规则、解析期也不查）。配套 `R9m-fix`（`42d4400e1`）**单集隔离**已验证 | #125 #167 #170＋#171–#175 | 完成（实验，2026-10-01）：`impl/R9m-model-run.md`；裁定 #171–#175；**grok-4.7 换模轮跑完（#179）：表面 3/14，但 9 集是被记账上限杀的、其中 7 集视图本身能过生产冻结器** ⇒ 上限不咬时 4.7 也是 10/14（与 4.5 同分）；本通道把 xhigh 推理算进输出（中位 36,264 vs 上限 32,768），换 4.7 要么换低推理档、要么改冻结常量（须裁定）。另更正 #173 ①② 的数字（实为 43/67 与 17/85）** |
| R10（已设计，待裁定） | **影响图记忆 → SkillsBench 任务通过率的端到端测量**（用户 2026-10-01「能开始测吗」）：把生产因果读路径以**外部 memory plane 适配层**（GMS 形状的 `/v1/recalls`）接进 bench-runner（`--gms-url`，**Go 侧不改**），三臂配对 `cold`／`our`／**`placebo`（错配记忆）**，判读规则先冻结（`our − cold > 0` 且 `our − placebo > 0` 才算有用）。分级 S0（1 任务接缝烟测）→ S1（15 任务 × 3 臂）→ S2（45 × 3）。**已证前置**：官方 verifier 今天可用（两个 test 任务 `solve.sh→test.sh` 各 reward 1.0、22 s、零 token）。设计 `R10-design.md` | #140 #177 #182 | **接缝已证通**（2026-10-01 探路波：最小桩＋两臂各 1 集真跑，四条硬门我逐条重算全过；`memory_gain=0.0` 是 n=1 易任务的必然、不是读数）⇒ **用户已裁定两条（#183）**：模型用同 provider 的 **`DeepSeek`**（旧 id 已被网关下线，报告须标注与 9 月 campaign 不可比）；**磁盘已清：20→52 GB 可用**（98%→93%，R10 保留集镜像原样保住）。**只剩规模未决**：S0＋S1（推荐）vs S2 全量 |
| —— | **L1 侧检索级的累计结论到这里为止**：R7a/R7c/R8a/R8b 四波合起来说明「因果通道在词法可达范围内没有余量（内容轴 #132、结构轴 #140）」。**R7b（诊断侧）已做完并验证（#146–#148）：结构字段在这份语料上的产量也到此为止**——夹具上匹配器读数干净（判别率 1.0、洗牌落带、词法跟散文／结构不跟、隔离 0 泄漏），但**真切片上生产丢弃的字段全是常数**，只有 `relation_profile` 这一处 skip 计数会动名次，池子只有 6×5。**下一步三条（都不要再「跑一把看看」）**：① **#125 模型驱动抽取**——唯一还没被否掉的方向：**R9 主体已完成并验证（2026-10-01，`a5ac33a37`＋`22ccf40f1`，裁定 #164–#167）**：零模型的契约与管道半边成立（往返门 14/14 我复现逐字节相同、拒绝矩阵全拒零写入、假工厂端到端落地），**#138 剩下那半已在提取侧输入边界收口**（解析期对账：未知 `ao_id`／回抄哈希不符／水位不符／划分不自洽一律拒），R9-fix **已补并验证（`d51684adc`，裁定 #168–#170）**：真台账那一列 14/14 且 1634 条 diff 全是 `captured_state`、token 记账改走句柄差值且未测到时报 `unavailable` 不报 0；**真模型的冒烟已跑（R9m，2026-10-01，裁定 #171–#175）**——14 集里 10 集写出真视图（58 条真边／155 条证据 ref 全部在真台账上复算通过），4 集被视图规则拒，`repairs=0`、494,146 tokens；**但只到此为止**：模型写的边与子图**没有进过任何检索面**（`retrieval_facade` 一行未动），#140 未被推翻，且**两条缺口要用户裁定**（通道叙述前缀怎么处置、契约门与视图门之间要不要给修复机会）；② **类型化结构轴：R8c 已完成并验证（#153–#156）**——`block_kind` 进了生产 schema，`boundary_v2` 按设计意图恢复（真切片 `call_cut` 4／`result_cut` 2），但**只到接线正确为止**：类型化字段仍不进检索文本（门 ② 的 14/14 是不变的证据）、`position_kind="cut"` 的锚点语义仍未做、fallback 视图无类型字段（#156），真切片仍无裁决无修复链 ⇒ **结构轴的效用问题依旧未被测量**；③ R7d（扩池上界）仍候补，要用户确认 | #132 #140 #146 #147 #148 #125 #138 | 待用户裁定方向（或授权后派发） |

## 待设计确认（实现侧发现，未自行改设计）

**2026-09-29 起：用户授权编排侧代定。已裁定的八条写入 `CONSENSUS.md` #116–#123，理由与后果见 `decisions-20260929.md`**：#116 标签来源＝`user:{user_id}`（依据 `R5c-acl-source-recon.md`）、#117 不新建检索侧 ACL 开关、#118 `workspace_id` 语义＋fork 写入侧加门、#119 提取模型由 Phase 2 调用、#120 读侧以新增 MCP 工具接入（不改 `search`／`find`）、#121 fork store 根＝owner user 根、#122 诊断侧不做成工具、#123 按卡片 id 解析一律过 principal。下面第 5、8 条由此结案。

- 混合权重：R1 用了向量 `0.75`／BM25 `0.25`，标 `HYBRID_FUSION_POLICY_VERSION = "hybrid-fusion-pending-v0"`。决策 #95／叙述 86 只要求合成一个名次，没给权重与公式。
- 子图内 block 上限 12 的施加点（写子图时校验 vs 命中时裁剪）：R3 brief 按 #104 读成写时校验，待确认。
- 失败标记与「结论块规则」的关系：叙述 94（Q142-B「含 conclusion 块即失败子图」）与叙述 99／#108（显式标记由提取模型写入）措辞不一致，`CONTEXT.md`「失败标记」的 `_Avoid_` 把「只用角色为 conclusion 的块」列为反模式。实现按显式标记走，待确认。
- `SegmentAtomAdapter` 卡片的 `payload_ref` 仍是 `{kind}:{session_id}/{ao_id}`（`retrieval_facade.py` 约 1336 行），与 R2b 修掉的卡片 id 是同一类泄漏，但属 fact 通道（已暂停）。R6 接线前需要一并处理。
- 失败子图与结论块的关系（详版见 `R3-verification.md`）：叙述 94／#103「含 conclusion 块即失败子图」与叙述 99／#108「标记由提取模型显式写入」并存；R3 按 #108 ＋ `CONTEXT.md` 实现，`is_failure` 只读 `failure_marked`。要定 #108 是否取代 #103，或必须两条同时成立。
- 「子图内 block 不超过 12」的施加点：R3 做成冻结前拒绝（`subgraph_block_limit`）。若 12 只约束检索交回的历史子图，写时拒绝比决策表更严。
- 诊断侧子图相似度：设计只说「子图对子图模糊相似」，没给相似度算法、也没说用什么文本代表一个子图；且现有 `_embedding_stub` 维度为 0，没有真实向量可用。R4 需要在既有设施里选一个做法并明确标成「实现侧占位」，不是已定设计。
- 历史语料是否只召回「带失败标记的历史子图」：R4a 的语料是 `post_run_index` 上**全部**子图（只有查询侧要求标记），与 Q143 例子和 `CONTEXT.md`「诊断子图命中」措辞一致；若设计本意相反，是文本没写清。
- **fork 写入路径不带 ACL 门（R4b 暴露）——已结案**：#118 定了 `workspace_id` 的生产语义（＝该会话 owner 标签），R5c 在写入侧加了 `workspace_labels` 门（`17d6310ba`），我实测跨 workspace 已写不进去。
- 两份失败子图共享同一个失败 AO 时，落到同一个 fork 节点的两条 revision（既有「同锚点复用」规则），而不是两个 fork 节点。#106「各写一份」没说这种情况算一份还是两份。
- **跨 commit 的内容寻址幂等（R5b 暴露，我实测）**：两个不同 commit 的提取载荷逐字相同时，`(session_id, purpose, content_hash)` 撞上，只留先到的那份修订，后一次任务运行**没有自己的当前修订**。R4a 的诊断按 `view_revision_id` 取查询修订，此时只能退回先到那份（载荷相同，语义等价，故判低危）。要定：幂等该按内容还是按「每次 commit 一份」。
- **自适应路径不受台账对账（R5b 实现侧选择）**：`freeze_extracted_view` 只做结构校验，不检查块引用的 AO 是否真在台账里、覆盖清单是否与台账区间一致。设计说提取由模型给出，但没说要不要与台账对账。
- **插座只服务 post-run（R5b 实现侧边界）**：`extraction_index_builder` 固定 `purpose=post_run_index`；`TrajectoryIndexService._build_locked` 只校验返回修订的 `session_id`／`task_run_id`，不校验 `purpose`。今天只有 post-run 一条入队路径，无实际影响；若有诊断侧作业走同一插座需先补校验。
- 子图 id 卫生是大小写敏感的整段子串比对（对 `session_id`／`task_run_id`／`view_id`／`revision_id`），短 id 会误伤合法子图 id（实测 session_id=`t1` 时 `sg-cut1-probe` 被拒）。宁严勿松、可改名绕过，我判低危，记录不修。
- **`needs_revalidation` 仍无持久消费者（R5c 残留）**：钩子只把通知打成 warning，`ProjectionRegistry` 自己的 `revalidation_callback` 没注入；#85／#86 的「ACL 变更触发再投影／撤下」在生产上没有触发源。要定的是「谁消费这个通知、存在哪里」，以及 ACL 变更事件从哪来。

## 全分支回归核对

11 个提交之后跑 `uv run pytest tests/*.py -q -o addopts=''`：**773 passed／7 failed／16 errors**（R5c 后复跑；R5b 时为 745 passed／同一批失败）。7 个失败逐个在 base `e8a8babf4` 上复现（`prompt_manager` ×2、`edge_cases`、`citation_ledger`、`causal_bridges` 五个在 base 上原样失败，另两个是已知基线），16 个 error 是 `mock_agfs` 的机器绝对路径 fixture。结论：**没有跨模块回归**。明细见 `regression-sweep-20260929.md`。

## 纪律

- 我（ZCode）写 brief、派发、逐波独立复跑测试、审 diff；cursor-agent 实现。原始输出留在 `impl/R*-cursor-raw.log`。
- 每波不跨波顺手做别的条目；发现设计与代码对不上就报告，不自行改设计。
- 不 push；不引新依赖；不动 `benchmark/`（除非签名必须）。
