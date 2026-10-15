# R7a brief：给 L1 补上非饱和指标（全 gold 覆盖率／平均覆盖／MRR）

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（HEAD `60bed6d6e`，未 push）。**追加新提交；不 rebase／amend；不 push；不引新依赖。**

## 背景：为什么 `any-hit@k` 不够用了

R6e 之后：atom 通道 **59.0%@10**、词法参考臂 T **61.8%@10**——只差 2.8 个百分点，也就是说**「有没有命中一条 gold」这个指标已经被词法方法打到接近天花板**，剩下约 38% 的题是词法根本不匹配。而 LoCoMo 的多跳题 gold 往往不止一条（cat2 尤甚），`any-hit` 只看「有没有一条」，把「只捞到一半证据」和「两条都捞到」算成一样。

所以本波**只加指标，不改候选池、不改排序、不改任何既有输出**。

## 硬纪律

- **只改一个文件**：`benchmark/causal_memory/l1_locomo_ranked_arm.py`。`l1_locomo_hitk.py`（冻结基线的产出者）与 `l1_locomo_projection_arm.py`（R6d 记录件）**逐字不变**。
- **`openviking/` 与 `tests/` 零改动**。零 LLM。不创建 `ov.conf`。
- 输出只写 `--out` 指定路径。
- **既有 JSON 键与既有数字必须原样保留**（本波是加法）：旧键一个不删、值不变；新键新增。

## 要加的东西

对**每道题、每条臂、每种口径**（现在有 `legacy`／`ranked`／`rrf`；T 是 `token`），在 `any_hit` 之外加：

- `coverage@5`／`coverage@10`：该题 gold 集合落在前 k 的比例（0.0–1.0；gold 为空的题已跳过）。
- `all_gold@5`／`all_gold@10`：gold **全部**落在前 k 时为真（多跳题的主要读数）。
- `mrr`：第一条 gold 出现位置的倒数（1/rank；未命中记 0）。
- 每题把 gold 条数 `gold_n` 也记下来（按 gold_n 分组出数才有解释力）。

汇总要出：**总体**（按臂 × 口径）、**按 category**、**按 gold 条数分组**（例如 1 条／2 条／≥3 条——这是本波的核心表，多跳能力看这里）。JSON 里既有键不动，新键加在行上。

## 漂移门检（本波必须有）

R6e 的数字已经记档（`impl/R6e-verification.md`），所以把其中几个写成断言，防止这次改动意外动了排序或候选池：

- 全量时（`--limit-convs` 为 0）必须仍打印并断言：`P_legacy` `0.0%/0.0%/空并集 100.0%`、`T` `56.0%@5 / 61.8%@10`、`A12 ranked @10 = 59.0%（1170）`、`A4 ranked @10 = 56.0%（1110）`、`B4 ranked @10 = 53.6%（1062）`、`B12 ranked @10 = 55.9%（1108）`、legacy 四条臂 `A4 36.4%（722）／A12 15.2%（302）／B4 36.4%（722）／B12 15.8%（314）`。任一不符 → 非零退出并打印差异（**不要**改这些期望值去迁就）。
- 保留既有的其它门检（卡片必带 bm25 分、atom ao_id 在台账内、投影卡能覆盖到 dia、排序不出重复 dia、四条实臂 ranked 空并集不得 100%）。
- 一致性：每题 gold 去重后 `gold_n == len(set(gold))`，且 `coverage@k` 与 `all_gold@k`、`mrr` 三者互相自洽（例如 `all_gold@k` 为真时必须 `coverage@k == 1.0`；`mrr > 0` 当且仅当 `coverage@10 > 0`）。任一不自洽 → 非零退出。

## 报告要写

- 新文件 diff（只有这一个文件）；`git show --name-only`。
- **总表**：臂 × 口径 × {any-hit@5/@10、coverage@5/@10、all_gold@5/@10、mrr}。
- **按 gold 条数分组的 all_gold@10 与 coverage@10**（多跳能力）。
- 按 category 的 all_gold@10。
- 一句话回答：**在新指标下，atom 通道与 T 的差距是多少？投影通道与 atom 的差距是多少？**（R6e 结论在新指标下是否仍成立）
- 你自行选定的地方（mrr 平局处理、gold 条数分组边界）与完整运行命令。零 LLM、全量 10 会话。
