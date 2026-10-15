# R8b 独立验证（ZCode，2026-09-30）

派发件：`R8b-brief.md`。cursor 报告：`R8b-cursor-raw.log`。提交：**`28cea1478`**（E402 机械修复）＋ **`20175df19`**（同容量 L3 臂＋细键＋锚点校验），父 `9494708c2`，未 push。产物：cursor 的 `/tmp/sb-influence-r8b/report.json`；**我的重跑** `/tmp/zcode-verify/r8b-mine/report.json`。

**一句话**：尺子修好了，结论是**清晰的负结果**——本语料上用零 LLM 词法尺子**测不出因果子图在检索级上的价值**。三条独立证据：(1) 把结构臂每张卡片削到 1 个 pattern，**摆幅只取决于「留下哪个 token」**（中性取排序后第一个 116，取自然顺序第一个 **146**，事后最优上界 **154 ＝ full**，即多 pattern 卡片额外贡献为 0），而自然顺序留下的 142 个 pattern 里 **79 个是 `bash:cd`、24 个是 `run_command:cd`**（73%）——正是覆盖 63.7% 事件的那两个键；(2) **同族排除后优势消失**：结构 135 vs 词法 **136**；我另算了「同族排除＋cap1」这一未报组合：**128 vs 136**（词法在前）；(3) **细键把差距从 51 次压到 16 次**（42 vs 26），而在细键上**一张只含一个硬编码 token 的卡片（32）就已经超过 12 座词法臂（26）**。另：生产锚点缺口**已收口**（我的前后对照探针：同一伪造锚点修复前被写入、修复后被拒且零写入），lint 修复行为不变已用**哈希相同**证明；R7c 那个 159 我**复现了**——R7c 验证件里说它不可复现是**我的错**（我扫错了字段）。

## 1. 提交审计与可复现

| 检查 | 结果 |
|---|---|
| `28cea1478` | 只有 `benchmark/causal_memory/sb_influence_extraction.py`（+136/−71，E402 收进 `_load_openviking()`） |
| `20175df19` | 三个文件：抽取脚本（+558）＋ `openviking/session/subgraph_forks.py`（+63/−38）＋ `tests/test_subgraph_forks.py`（+46/−4） |
| `l1_locomo_hitk.py` | `git diff 9494708c2 HEAD` **未列出**（字节未变） |
| 工作树 / push | 干净；分支无 upstream，**未 push** |
| **产物哈希** | **我的重跑与 cursor 的 report.json 逐字节相同**：SHA256 `1d7e401e…`（477,621 字节）。另：`9494708c2` 时代的产物哈希是 `4193af1d…`，与**我自己的 R8a 重跑**也逐字节相同 ⇒ 三次独立运行（cursor R8a／我 R8a／lint 后）产物一致 |
| ruff | 三个改动文件 `ruff check` 与 `ruff format --check` **全过** |
| 测试 | `tests/test_subgraph_forks.py` **16 passed** |

**回归门（我自己做，不看它的自述）**：把 R8b 报告的 `l3.arms` 摘掉后与 R8a 报告做递归比对 —— **完全相等**（`added keys: []`）。R8a 的三条老数字（结构 154／词法 103／跨族 126 vs 78；wide 153／103／125 vs 78）**一字未动**。文件里还有一份写死的 `R8A_L3_MICRO` 在跑分途中比对，对不上直接退出。

## 2. 规则是否真冻结（我自己读代码）

- `FINE_KEY_RULE`／`ARM_RULES` 是模块常量，`_print_policy` 在任何分数之前打印，报告里带 `rules_printed_before_scores: true`。
- `structural_cap1_first` 实现是 `[{**card, "patterns": list(card["patterns"][:1])} …]`，而 `_card_patterns` 已改成**返回自然顺序列表**（`list(record["block_patterns"][…])`／`tail_patterns`，不再 `sorted`／去重），顺序＝调用顺序／tail extend 顺序。**「不挑不选」成立**。
- `structural_cap1_oracle` 是最大权分配的动态规划（12 张卡片 → 4096 位掩码 × ≤41 个 pattern），并带**暴力枚举交叉校验**（小规模时逐组合比对）；打分后还有一道 `oracle_score == oracle_weight` 的自检。**上界性质成立**，且在报告与规则里两处都标了「oracle，不是可部署排序器」。
- `cross_family_only`：`x_corpus = [r for r in corpus if r["family"] != held["family"]]`，fork 语料同样按 `family_of` 过滤 —— **是检索前丢语料，不是检索后滤结果**（这正是 R8a 那条跨族列的毛病所在）。
- 细键只换命中用的 pattern 列表／词法文档的 pattern 标签／同容量座位数／平凡基线，**卡片正文与 BM25 排序仍走粗键** ⇒ 取回的卡片集合与粗键相同，细键是「同一批卡片的更严命中测试」。规则先冻结、两键并列报，未事后换规则。
- 无事后加臂：验证件里 116／149 那两个数没有被拿来当臂报（见 §4）。

## 3. 我独立复算了每条臂

`/tmp/probes/r8b_cap1.py`、`/tmp/probes/r8b_finekey.py`（复用波次自己的取回，但**削减与打分是我自己写的**）：

| 臂（n=218，narrow） | 粗键 | 细键 | 报告值 |
|---|---:|---:|---|
| `structural_full` | **154** | **42** | 154／42 ✓ |
| `structural_cap1_first`（自然顺序） | **146** | **36** | 146／36 ✓ |
| `structural_cap1_first`（**排序**后第一个，我的旧探针口径） | **116** | — | （未报，见 §4） |
| `structural_cap1_oracle`（上界） | **154** | **42** | 154／42 ✓ |
| `lexical_k12` | 103 | **26** | 103／26 ✓ |
| `lexical_capacity_matched` | 85 | 7 | 85／7 ✓ |
| `frequent_pattern_control`（一张卡、一个 token） | 77 | 32 | 77／32 ✓ |
| 细键词表 | — | **114** | 114 ✓ |
| 逐 episode 命中数 | 全对 | 全对 | — |

`oracle == full`（154/153 与 42/42）是本波最重要的一行：**多 pattern 卡片在「多带 pattern」上贡献为零**，一张卡片留一个选得好的 pattern 就能拿到全部命中。

## 4. 我在 R8a 验证里的归因是错的（自我更正）

`R8a-verification.md` §4.1 当时写「51 个优势里约 38 个来自一张卡片带多个 pattern」，依据是我把每张卡片削到 `sorted(patterns)[:1]` 后得 116。R8b 用**自然顺序**的同一规则得 **146**，差 30 次命中。两个都是「不挑不选」的中性规则，差别只在**留下哪个 token**：

| 削减规则（中性） | 命中 | 留下的 pattern 是谁 |
|---|---:|---|
| 排序后取第一个 | 116 | 常落到 `bash:cat` 一类低频键 |
| 自然顺序取第一个 | 146 | 142 张卡片里 **79 个 `bash:cd` ＋ 24 个 `run_command:cd`**（73%） |
| 事后最优（上界） | 154 | 能命中的那个 |

也就是说：**结构臂的分数由「任意削枝规则留下哪个 token」决定，摆幅 30 次命中（14pp），与「结构」无关**。R8a 验证件 §4.1 已就地更正并保留原文对账；账本 #136 同步改了。这个更正**不改变**「L3 数字不可报」的结论，反而把机制说清楚了。

## 5. 我另算了一个它没报的组合，以及一个决定性的对照

**（a）同族排除 ＋ 单 pattern 上限（我自己的探针）**：narrow **128 vs 词法 136**，wide 同样 **128 vs 136**。报告只给了「同族排除 ＋ 全 pattern」（135 vs 136），缺的正是这个决定性组合。加上它就完整了：**同族不通、容量同为 1、此时词法在前**。

**（b）0009 是「同族互补」的活标本**：全语料时结构 19（=全部后半段命中），同族排除后 **1**，而词法在两处都是 19；0013 正好相反（结构 13／13，词法 1／13）。两条臂各自吃的是**同族工具词**与**通用 shell 词**，不是因果。

**（c）细键上的平凡基线超过整条词法臂**：一张只含 `run_command:cd:root` 的卡片得 **32**，12 座词法臂得 **26**，结构臂 42。**一个硬编码 token 打败一整条检索臂**——这是「这把尺子量的不是检索质量」最干净的证明。

## 6. 生产门收口：我用同一个探针做了前后对照

`/tmp/probes/r8a_forge_evidence.py`（未改动，只把工作目录指向我的 R8b 产物）对 `20175df19` 重跑：

| 探针 | `9494708c2`（修复前） | `20175df19`（修复后） |
|---|---|---|
| [0] 原样（控制） | FROZE ok | FROZE ok |
| [1] claim 证据 `ao_id` 伪造 | FROZE ok、`validate_view` NO FINDINGS | 同左（**缺口仍在**，见 #141） |
| [2] 子图 failure 证据 `ao_id` 伪造 | FROZE ok | 同左（**缺口仍在**） |
| [3] claim 端点 `block_id` 伪造（控制） | REFUSED `dangling_claim` | REFUSED `dangling_claim` |
| **[4] 用伪造锚点写 fork（自带 position）** | **写成功**（`ad3069ac-…`） | **抛 `ValueError: block position 'block:b-000085' does not cover failure evidence ao 'ao-FORGED-…'`，store 零写入** |

负例测试我在 tests 里读了原文（`test_forged_anchor_with_caller_position_is_not_written`）：伪造 `sg-cutover` 的锚点后调用，断言抛错、`_store_tree == before`、`_revision_files == []`。签名未改，`position_kind != "block"` 时不做锚点核对（已在报告残留里写明）。正例：我自己的产物里 **15 个 fork 全部读回一致**（七段逐字段等于我的重算、锚点 15/15 覆盖、无 `imagined_*`）——R8a 那套读回探针在 R8b 产物上重跑，结果与在 R8a 产物上完全相同。

## 7. R7c 残留：159 是可复现的，是我上次错了

我在 `R7c-verification.md` 里写过 `within_conversation_shared_dias = 159` 不可复现（「自然读法给 137／139」）。**那是我扫错了字段**：`_audit_observations` 数的是 `conv["observation"]`（`{speaker: [[text, dia_id], …]}`），我当时扫的是 `qa.evidence`。用正确字段我自己重数（`/tmp/probes/r7c_shared_recount.py`）：

| 量 | 我的重数 | 检查点 |
|---|---:|---:|
| `within_conversation_shared_dias`（逐会话 dia>1，相加） | **159** | 159 ✓ |
| `shared_anchor_dias`（全文件同名字符串 >1，去重） | **538** | 538 ✓ |
| `distinct_anchor_dias` | **750** | 750 ✓ |
| `observation_entries`／malformed skipped | 2531／10 | 2531／10 ✓ |
| `messages`／anchored rate | 5882／40.0% | 5882／40.0% ✓ |

**R7c 验证件里那条怀疑撤回**：不是数字有问题，是我读错了字段。三项都不进指标，现在有确切定义与独立复现。

## 8. 结论

1. **尺子修好了，结论是负结果**：在 SkillsBench 录制轨迹上用零 LLM 词法尺子，**测不出因果子图在检索级上的价值**。粗键上的 154 vs 103 由三件事共同造成——削减规则留下哪个 token（摆幅 30）、同族工具词（同族排除即消失）、粗键粒度（细键后剩 16，且一个 token 的卡片得 32 > 词法 26）。这些都是「工具词汇重合」，不是因果。
2. **抽取侧不受影响**：R8a 的全部结论（14/14 冻结、444 次调用、15 个 fork 的七段与锚点）在 R8b 后仍由哈希相同的产物与我的读回探针支撑。**结构轴的价值不能在检索级用这把尺子证伪也不能证实**——它没被测到，因为尺子量的是别的东西。
3. **#138 收口了一半**：写方锚点校验已加（不动签名），前后对照探针证明伪造锚点写不进去；`validate_view` 仍无台账，留给 #125。
4. **两条我的更正**（都记在案）：R8a §4.1 的「容量」归因（实为「留下哪个 token」）、R7c 的 159 怀疑（我扫错字段）。
5. **本语料上的下一步应当换测量位置**：结构的主场是**诊断侧**（失败签名 → 历史子图／fork 召回，即 R7b），而那一步的关键设计问题是**查询表示**——如果诊断侧查询也退化成 shell token，词法基线会照样白拿分（本波已演示两次）。这条要先设计再跑，不要再「跑一把看看」。#125（模型驱动抽取）是另一条路，但它要用户的模型预算授额。

## 9. 残留

- `validate_view` 不校验 evidence 可解析性（#138 的另一半，等 #125）。
- `position_kind != "block"` 时不核对锚点（报告已声明）。
- 细键下「同族排除＋cap1」的组合我算了（128 vs 136），但 `cross_family_only` 只覆盖 `structural_full` 与 `lexical_k12` 两条；若后续还要这把尺子，应把它做成完整的臂矩阵。
- 细键臂的读数整体很小（42／218 = 19%），细键上任何差距都在个位数到十几，单点不稳健。
- 未测：任务成败泛化；未动 live 栈；未调用模型；未 push。
