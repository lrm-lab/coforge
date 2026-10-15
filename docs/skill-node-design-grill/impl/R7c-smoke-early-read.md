# R7c 冒烟早读（ZCode，2026-09-30，**中途记录，不是定论**）

定位：R7c（oracle 摘要臂）第一档冒烟＝**只跑 conv-26**（197 题），耗时 1245.8 秒。全量还没跑完，本文件只把早读与已验证的部分固定下来，最终以 `R7c-verification.md` 为准。

件：`/tmp/r7c-oracle/oracle.json`（checkpoint，逐会话写完即落盘，`schema=r7c-oracle-v1`、`oracle_upper_bound=true`）；代码 `benchmark/causal_memory/l1_locomo_oracle_arm.py`（1205 行，未提交）。我的独立复算：`/tmp/zcode-verify/check_r7c.py`。

## 我已独立验证的部分（冒烟范围）

| 检查 | 结果 |
|---|---|
| 逐题复算（从 JSON 里存的 `top10` ＋ `gold` 重算 coverage／all_gold／mrr） | **0 处不符**（197 题 × 17 臂 × 2 口径） |
| 逐题不变量（单调、`all_gold ⇔ coverage==1`、`mrr>0 ⇔ cov@10>0`、`hit ⇔ cov>0`、单 gold 一致性、无重复 dia、`pool ≥ union ≥ len(top10)`） | **0 问题** |
| **重跑的 R6e 臂 vs R7a 逐题件**（P_legacy／A4／A12／B4／B12 × legacy／ranked × 9 个字段） | 比对 **17 336 个字段，漂移 0** |
| 机制对照 `placeholder.no_resolver` | **取回 0 张卡**（4／12 座都是 0，`empty_union=197`） |
| 摘要来源 | `conv["observation"]` 与消息原文；`evidence` 只出现在判分路径（`grep` 核过）——**无 gold 泄漏** |
| 标注审计 | 脚本自检通过：异常条目 10、不同锚点 dia 750、被多条共用 538（与我 R7a 之前的实测一致） |

`placeholder.with_resolver` 与 fallback（B）**逐字段相同**（hit@10 52.8%／57.9%、cov@10 48.9%／53.7%、all@10 45.7%／50.3%；只有 mrr 差 0.0007——`revision_id` 不同导致卡片 id 不同、BM25 文档不同，座位切分处平局次序微移，与 R6d／R6e 记录过的同类良性差异）。**这说明「自适应视图这条管线本身」与 fallback 等价，差值全部来自摘要文本**——机制对照成立。

## conv-26 早读（197 题，`ranked` 口径）

| 臂 | hit@5 | hit@10 | cov@10 | all@10 | mrr |
|---|---:|---:|---:|---:|---:|
| `placeholder.no_resolver`（4／12） | 0.0% | **0.0%** | 0.0% | 0.0% | 0.0000 |
| `oracle.no_resolver.12` | 47.2% | **54.3%** | 50.2% | 46.7% | 0.3191 |
| `oracle.no_resolver.4` | 47.7% | 52.8% | 49.3% | 46.2% | 0.3156 |
| `oracle.with_resolver.12` | 50.8% | 60.4% | 56.1% | 52.3% | 0.3554 |
| `oracle_only.with_resolver.12` | 53.8% | **65.0%** | **60.4%** | **56.3%** | 0.3760 |
| A12（atom 12 座，锚） | 51.8% | 60.9% | 56.6% | 52.8% | 0.3441 |
| T（词法参考，锚） | 56.9% | 62.4% | 59.0% | 55.8% | 0.4407 |
| B12＝`placeholder.with_resolver.12`（锚） | 48.2% | 57.9% | 53.7% | 50.3% | 0.3153 |

按 gold 条数的 `all_gold@10`／`coverage@10`：

| gold_n | n | T | `oracle_only.with_resolver.12` | `oracle.no_resolver.12` | `placeholder.with_resolver.12` |
|---|---:|---|---|---|---|
| 1 | 159 | 68.6%／68.6% | **68.6%／68.6%** | 57.2%／57.2% | 61.6%／61.6% |
| 2 | 29 | 3.4%／20.7% | **6.9%／29.3%** | 3.4%／22.4% | 3.4%／22.4% |
| ≥3 | 9 | 0.0%／13.9% | 0.0%／17.6% | 0.0%／15.7% | 0.0%／14.8% |

## 早读能说的三句话（**待全量确认，别当结论引用**）

1. **生产配置下摘要真的撑得起检索**：`oracle.no_resolver`（不接 resolver）conv-26 到 **54.3%@10**，而同样配置的 fallback（`placeholder.no_resolver`）是 **0%**。这正是 #126 当时没法回答、也是 #125 值不值得做的那个问题。
2. **接 resolver 时 oracle 摘要在 conv-26 上略超 T**：`oracle_only.with_resolver.12` 的 hit@10 65.0%／cov@10 60.4%／all@10 56.3% 都高于 T（62.4%／59.0%／55.8%）与 A12（60.9%／56.6%／52.8%），**但 mrr 更低**（0.3760 vs T 0.4407）——「收得更多、第一条来得更晚」。多证据题（gold_n=2）是唯一明显抬升处：`all@10` 3.4%→6.9%、`cov@10` 20.7%→29.3%。
3. **`oracle_only` > `oracle`（反直觉，值得注意）**：把无标注消息的**原文**塞进摘要不如塞占位串——`oracle_only.with_resolver.12`（65.0%）高于 `oracle.with_resolver.12`（60.4%）。早读解释是「长消息原文进 BM25 文档反而稀释／抢分」，但这需要全量复现再下判断。

**风险提示**：以上全部来自 **1 个会话／197 题（全量的 10%）**，且是 oracle 上界（人工标注、与出题同作者）。`gold_n=2` 只有 29 题、`≥3` 只有 9 题，多跳那两行的抖动会很大。

## 下一步

全量 10 会话（17 条臂，预计 3 小时上下），跑完写 `R7c-verification.md`：提交审计、独立复算、主表、按 gold 条数、cat 1、四个问题（是否超 A12／T、生产配置多少、placeholder 是否等价、多证据题抬到多少）。
