# R8a 独立验证（ZCode，2026-09-30）

派发件：`R8a-brief.md`。cursor 报告：`R8a-cursor-raw.log`。提交：**`9494708c2`**（`bench(causal-memory): extract influence graphs and forks on SkillsBench traces`，父 `a550e3be0`，未 push，只有新文件 1954 行）。

运行件：cursor 的 `/tmp/sb-influence/`；**我的重跑** `/tmp/zcode-verify/r8a-mine/`（独立 work dir，`work = args.out.parent`，两边互不覆盖）。

**一句话**：抽取侧**全部复现**——14/14 冻结、5 成功／2 失败／7 无裁决的人口数我自己从 `attempts.jsonl` 数出同一张表、444 次工具调用逐格对上、15 个 fork 我从生产 store 独立读回且**七个 section 与我自己的重算逐字段相同**、锚点全部等于「子图 failure 证据 ＝ 时间上最后一个 block 的 AO」且被 position block 覆盖。**但 L3 那句「结构 70.6% vs 词法 47.3%」不能当作因果子图的价值来报**：命中测试的 pattern 键太粗（**全语料只有 41 个 pattern／444 次事件**，`run_command:cd`＋`bash:cd` 两个键就覆盖 63.7% 的事件；**只含最高频那一个 pattern 的卡片单独就能命中 35.3% 的后半段事件**），而两条臂的**每卡片 pattern 容量不同**（结构卡片中位数 1、最多 6，fork/branch 卡片带整条 tail 集合；词法条目恒定 1）——把结构臂每张卡片削到 1 个 pattern，154 → **116**（中性）／**149**（事后最优上界），词法仍是 103。附带查出一条生产缺口：**`validate_view`／`freeze_extracted_view` 不把 evidence 的 `ao_id` 对上台账**（伪造证据能冻结、服务端零告警、配一个调用方自带的 position 还能把 fork 写下去）。

## 1. 提交审计

| 检查 | 结果 |
|---|---|
| `git show --stat 9494708c2` | 只有 `benchmark/causal_memory/sb_influence_extraction.py`（**+1954**，父 `a550e3be0`） |
| 同目录其它文件（`git diff --name-only 9494708c2 -- benchmark/causal_memory/`） | **0 个**（四个兄弟跑分件字节未动） |
| 源码／测试（`openviking` `tests` `pyproject.toml` `uv.lock`） | **0 个文件** |
| 工作树 / push | 干净；分支无 upstream，**未 push** |
| **ruff** | **未过**：`E402 module-import-not-at-top-of-file` **10 处**（`sys.path` 注入后才 import，R7a/R7c 的同类文件都在行内 `# noqa` 或改结构后通过；同目录 `l1_locomo_oracle_arm.py`／`l1_locomo_ranked_arm.py` 均 `All checks passed!`） |

## 2. 独立复算（我的脚本，不导入 R8a 模块）

`/tmp/probes/r8a_recount.py`（只读原始 `2*.jsonl` ＋ `sb-task.json`，我自己按报告里冻结的规则文本实现一遍）：

| 检查 | 结果 |
|---|---|
| 逐 episode：非 omitted 记录数＝block 数 | 14/14 **完全一致** |
| 逐 episode：相邻对判 influence（tool_call↔tool_result）／skip（跨 omitted 或其它） | 14/14 **完全一致**（含 `omitted_between_claims`） |
| 工具调用总数 | **444**（＝报告 444，逐 episode 也逐格相同） |
| 人口数（`attempts.jsonl` 我自己读） | **recorded success 5／recorded failed 2／unrecorded 7**，与报告 `confirm_status` 列 **0 处不一致**；报告 `not_task_success: true` **正确** |
| 两个 `failed` 的 error | 都是 `PI_CANCELLED: context deadline exceeded`（**agent 超时**，不是答错） |
| narrow 集合 | `{0001,0003,0008,0010,0012,0014}` ＝ **transcript 结束在工具交换中途**的 6 个（`cut:toolCall`×4 ＋ `cut:toolResult`×2）；wide ＝ 再加 `{0009,0011,0013}`。我的 `tail_kind` 分类与之一致 |

**确定性／可复现**：我用同一个提交的同一文件、在**另一个 work dir** 重跑 `--stage all`（约 60 秒），把我的 `report.json` 与 cursor 的做**递归语义比对**（键集合、列表长度、标量值）：**0 处差异**。也就是说这不是「同一环境同一份产物」，而是两次独立运行的产物完全相同（含每 episode 的 `claim_*`、`tail_patterns`、revision 载荷与 fork 行）。

**切分与泄漏我自己复核了**：`sb-full.jsonl` 87 行 ＝ train **42** ＋ test **45**（与报告一致）；14 个 episode 的 `task_id` **全部属于 train**，**test ∩ episode ＝ ∅**。另：45 个 test 题里有 3 个属于「14 个 episode 也在的 family」（episode 侧只有 3 个 family：cybersecurity／finance-economics／industrial-physical-systems）——所以 L3 的 `cross_family` 口径量的是**留出的 train episode 对其它 train episode** 的跨族读数，**不是**对 45 个未见过 test 任务的泛化（test 只有题面、没有轨迹，报告把它标成接口演示是对的）。

## 3. fork 独立读回（15/15）

`/tmp/probes/r8a_fork_readback.py`＋`/tmp/probes/r8a_anchor_check.py`（用生产 `CausalExperiencesStore.get_fork_node`／`get_revision` 读回，再拿原语料自己重算 section 做比对）：

| 检查 | 结果 |
|---|---|
| fork 数 | narrow **6** ＋ wide **9** ＝ **15**，与报告一致，**0 缺失** |
| 七个 section | **15/15 与我自己的 `_seven_sections` 重算逐字段相等**，字节总数与 `seven_bytes` 逐行相等（721／682／678…） |
| 锚点 | **15/15**：`anchor.ao_id` ＝ 子图的 `failure_evidence_refs[0].ao_id` ＝ 子图内时间上最后一个 block 的源 AO；`anchor_sequence` 与之一致 |
| position 覆盖 | 15/15 `position_kind="block"` 的 block **确实覆盖**锚点 AO（生产 `_block_covers_evidence` 语义） |
| 分支证据类别 | 全文扫描**无** `imagined_synthetic`／`imagined_unverified`，所有 branch 均 `evidence_status="real"` |
| 幂等／ACL 负例／读回 | 报告行 `idempotent=true`、`acl_negative_rejected=true`、`readback=true`；我的重跑产物给出同一批 `content_hash`，故这三项**可复现**（不自称已独立设计该实验） |

**语义范围（必须跟着数字一起说）**：这里的「failure」＝**记录在案的轨迹在工具交换中途被截断**（2 个 `failed` 是 agent 超时，7 个没有任何裁决），**不是「答案错了」**。L2 的 6/9 只能读成「截断邻域」，不能读成失败归因。

## 4. L3 尺子：为什么这组数字不能当泛化结论

### 4.1 每卡片 pattern 容量不对称（`/tmp/probes/r8a_density.py`）

| 口径 | 结构臂 | 词法臂 |
|---|---:|---:|
| 每次查询卡片数 K | 12 | 12 |
| 每张卡片的 pattern 数 | 均值 **1.70**、中位 **1**、**最大 6**；单 pattern 卡片占 **54%** | 恒 **1**（`_lexical_hits` 写死 `[item["pattern"]]`） |
| 卡片种类 | 10 座 block/claim 投影（带 `block_patterns[id]`／`claim_patterns[id]`）＋ 4 座 fork/branch（带**整条 `tail_patterns` 集合**，最多 12 个 block 的全部 pattern） | 单事件条目 |
| 实测微平均（narrow，n=218） | **154／218 = 70.6%**（与报告一致） | **103／218 = 47.2%**（与报告一致） |
| 把每张卡片削到 1 个 pattern（中性：取**排序后**的第一个） | **116／218 = 53.2%** | 103／218 = 47.2% |
| 削到 1 个 pattern（事后最优：取能命中的那个，乐观上界） | **149／218 = 68.3%** | — |

**⚠️ 本节先前的归因（「51 个优势里约 38 个来自一张卡片带多个 pattern」）是错的，已在 R8b 验证中推翻，保留原文以便对账。** 错因是我这一步用了 `sorted(patterns)[:1]` 当「第一个 pattern」。R8b 用**自然顺序**（调用顺序／tail extend 顺序）的同一规则算出 **146／218**，与我的 116 差 30 次命中——两者都是「不挑不选」的中性规则，差别只在**留下哪一个 pattern**。R8b 的探针给出了机制：自然顺序留下的 142 个 pattern 里有 **79 个 `bash:cd` ＋ 24 个 `run_command:cd`**（73%），而这两个键正是覆盖 63.7% 事件的那两个；排序后第一个往往落到 `bash:cat` 一类低频键上。也就是说：**结构臂的分数由「任意削枝规则留下哪个 token」决定，摆幅 30 次命中（14pp），与结构本身无关**；而 cap1 的**事后最优上界（154＝full）证明多 pattern 卡片在「多带 pattern」上贡献为零**。正确读法见 `R8b-verification.md`。

### 4.2 pattern 键太粗，命中测试实际在量「工具词汇重合」

| 事实 | 数值 |
|---|---|
| 全语料 pattern 词表 | **41 个**（444 次事件） |
| `run_command:cd` | 163 次（**36.7%**） |
| `bash:cd` | 120 次（**27.0%**）——前两名合计 **63.7%** |
| 一张「只含最高频 pattern」的卡片，单独能命中多少后半段事件 | **77／218 = 35.3%** |
| 上界（后半段事件里 pattern 在语料中存在的比例） | **197／218 = 90.4%** |

`pattern = {tool}:{command 第一个词}`（basename、casefold），于是 `cd`／`ls`／`cat`／`pwd` 这类 token 承载不了任何任务信息。**一次「命中」只说明「取回的卡片里也有个 `cd`」**，不说明取回的东西与这段因果有关。结构臂与词法臂的差距因此主要是「谁的 pattern 袋子更大／排序更好」，不是「谁更懂因果」。

### 4.3 我的判定

R8a 的 L3 **不是**一个可报的泛化数字（结构臂高出的部分由容量与键粒度解释）。它现在的正确读法是：**接口跑通了**（生产 facade／投影注册／fork serving 在跨 episode、跨 family 的真实语料上端到端可用，45 个 test 题面能取回卡片），**数字待重测**。重测需要（进 R8b）：同容量臂（1 pattern／卡片，中性＋上界都报）、词法臂给到与结构臂**相同数量的不同 pattern**、只换 family 的对照臂、以及「只含最高频 pattern 的卡片」这条**平凡基线**——后者 35.3% 一写出来，读者就知道 47% 与 70% 之间的距离有多虚。更彻底的修法是更细的 pattern 键（如带第二个词或参数指纹），作为**并存变体**报告，不替换原键。

## 5. 伪造证据：生产门确实不查（我的探针）

`/tmp/probes/r8a_forge_evidence.py`：拿一个**本来合法**的 revision（控制组能冻结），只改一个字段再直接调生产 `freeze_extracted_view`／`validate_view`：

| 探针 | 结果 |
|---|---|
| [0] 原样（控制） | **FROZE ok** —— 基线版本合法 |
| [1] influence claim 的 `source_evidence_refs[0].ao_id` 改成不存在的 id（`evidence_content_hash` 同时改） | **FROZE ok**；`validate_view` **NO FINDINGS** |
| [2] 子图 `failure_evidence_refs[0].ao_id` 伪造 | **FROZE ok** |
| [3] claim 的 `target_block_id` 伪造（控制） | **REFUSED `dangling_claim`** —— 门是醒的，只是没有台账 |
| [4] 用伪造锚点写 fork | `default_failure_grounding_position` **抛错**（`covered by 0 blocks`）；但 `write_failure_subgraph_fork` 在**调用方自带 `position_ref`** 时**把 fork 写下去了**（`ad3069ac-…`） |

代码面：`validate_view(draft)` 的签名里**没有台账**，所以它**结构上不可能**校验 evidence 可解析性；它只查「跨 omitted 的 skip 必须两端有证据」（`skip_missing_evidence`，`influence_view.py:1347`）与「有 failure 标记必须有证据」（`subgraph_failure_evidence`）。唯一对台账的解析在 R8a 自己的 `_check_structure`／`_build_claims`（写方自检）。写方 `write_failure_subgraph_fork` 从 `failure_evidence_refs[0]` 取锚点，但**不校验 position 覆盖锚点**——这一步只在调用方调 `default_failure_grounding_position` 时才做。

**后果与定级**：R8a 自己的 15 个 fork 是**安全**的（`_fork_payload` 先调了那个 helper，§3 也逐条验证了锚点）。缺口是给 **#125（模型驱动抽取）** 留的：模型会自己写证据引用，而服务端门对证据只查「有没有」不查「真不真」，一个幻觉出来的 `ao_id` 会安静地冻进 revision。**收口成本很低**：让 `write_failure_subgraph_fork` 自己派生／校验 position（内部一致性检查，不动签名），并在 #125 落地时给校验补上台账。已列入 R8b。

## 6. 结论

1. **抽取侧成立**：14/14 冻结、人口数、444 次调用、15 个 fork 的七段与锚点，全部独立复现；两次独立运行产物 **0 差异**。这是 `InfluenceClaim`／`RetrievalSubgraph` 第一次在真实语料上被构造，且生产校验链在 82～158 个 block 的规模上没有一次误拒。
2. **L3 的泛化数字作废（不是失败，是尺子不合格）**：容量不对称 ＋ pattern 键粒度粗（41 键／444 事件，两个键覆盖 63.7%）使得「结构 > 词法」无法解释为因果价值。重测规则进 R8b，规则**先冻结再打分**。
3. **fork 语义收窄**：`failure` ＝ 轨迹被截断（超时／无裁决），不是答错；引用 6/9 时必须带上这句。
4. **生产缺口一条**：evidence 的台账可解析性无人校验；伪造证据可冻结、可写入 fork（调用方自带 position 时）。R8a 自身不受影响，#125 之前必须收口。
5. **lint**：新文件 10 处 E402，同目录其它文件干净 → 进 R8b 做机械修复，并用「重跑 report 与 `9494708c2` 产物 0 差异」证明无行为变化。

## 7. 残留

- `unmeasured` 四项（任务成败泛化、模型驱动抽取、另 28 个 train 任务、45 个 test 题面只是接口演示）我逐条读过，都是**诚实的边界声明**，不需要改。
- 报告 `control` 段的其它伪造探针（`forged_claim_id` → `subgraph_unknown_member` 等）我未逐条重跑，只重跑了 [3] 那条作为「门是醒的」的控制；其余属于同一族，风险低。
- L3 的 `test_prompt_demo`（45 题面 → 540 张卡片／180 张 failure-fork 卡片）我未独立复算族分布，只确认它是**接口演示**而非指标。
