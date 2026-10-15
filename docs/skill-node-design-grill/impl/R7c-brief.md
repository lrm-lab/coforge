# R7c brief：oracle 摘要臂——用数据集自带的人工语义标注量「摘要内容值多少钱」

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（**HEAD `1f388e851`**，未 push）。**追加新提交；不 rebase／amend；不 push；不引新依赖；不创建 `ov.conf`；零 LLM。**

## 一句话

R6e／R7a 证明 L1 的读数已被词法方法打到天花板（atom 59.0%@10 vs 词法参考 T 61.8%），且在**多证据题**上全线崩塌（2 条证据 `all_gold@10` 17.1%、≥3 条 1.1%，见 #129）。本波换一条**非词法**的路：LoCoMo 数据集自带**人工写的语义标注**——`observation`（按 `dia_id` 锚定的逐条观察）与 `session_summary`（逐会话摘要）——把它们填进**自适应视图的 block summary**（走生产写入路径 `freeze_extracted_view`），量出「好摘要值多少钱」：

1. 摘要能不能把读数抬过 `A12` 的 59.0%@10／`T` 的 61.8%@10，**尤其在多证据题上**；
2. **在生产配置（不接 resolver，文档只有摘要＋card id＋语义类型）下，好摘要够不够撑起检索**——这是 #125 值不值得做、#126「不接 resolver」是否要重新考虑的直接判据。

⚠ **这是 oracle 上界实验，只测「内容轴」**（#130）：标注是人写的、且与数据集问题是同一批作者所写（措辞相关性会让数字偏乐观），`observation` 只覆盖 85–94% 的消息。它**不能**用来论证结构（跨消息边）的价值——本轮视图里没有 claim、没有边。报告与 JSON 元数据都必须写明「oracle 上界」。

## 硬纪律

- **只允许新增一个文件**：例如 `benchmark/causal_memory/l1_locomo_oracle_arm.py`。`l1_locomo_hitk.py`（冻结基线产出者）、`l1_locomo_projection_arm.py`（R6d）、`l1_locomo_ranked_arm.py`（R6e／R7a）**一个都不许改**。
- **`openviking/` 与 `tests/` 零改动**（只读产品代码、只写跑分件）。不创建 `ov.conf`。不改 `/tmp` 下既有的记录件。
- 输出只写 `--out` 指定路径（见下面「断点续跑」）。
- **判分件不要另发明**：从 `l1_locomo_ranked_arm.py` import 现成的口径与工具——`build_facade`、`collect_hits`、`_Hit`、`score_pool`、`_coverage_bundle`、`_add`、`_rich_line`、`_gold_bucket`、`_inconsistent`、`_check_family`、`_r6e_drift`／`_print_r6e_gate`、`any_hit`、`token_ranked_dias`、`_question_keywords`、`_tokens`、`_fail`、`_pct`。**指标与排序绝不许复制改动。**（`_print_tables`／`_remember_category`／`_empty_overall` 是按 `_ARMS` 写死的，本波臂名不同，所以**表布局与聚合自己写**——只有这一块自己的，其余全部 import。）这是既有的链式依赖（冻结基线 ← R6d ← R6e/R7a ← R7c），**由 §4 的锚点门检兜底**。

## 数据侧事实（我已核过，直接用）

- `observation`：`conv["observation"]["session_N_observation"][speaker] = [[text, dia_id], ...]`。跨全部会话共 **750** 个不同锚点 dia，其中 **538** 个被多条观察共用（同一 dia 多条 → **按出现顺序拼接**）；另有 **10** 条形状异常的条目（长度不是 2 或第二项不是字符串）——**跳过并报数**。消息覆盖率 85–94%。
- `session_summary`：`conv["session_summary"]["session_N_summary"]`（整段文本，逐会话一条）。**本波只需用它做一件事**：若你想加一个「会话级摘要进不进文档」的旁支变体，必须是**额外**列，不能挤掉主表。
- **不许用 `qa[].evidence` 做任何事，除了判分**（gold 只能出现在打分路径）。

## 要建的东西

### 1. 自适应视图（用生产写入路径，不要手搓）

`openviking.session.extraction_write.freeze_extracted_view(session_id=…, task_run_id=…, view_id=…, revision_id=…, frozen_at=…, blocks=…, claims=…, coverage=…, retrieval_subgraphs=())`：`purpose` 由该函数固定为 `post_run_index`。

- **blocks**：一条消息一个 block（`InfluenceBlock` 构造期强制「单参与者＋单段＋连续 AO」，块不能跨说话人——设计约束，不要绕过）。AO 引用用与 R6d 相同的 ingest（`segment_id = f"{sname}:{dia_id}"`、`participant_id = speaker`）。`granularity_reason` 用库里合法常量（别自己发明字符串）。
- **coverage**：覆盖全部 AO 的 `CoverageManifest`（`total_ao_range`、`inspected_refs`、`included_ranges`、`omitted_ranges=()`、`snapshot_watermark`），按库里既有构造方式写。
- **claims**：**空**（本波不测 claim）。
- 视图要能过 `freeze_extracted_view` 的校验；过不了就**报告失败**，不要改成 fallback。
- `revision_id` **必须固定**（例如 `f"r7c:{variant}:{session_id}"`，随变体不同），理由同 R6d：卡片 id 会进 BM25 文档，uuid 会让同分次序漂移。

### 2. 三个摘要变体（同一套机制，只换 summary 文本，用于隔离变量）

| 变体 | block.summary 文本 |
|---|---|
| `oracle` | 该消息 dia 锚定的人工观察文本（多条按出现顺序拼接）；无锚点的消息**回落到消息原文** |
| `oracle_only` | 同上，但无锚点的消息用占位串（与 fallback 摘要同形）——看「只有人工观察的那些消息」的贡献 |
| `placeholder` | 全部用 fallback 同形的占位串（`segment <segment_id> sequences a-b`）——**机制对照**：它证明「自适应视图这条管线本身」与 fallback 等价，差值全部来自摘要文本 |

### 3. 要测的臂 × 配置 × 座位

用 R6e／R7a 的口径（主口径 `ranked`＝候选池按 max-BM25 全局排序；`legacy` 作基线对照）与同一套指标（`any_hit@5/@10`、`coverage@5/@10`、`all_gold@5/@10`、`mrr`、`gold_n`）。

**每个摘要变体 × 两种配置 × 两档座位**：

- **`no_resolver`（生产配置）**：`InfluenceProjectionAdapter(registry, views=[revision])`——不加 resolver，文档只有摘要＋card id＋语义类型。**这是本波最重要的列。**参照：fallback 形状在无 resolver 时实测**取回 0 张**。
- **`with_resolver`**：加上 R6d 同款 `content_resolver`（AO 正文进文档）。参照：fallback＋resolver 在 ranked 下 53.6%@10（B4）。
- 座位 `4` 与 `12`（profile `{"fork_branch":0,"projection":N,"segment_atom":0}`）。事实通道用构造参数 `fact_lane_paused=False` 打开以便与 A 臂对照（投影座位为唯一通道时这件事对候选无影响，但要在报告里说清）。

**锚点臂（把新数字钉在既有基线上，必须包含）**：`T`、`A12`（atom 12 座 ranked）、`fallback+with_resolver` 4／12 座（＝R7a 的 B4／B12）、`placeholder+no_resolver`（预期 ≈0）。

### 4. 门检（任一失败即非零退出）

- 锚点：`T` 全量仍是 `56.0%@5（1109）/ 61.8%@10（1225）`、`A12 ranked @10 = 1170（59.0%）`，**并且**新指标也钉住：`A12 ranked` `coverage@10 = 54.3%`、`all_gold@10 = 50.6%`、`mrr = 0.3012`；`T` `coverage@10 = 57.2%`、`all_gold@10 = 53.5%`、`mrr = 0.4346`。任一不符 → 非零退出并打印差异（**不要**改期望值迁就）。
- 每个会话：blocks 数 == 消息数；视图 `construction_mode == "adaptive"`；`registry.search(principal_labels=("locomo",))` 非空；不相交标签取空。
- **`placeholder`＋`no_resolver` 必须取回 0 张**（若不是 0，说明文档里混进了不该有的文本 → 报告失败）。
- 每题自洽：沿用 `_inconsistent`／`_check_family`（gold_n／coverage／all_gold／mrr 互相自洽、五种口径同池同并集、无重复 dia）。
- 所有命中的卡片必须能回溯到 block → `source_refs` → AO → dia（沿用 `dias_for_card`）。
- 人工标注使用率打印并写进 JSON 元数据（有锚点的消息数／总消息数／跳过的异常条目数／被多条观察共用的 dia 数）。

### 5. 断点续跑（**本波必须做**，理由见下）

上一波的全量跑分 66 分钟，正好撞上一次 CLI 断网，**整轮白跑、还要重来**。本波臂数约是上一波的 2–3 倍，必须防这个：

- `--out` 逐会话**增量写**（每跑完一个会话就把该会话的题行 append 进 JSON，或写 `--out` ＋ 每会话一个旁文件）。
- `--resume`：`--out` 里已有完整题行的会话**跳过不重跑**，并在日志里打印「skipped（already done）」。
- 跑法：先 `--limit-convs 1` 冒烟，再 `--limit-convs 2`，最后全量；中断了就带 `--resume` 接着跑。报告里给出每一步的耗时与退出码。

## 报告要写

- 新文件路径与 `git show --name-only`；**四个既有跑分件**（hitk／projection／ranked 三个 + 本波新增的 oracle 文件之外没有别的）diff 为 0。
- **主表**：变体 × 配置 × 座位 × {any-hit@5/@10、coverage@10、all_gold@10、mrr}，并排 `T`／`A12`／`B4`／`B12` 锚点。
- **按 gold 条数分组**（1／2／≥3）的 `all_gold@10` 与 `coverage@10`，以及 **cat 1（multi-hop）** 上的同一组数——这是 #129 定的主读数（`any-hit@10` 只作陪衬）。
- 直接回答四问：
  1. `oracle`＋`with_resolver` 有没有超过 `A12` 的 59.0%／`T` 的 61.8%（@10）？
  2. `oracle`＋`no_resolver`（生产配置）到了多少？（对照：fallback＋no_resolver = 0）
  3. `placeholder` 与 fallback 是否等价（机制对照）？
  4. **在多证据题（`gold_n ≥ 2` 与 cat 1）上，摘要把 `all_gold@10` 从 17.1%／1.1% 抬到了多少？**
- 明确写出这是 **oracle 上界**（内容轴），并说明为什么它不能论证结构价值（#130）。
- 运行命令、每阶段耗时、退出码、以及你自行选定的地方（异常条目处理、拼接顺序、`granularity_reason` 取值、coverage 构造、`session_summary` 用没用）。
