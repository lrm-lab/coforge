# R7b 独立验证（ZCode，2026-10-01）

派发件：`R7b-brief.md`（设计裁定 #144／#145）。cursor 报告：`R7b-cursor-raw.log`。提交：**`8d3c25a97`**（`bench(causal-memory): diagnosis-side subgraph retrieval discriminates on typed fields`，父 `20175df19`，未 push，只加两个文件 2099 行）。

运行件：cursor 的 `/tmp/r7b-disc/`；**我的重跑** `/tmp/zcode-verify/r7b/`（另一个 `--out`，独立 work dir）。

**一句话**：R7b 的**机械部分全部复现**——三次独立运行（cursor 两次 ＋ 我一次）产物**逐字节相同** `2c77d55f…`；洗牌统计我用同样种子自己重算，`mean=0.501833`、`repeat0=0.416667`、分位 `[0.291667, 0.708333]`、带 `[0.295876, 0.704124]` **每一位都对上**；L2 那 6 个查询 × 5 个候选的**结构名次我用自己实现的六条冻结规则重算，30/30 相同**，`relation_profile` 是唯一会动的加权字段（`0001`=(8,2)，其余五个=(10,0)），`member_gap` 六个值都不同人人在扣所以不重排，剩下的分歧由平局规则决定 —— 归因成立。**但有三处要写进判决的锐化**：L1 的查询**就是**正极（构造等价，`判别力` 读作「匹配器确实读了类型化字段」而非任何效果量）、词法列的 `0` 来自等散文打平后被**夹具命名序**决定（只有 top-3=1 与 MRR=0.5 可读）、以及 **`boundary` 的实现没有落地设计 §3 的意图**：规则从「尾部角色＋前一块到尾块的影响边」推，而这份视图里两种截断的尾部**都是 `agent_action`**，所以 6 个尾部**全被标成 `result_cut`**，包括 R8a 记为 `cut:toolCall` 的 4 份（0001／0003／0008／0012 是 toolCall，0010／0014 是 toolResult）。也就是说 **轴 A 的 `call_cut` 极在真数据上不存在实例**，轴 A 的夹具结论不外推。

## 1. 提交审计

| 检查 | 结果 |
|---|---|
| `git show --stat 8d3c25a97` | 只有 `benchmark/causal_memory/r7b_discriminability.py`（+1612）与 `r7b_structural_signature.py`（+487），父 `20175df19` |
| 源码／测试（`git diff --stat 20175df19 HEAD -- openviking tests`） | **0 行**（`retrieval_facade.py` 未动，符合 #145「本波唯一被测对象就是它，改即自证」） |
| 工作树 / push | 干净；**未 push** |
| 依赖 | 未加（只 import 生产模块与 stdlib） |

## 2. 确定性与「先冻结后打分」

| 检查 | 结果 |
|---|---|
| cursor 两次（`--out report.json` 与 `report-run2.json`） | SHA256 均 `2c77d55f7d53e7a01980615dbacfb13646f4d70482a44b0f89abb8679e9f73fe` |
| **我的第三次重跑**（`/tmp/zcode-verify/r7b/report.json`） | **同一个哈希**，字节相同 ⇒ 三方独立运行一致 |
| 规则是否在打分前打印 | `_print_policy` 在 `main` 一开头跑（日志在所有分数之前），权重／轴序／平局键／种子／带定义／夹具规则／洗牌规则／互换规则都在 `POLICY_LINES` 与报告 `policy`＋`rules_printed_before_scores` 里 |
| 权重与设计 §3 的建议 | 一致：`boundary`／`anchor_incidence`／`coverage_crossing`／`overlaps_anchor` = 2，其余 1；`workspace_id` 不可比即丢；平局 `(session_id, subgraph_id)` |
| 轴 A–D 顺序与两极 | 冻结在 `AXES`，与设计 §3 的四条轴同序；`_assert_l1_shape` 每对都校验「正极＝positive、负极＝negative、散文逐字节相同、pos 分严格大于 neg 分」，不符即 `_fail` |

## 3. 词法臂是不是生产（不是本地 BM25）

| 检查 | 结果 |
|---|---|
| 调用点 | `_lexical()` 调 `RetrievalSubgraphAdapter.retrieve_historical_subgraphs(adapter, rev, sg, PRINCIPAL)`，并先断言 `fn.__module__ == "openviking.session.retrieval_facade"`；计数 L1 **72** 次（24 基线 ＋ 24 互换后 ＋ 24 互换前重算）＋ L2 **6** 次 ＝ 报告 `lexical_arm.call_count` 的 **78** |
| 隔离探针 | `lexical_module = openviking.session.retrieval_facade`；`co_names` 含 `_subgraph_retrieval_text` 与 `_rank_document_indexes`；`passed = true` |
| **L2 的独立钉子** | 每个查询都把适配器 top-3 与我自己重算的 `_rank_document_indexes` 前缀对比，不等就 `_fail`（第 1330 行）⇒ 词法名次＝生产排序，不是夹具另算的一套 |
| 散文 token 泄漏 | `_tokens()`（长度 ≥8 的词，含中英切分）在 24 对 × 3 成员的检索文本上取到 **304** 个唯一 token，签名 JSON 里命中 **0**（`leak_count=0`、`passed=true`） |
| `SUBGRAPH_TEXT_POLICY_VERSION`／`DIAGNOSTIC_SUBGRAPH_HIT_CAP` | 从生产模块读入（`subgraph-text-pending-v0`／3），不是抄的常数 |

## 4. L1 复算（我从报告原始 per-pair 行重算，不看汇总）

| 量 | 我的重算 | 报告 | 一致 |
|---|---:|---:|---|
| 散文逐字节相同的对 | 24/24 | 24/24 | ✓ |
| 结构臂 top-1＝正极 | 24/24 | 24/24（判别率 1.0000） | ✓ |
| 词法臂 top-1＝正极 | **0/24** | 0/24（0.0000） | ✓ |
| 词法臂 top-3 含正极 | 24/24 | 1.0000 | ✓ |
| 词法臂 MRR | 0.5000 | 0.5000 | ✓ |
| 正／负极结构分 | 轴 A 16 vs 13；轴 B/C/D 16 vs 14 | 同 | ✓ |
| 轴 A 差异字段 | `['boundary','relation_profile']` | 报告已声明「轴 A 同时动了 boundary 与 relation_profile」 | ✓ |

**洗牌**：我用 `random.Random(20261001)`、1000 次、按报告的 pair 顺序、对每对洗 `[pos, neg]` 两个签名后重排，得 `mean=0.501833`、`repeat0=0.416667`、2.5/97.5 分位 `0.291667/0.708333`、带 `[0.295876, 0.704124]`，与报告**逐位相同**；`inside_band=true`。

**散文互换**：我从 24 行原始记录重算 —— 互换后「词法 top-1 ＝ 持有查询散文的那名成员」**24/24**，「结构 top-1 仍是正极」**24/24**（即结构臂跟散文 0/24）。

## 5. 三处锐化（验证时发现、报告未写明）

### 5.1 L1 的查询**就是**正极 ⇒ 结构列的 1.0 是构造等价的

`_run_pair` 里 `specs["query"] = _pole(axis, True, …)` 与 `specs["pos"] = _pole(axis, True, …)` 是两次相同调用，散文也同源，`_assert_l1_shape` 再断言一次。所以「结构臂判别率 1.0」只能读作：**匹配器确实把类型化字段读进去了，且这一处差异足以改变名次**（轴 A 差 2 个字段＝3 分，其余差 1 个字段＝2 分）。它不是「能靠结构找到相关子图」的任何证据，也不是效果量。报告自己的标签 `基于夹具，判别力 ≠ 效果量` 说了这一层，但没有说「查询＝正极」这个构造事实，判决里要补。

### 5.2 词法列的 `0` 由夹具命名序决定，只有 top-3／MRR 可读

24 对里散文**逐字节相同** ⇒ 生产 BM25 必然打平 ⇒ 名次由登记序／字典序决定，而夹具把会话号取成 `p-`（正极）与 `n-`（负极），`n` < `p`，于是**每一对**名次都是 `neg=1, pos=2`（我从 24 行原始记录里逐行核过 `lexical.positive_rank=2`、`negative_rank=1`）。把前缀反过来，词法列会变成 24/24。这条链我在生产代码里核到源头：`_rank_document_indexes` 明写「Equal scores keep the given order」（[`retrieval_facade.py:726`](/home/zhoujie22/river2_0/OpenViking/openviking/session/retrieval_facade.py:726)），而候选顺序来自 `ViewSupersedeIndex.revisions_for_purpose`，其 docstring 明写「Order is ``session_id``, then registration order within that session」（[`influence_view.py:1766`](/home/zhoujie22/river2_0/OpenViking/openviking/session/influence_view.py:1766)）⇒ 打平时胜者完全由会话名字符串决定。所以 L1 词法列**唯一可读**的是 top-3=1 与 MRR=0.5000（＝随机）——它们说明的是真事：**散文相同时候生产通道没有别的信号可用**，这正是 `subgraph-text-pending-v0` 的设计后果，而不是「词法臂差」。

### 5.3 `boundary` 的实现没有落地设计 §3 的意图（轴 A 在真数据上无实例）

设计 §3 写的是：`boundary` = 「尾部块的角色与相邻块种类（**R8a 的 `cut:toolCall`／`cut:toolResult`／`text_end`**）；『死在等结果』与『死在没发出去』是不同的失败签名，散文字面上看不出来」。实现（`BOUNDARY_RULE`／`boundary_of`）从**尾部角色 ＋ 前一块到尾块的 influence 边**推：角色非 `agent_action` → `text_end`；是 `agent_action` 且有那条影响边 → `result_cut`；没有 → `call_cut`。我按规则在 14 份检查点上自己重算，narrow 6 个尾部**全部是 `result_cut`**，而 R8a 的逐 episode 记录是：

| episode | R8a `tail_shape` | R7b `boundary` |
|---|---|---|
| 0001／0003／0008／0012 | **`cut:toolCall`**（×4） | `result_cut` |
| 0010／0014 | `cut:toolResult`（×2） | `result_cut` |

机制我核到块一级：0001 的尾块 `b-000085` 与 0010 的尾块 `b-000070` **角色都是 `agent_action`**、都由一条 `influence` claim 连到前一块；两者的区别只存在于**块摘要散文**里（`pattern:bash:cd …` vs `tool_result exit_code: 0 …`），而冻结签名按隔离要求不读散文。所以：

- 实现里的 `call_cut` 语义是「尾块没有从上一块来的影响边」，与 R8a 的 `cut:toolCall`（**尾记录本身是一次工具调用**）**不是同一个谓词**；
- 轴 A 的负极 `call_cut` 在真切片上**没有实例**，轴 A 的夹具判别率**不可外推**；轴 B/C/D 的极在真切片上则有实例（`anchor_incidence` 六个都是 `influence_upstream`，所以轴 B 的**正极** `influence_both` 同样只有夹具实例——见 §6，读时要一并声明）；
- 这不是算错或造假，报告 §L2 已经把现象如实写下来了（「角色字段在这份语料上分不开这两种截断」），**缺的是把它接到设计意图上**：设计要的那个区分，看类型化字段是拿不到的。

## 6. L2 复算（我自己实现六条冻结规则，不导入 `r7b_structural_signature`）

`/tmp/probes/r7b_recheck.py`：直接读 14 份检查点的 `revision` 载荷，用**我自己按规则文本实现的** `boundary`／`anchor_incidence`／`relation_profile`／`role_profile`／`coverage_crossing`／`member_gap`／`anchor_kind`，再自己加权求和、自己按 `(session_id, subgraph_id)` 排：

| 检查 | 我的重算 | 报告 |
|---|---|---|
| `boundary` | 6 个全是 `result_cut`（1 个取值） | 「`boundary` 全是 `result_cut`」✓ |
| `anchor_incidence` | 6 个全是 `influence_upstream` | ✓ |
| `coverage_crossing` | 6 个全 `true` | ✓ |
| `role_profile` | 6 个全是 `11 agent_action + 1 task` | 「11 个 `agent_action` + 1 个 `task`」✓ |
| `anchor_kind` | 6 个全是 `block` | ✓ |
| `member_gap` | 70／41／8／55／10／11 | 「70、41、8、55、10、11」✓（同序） |
| `relation_profile` | **2 个取值**：`0001`=(8,2)、其余五个=(10,0)；`0001` 的 skip 边落在索引 2,3,5,6 | 「`0001` 是 8 条 influence / 2 条 skip，其余五个是 10 / 0」✓ |
| **结构名次（6 查询 × 5 候选）** | 与报告 `structural_rank` **30/30 相同** | ✓ |

候选池为什么是 5：**只有 6 份主修订在 `revision` 载荷里带 `retrieval_subgraphs`**（narrow 六个）；另 8 份是 0 个子图，`0009／0011／0013` 的子图只在 `revision_wide` 里。所以「每个查询看另外 5 个」是**整个池子**，不是抽样；`L2_CORPUS_RULE` 里「wide-only 修订不登记、wide fork 不在候选内」也据此成立（我的记录：`in_wide=True` 的 9 个 ＝ narrow 6 ＋ `0009/0011/0013`，与 R8b 的「narrow 6 ＋ wide 9 ＝ 15 次写入、落成 9 个节点、6 个接地在候选修订上」吻合）。

**归因复核**：把 `boundary`／`incidence`／`coverage`／角色／`anchor_kind`／`grounding_kind`／`evidence_status`／`overlaps_anchor`／`used_skill_kinds`／`truncation_lines` 都钉死成常数后，唯一能改变相对名次的加权字段是 `relation_profile`（1 分），`member_gap` 虽然六个值都不同但**每个候选都差这一项**（扣分相同，不重排），剩余顺序由平局规则给出。报告那句「和词法臂的差别，来自这组平局加上这一处计数，不是来自 boundary / 角色 / 覆盖 / fork 种类」**成立**。

## 7. 结论

1. **R7b 通过**：脚本、规则冻结、词法臂接生产、三探针、L2 归因全部经独立复算；三方产物字节相同；`openviking/`＋`tests/` 零改动。
2. **对本语料可报的是负结果的对偶面**：诊断侧结构臂在真切片上**读不到任何分歧**——生产丢掉的 `boundary`／角色／覆盖／fork 种类在这 6 个失败子图上**都是常数**，`relation_profile` 与平局规则承担了全部名次差异。也就是说**「把结构字段加进检索」在这 6 份真数据上能改变名次的部分，恰好是「哪条 claim 是 skip」这一处计数**，其余是平局里的字典序。这一条要连同「只有 6 个查询 × 5 个候选」一起报，不能读成一般结论。
3. **`boundary` 是设计缺口，不是实现 bug**：设计 §3 要 R8a 的 `cut:toolCall`／`cut:toolResult` 区分，视图的**类型化字段**给不出（两种尾部都是 `agent_action`），能给出的是块摘要散文 —— 而读散文与隔离要求冲突。要么后续波让**抽取侧**把截断种类写成类型化字段（视图里本来有、只是没进类型），要么承认 `boundary` 在真数据上是常数。轴 A 的夹具读数因此**不外推**；轴 B 的正极（`influence_both`）同样只有夹具实例。
4. **本语料上不写「结构惰性」**（报告守住了这条）：全序不一致 ⇒ 只能报一致性数值（top-3 Jaccard 0.300000、六条 Spearman 0.7／−0.8／−0.6／−0.6／0.3／0.2），不能报胜负。
5. `SUBGRAPH_TEXT_POLICY_VERSION` 的决策输入到此为止，**未改生产代码**；`retrieval_facade.py` 的六条（`_subgraph_retrieval_text` 丢 roles／relation types／failure marker／ids／原文）现在有了量化后果：丢掉的字段在真切片上是常数，不丢的 `relation_profile` 才动名次。

## 8. 残留

- **轴 A／轴 B 的正极在真切片上无实例**（`call_cut`／`influence_both` 只存在于夹具）；夹具结论的适用范围必须逐轴写清。
- L1 的查询与正极构造等价（§5.1），所以 L1 只是匹配器的敏感性测试；要量「结构能不能找到相关历史子图」，本波**没有**任何测量。
- 词法列只有 top-3／MRR 可读（§5.2）；把 0/24 当成「词法差」是误读。
- L2 的池子是 6 个查询 × 5 个候选，单点不稳健；Spearman 的绝对值在这种 n 上没有意义，只作方向记录。
- `truncation_lines` 在本波是常数 `unknown`（修订上没有台账、七段不读）⇒ 这个字段未经任何检验。
- `validate_view` 仍不校验 evidence 可解析性（#138 的另一半，仍留给 #125）。
- 未测：诊断侧真实效用（无裁决、无修复链）；跨 session／跨 workspace；模型写的七段／branches 在检索里的作用（#125）。未动 live 栈、未调用模型、未 push。
