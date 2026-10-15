# R7c 独立验证（ZCode，2026-09-30）

派发件：`R7c-brief.md`。cursor 报告：`R7c-cursor-raw.log`。提交：**`b86d566ee`**（`bench(causal-memory): oracle summary arm on LoCoMo adaptive views`，父 `1f388e851`，未 push）＋ **`a550e3be0`**（我做的机械 lint 修复，见 §1）。逐题件：`/tmp/r7c-oracle/oracle.json`（我的副本 `/tmp/zcode-verify/r7c-full.json`）。

**一句话**：内容轴的天花板量出来了，而且是**负结果**——人工写的摘要（不可达上界）在同座位下**换不来超过原始消息文本的收益**，最好的摘要臂也只是和词法参考 T 打平（hit@10 63.8% vs 61.8%、all@10 54.6% vs 53.5% 略高，但 hit@5 52.4% vs 56.0%、mrr 0.3679 vs 0.4346 明显更低）。另有两个机制事实：**投影卡片在没有 resolver 时几乎没有可评分内容**（这解释了 R6d/R6e/R7a 的 B 臂到底在测什么），以及**卡片 id 自带 `card` token** 导致控制门必须以「零 gold 命中」而非「零卡片」来表达。

## 1. 提交审计

| 检查 | 结果 |
|---|---|
| `git show --name-only b86d566ee` | **只有** `benchmark/causal_memory/l1_locomo_oracle_arm.py`（+1230 行） |
| 兄弟跑分件字节数（`1f388e851`→`b86d566ee`） | `l1_locomo_hitk.py` **0**、`l1_locomo_projection_arm.py` **0**、`l1_locomo_ranked_arm.py` **0** |
| 源码／测试 | `git diff --name-only -- openviking tests pyproject.toml uv.lock` **0 个文件** |
| 工作树 | 干净 |
| push | 分支无 upstream，**未 push** |
| **ruff** | **提交时未过**：`I001 Import block is un-sorted or un-formatted`（1 处，可自动修） |

**我补的 `a550e3be0`（机械修复，已披露）**：`ruff check --fix` ＋ `ruff format`，34 增 20 删。行为等价的证据：(a) 顶层 AST 节点多重集比对，唯一差异是**同一个 `ImportFrom` 内部名字的排序**（`_Hit`/`_Metric` 归位），无其它增删；(b) 用修好的文件对**已完成的检查点副本**重跑 `--resume`（`/tmp/zcode-verify/r7c-replay/`），168 行输出里锚点表与失败信息**逐字相同**、退出码同为 1（§4）。

## 2. 独立复算（我的脚本，不导入 R7c 模块）

`/tmp/zcode-verify/check_r7c.py`（R7c 冒烟期已写好并在全量上限过）：

| 检查 | 结果 |
|---|---|
| 检查点 | schema `r7c-oracle-v1`、**10 个会话**、**1982 行** |
| 逐行重算（从存的 `top10`＋`gold` 重算 cov@5/10、all_gold@5/10、mrr、hit@5/10） | **0 个问题** |
| 与 R7a 逐题件的共享字段比对（R6e 锚点臂） | 比对 **174,416 个字段，漂移 0** |
| 锚点 | T `56.0%@5／61.8%@10／cov@10 57.2%／all@10 53.5%／mrr 0.4346`；A12 ranked `59.0%@10／54.3%／50.6%／0.3012`；A12 legacy `15.2%@10`；A4／B4／B12／P_legacy 与 R7a 全同 |

**标注审计我自己从 `locomo10.json` 重数了一遍**（`/tmp/probes/r7c_annotation_recount.py`）：观察条目 **2541**（其中形状异常 10 → 有效 **2531**，与检查点一致）、不同锚点 dia **750** ✓、全文件被多条观察共用的 dia **538** ✓、消息数 **5882** ✓、锚定率 40.0% ✓。
**唯一未能复现的描述性数字**：`within_conversation_shared_dias = 159`——自然读法给出 **137**（同一会话内出现 >1 条的 dia）或 139（按「会话×说话人」桶）。该数字不进入任何指标，只影响注记文字。

**「card」碰撞我自己复现了**（`/tmp/probes/r7c_card_probe.py`）：用生产 `_question_keywords` 扫全 1982 题，恰好 **3 题**含关键词 `card`（conv-47 视频卡、conv-48 纸牌游戏、conv-50 牌局），与报告一致；这 3 题上 `placeholder.no_resolver` 的 4／12 座各取回 4／12 张卡，且 **hit@10 与 all_gold@10 全为 0**。根因在生产：`_opaque_card_id` 返回 `f"{kind}-card-{digest[:8]}"`（`influence_projection.py:147-160`），**每张投影卡片的 id 都含字面 token `card`**，任何含 "card" 的查询都会匹配全部卡片。

## 3. 读数（n=1982，ranked 口径；legacy 与分组表见运行件）

| 臂 | hit@5 | hit@10 | cov@10 | all@10 | mrr |
|---|---:|---:|---:|---:|---:|
| T（词法参考） | 56.0% | 61.8% | 57.2% | 53.5% | 0.4346 |
| A12（atom 通道，同为 12 座） | 45.7% | 59.0% | 54.3% | 50.6% | 0.3012 |
| `oracle` · no_resolver · 12 | 48.0% | 59.4% | 53.9% | 49.9% | 0.3160 |
| `oracle` · with_resolver · 12 | 47.6% | 61.1% | 56.2% | 52.4% | 0.3086 |
| `oracle_only` · with_resolver · 12 | 52.4% | **63.8%** | **58.7%** | **54.6%** | 0.3679 |
| `placeholder` · with_resolver · 12（≈R7a B12） | 41.8% | 55.9% | 51.2% | 47.5% | 0.2697 |
| `placeholder` · no_resolver（控制） | 0.0% | 0.0% | 0.0% | 0.0% | 0.0000 |

1. **内容轴没有超过词法的余量**：最好的人工摘要臂（`oracle_only`＋resolver＋12 座）在 hit@10／cov@10／all@10 上高出 T 1–2 个百分点，但在 hit@5（−3.6pp）与 mrr（−0.067）上明显落后——它「捞得更全、排得更后」。而标注是**人写的且与问题同源**（措辞重叠会把数字抬高），所以这已经是乐观上界；结论是**内容轴到此为止**。
2. **人工摘要 ≈ 原始消息文本**：无 resolver 时唯一的评分面就是摘要文本，`oracle.no_resolver.12`（49.9% all@10／59.4% hit@10）与 A12（消息原文作为卡片内容的 atom 通道，50.6%／59.0%）基本打平。同座位下，把「原文」换成「人写的摘要」**没有换来收益**。
3. **机制澄清（重要，影响如何读 R6d/R6e/R7a）**：fallback 块摘要是通用脚手架文本（`f"segment {segment_id} sequences {start}-{end}"`，`influence_view.py:1663`），投影卡片在**没有 resolver** 时因此几乎没有可评分内容（`placeholder.no_resolver` = 0 张）。也就是说 R6d/R6e/R7a 的 B 臂数字是**由 resolver 提供的原文**驱动的，不是投影卡片自身摘要的能力；R7c 的 `*.no_resolver` 臂才是干净的「只有摘要文本」测量。
4. **resolver 的增量很小**：同变体同座位，`oracle` 12 座 61.1% vs `oracle.no_resolver` 59.4%（hit@10 +1.7pp、all@10 +2.5pp）。接了原文之后仍不及 T。
5. 方向性观察（**非结论**）：`oracle_only` ＞ `oracle`（同样锚住的题上 63.8% vs 61.1%）——两者差别在**未锚定消息**上用的是脚手架文本还是原文，脚手架反而更好；幅度约 2 SE，可能是 BM25 文档长度稀释效应，不作为裁定依据。

## 4. 门检与那次退出码 1

- 全量的锚点门、R6e 漂移门、逐题自洽门**全部通过**；退出码 **1** 只来自控制门：`placeholder＋no_resolver` 取回了卡片（4 座 12 张、12 座 36 张）。
- 我复现了它、也确认**门想守的东西守住了**：这 3 题上控制臂的 gold 命中是 0（`hit@10=0`、`all_gold@10=0`），锚点臂数字也没有因此移动（A12 与 R7a 逐字段相同）。所以这是**门的表达形式过严**（「零卡片」），不是泄漏；此外 R7a 那份检查点里同一关键词在 fallback＋resolver 探针上也取回 4 张，说明与 R7c 的 oracle 摘要无关。
- **正确形式应当是**：「placeholder 臂不得产生 gold 命中」＋（可选）「不得因卡片 id/token 之外的正文匹配取回卡片」。
- 重放证据（我在 `a550e3be0` 后跑）：`--out /tmp/zcode-verify/r7c-replay/oracle.json --resume`，90 秒内结束，锚点表逐字相同、同样 FAIL、退出码 1 → 证明 lint 修复未改行为。

## 5. 结论与设计读数

1. **#132（内容轴结案）**：在 L1 这个口径上，**内容（摘要文本）不是缺口的所在**。人工摘要的上界＝与词法参考打平；低于原文摘要（脚手架）则接近 A12。想继续在内容上加码（更长的摘要、更好的 prompt）在 L1 上**没有可验证的收益空间**——这与 R7a 的池召回发现一致：瓶颈在「池里有没有候选」，不在「候选写得多好」。
2. **#133（投影通道的评分机制）**：投影卡片的可评分内容来自摘要字段；fallback 视图的摘要是脚手架文本，因此**该通道在无 resolver 时是惰性的**。以后描述「投影通道」的能力时必须带上这句话，否则会把 resolver 的能力记在投影卡片账上。
3. **结构轴仍然没有数字**，而且现在**排除法更干净了**：词法（T）在上界、内容（R7c）在上界、池宽被座位预算掐住（R7a／待设计项 20）。剩下的两条路是 R7d（扩池上界）与 R8a（带 claims/edges 的真实语料抽取）——后者正在派发。
4. **对 #125 的影响**：模型驱动的摘要提取在 L1 上的期望收益≈0（人工都换不来），所以 #125 的价值不在「摘要更好」，而在**边与子图**（那是 R8a 要测的）。这条可以直接支撑「#125 不做成摘要增强，而做成本波数据面里的 claim/子图契约」。

## 6. 残余（记入账本）

- `within_conversation_shared_dias: 159` 未复现（我给出 137／139）；不进指标，仅注记。
- **卡片 id token 泄漏**：`{kind}-card-<hex>` 使 `card` 成为每张投影卡片的点击词；本题集 3／1982 题、指标影响 0，但与 R2b 修的 `payload_ref` 泄漏同类，应记残余。
- **#134 控制门表达形式**需按 §4 改正（不是泄漏，是门的形状：卡片 id 自带 `card` token）。
- oracle 上界由同源标注抬高，不可当可达值（检查点内 `annotation` 字段已自带此声明）。
- 派发件里写的「85–94% 锚定率」与 `locomo10.json` 实测（40.0%）**对不上**——是派发件依据的来源有误，实测值以检查点与我的复算为准（cursor 已如实报告，未按简报的数字硬凑）。

## 132／133／134（R7c 验证后裁定）：内容轴结案、投影通道的惰性、卡片 id token 与控制门形状

派发件 `R7c-brief.md`；提交 `b86d566ee`（＋我补的机械 lint 修复 `a550e3be0`）；独立验证见 `R7c-verification.md`。

**#132 内容轴结案（不是缺口所在）**。证据（n=1982，ranked）：T 61.8%@10／53.5% all@10／mrr 0.4346；A12（atom，12 座）59.0%／50.6%／0.3012；`oracle.no_resolver.12` 59.4%／49.9%／0.3160；`oracle.with_resolver.12` 61.1%／52.4%／0.3086；`oracle_only.with_resolver.12` 63.8%／54.6%／0.3679。三条读数：(a) 无 resolver 时唯一评分面是摘要，人工摘要与原文打平（49.9% vs 50.6% all@10）——**同座位下人写摘要换不来超过原文的收益**；(b) 最好摘要臂只在 hit@10／cov@10／all@10 高出 T 1–2pp，hit@5 与 mrr 明显落后（捞得全、排得后）；(c) 标注与问题同源（人写、措辞重叠），这是**乐观上界**。结论：**#125 的价值不在「摘要更好」，而在边与子图**，即 R8a 要测的东西。

**#133 投影通道在无 resolver 时是惰性的**。生产 fallback 块摘要是脚手架文本（`f"segment {segment_id} sequences {start}-{end}"`，`influence_view.py:1663`），而投影卡片的可评分内容来自 `summary` 字段，所以 `placeholder.no_resolver` 取回 0 张（除 3 题 `card` 撞 id）。这澄清了历史读数：**R6d/R6e/R7a 的 B 臂由 resolver 提供的原文驱动**，不是投影卡片自身摘要的能力。#126（生产不接 resolver）因此要补一句：生产接的投影通道在 fallback 形状下本来就没有内容可检索。

**#134 卡片 id token 与控制门的形状**。`_opaque_card_id` 返回 `{kind}-card-<hex>`（`influence_projection.py:147-160`），**每张投影卡片 id 都含字面 token `card`**，故任何含 "card" 的查询命中全部卡片。实测本题集 3／1982 题（conv-47/48/50），gold 命中 0、锚点臂数字零漂移。R7c 全量退出码 1 正是控制门「placeholder＋no_resolver 必须 0 张卡片」被这 3 题触发——**门想守的东西守住了**（控制臂 gold 命中 0），是门的表达形式过严。今后的写法：**「placeholder 臂不得产生 gold 命中」**（可选再加「除 id token 外不得取回」）。与 R2b 修的 `payload_ref` 泄漏同类，记残余。

**记账面**：`CONSENSUS.md` #132/#133/#134；`R7c-verification.md`；`R0-wave-plan.md` 的 R7c 行结项。
