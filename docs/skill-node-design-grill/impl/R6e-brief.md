# R6e brief：先把 L1 的尺子修准（候选全局排序），再重测各通道

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（HEAD `fbb816f50`，未 push）。**追加新提交；不 rebase／amend；不 push；不引新依赖。**

## 一句话

R6d 暴露了一个口径伪影：**同一条 atom 通道，4 座 = 36.4%@10，12 座 = 15.2%@10**（我实测）。原因是取回口径「按关键词逐个 retrieve、卡片**首次出现顺序**去重成并集」，座位一多并集从 15 涨到 35，gold 被挤出前 10。本波把**排序**换成「候选池的全局名次」（候选池本身不变），把座位数从分数里摘出去，然后在**同一把尺子**下重测 atom／投影两条通道，并保留旧口径出对照。

## 硬纪律（违反即越界）

- **`benchmark/causal_memory/l1_locomo_hitk.py` 与 `benchmark/causal_memory/l1_locomo_projection_arm.py` 都必须逐字不变**（前者是冻结基线 `eval/l1-locomo-hitk-full.json` 的产出者，后者是 R6d 已验证的记录件）。新增**同目录新文件**，例如 `benchmark/causal_memory/l1_locomo_ranked_arm.py`。
- `benchmark/` 下**只允许新增这一个文件**；不动 `evol_bench/`、不动被暂停的 live 栈（`eval/NEXT.md` 的「不要做」清单照旧）。
- **不改 `openviking/` 任何源码、不改任何测试**。需要改源码才能测就**停下报告**。
- 不创建 `ov.conf`。不删改 `/tmp` 下 R6d 的记录件（`/tmp/l1-locomo-projection-arm.json`、`/tmp/r6d-control.json`、`/tmp/r6d-control2.log` 等）。
- 输出只写 `--out` 指定的路径（默认不写仓库内）。

## 要做的事

### 1. ingest 与视图构建沿用 R6d（已验过的链，不要另发明）

- 台账：一条消息一个 AO，`segment_id = f"{session_N}:{dia_id}"`、`participant_id` = 该消息 speaker，`acl_labels=["locomo"]`。
- 视图：`trajectory_index_hook._page_ao_records` → `_view_ao_record` → `build_minimal_fallback_view`（`purpose=PURPOSE_POST_RUN_INDEX`，固定的 `revision_id`），`ProjectionRegistry.register(revision, acl_labels=("locomo",))`，门面 `InfluenceProjectionAdapter(registry, views=[revision], content_resolver=<ao_id→正文>)`。
- **一个会话只需要一个修订**：座位数是 **profile** 参数（`{"fork_branch":0,"projection":N,"segment_atom":M}`），不是视图参数。不要去造「更粗的视图」——`register` 会用同 session／purpose 的新修订 **supersede** 掉旧的，两个修订不能共存。
- 事实通道按既有做法用**构造参数**打开：`HybridRetrievalFacade(..., fact_lane_paused=False)`（别改模块常量、别改文件）。

### 2. 两种合并口径都要跑（这是本波的核心）

对每道题，先按关键词逐个 `facade.retrieve(kw, principal_labels=LABELS, profile=...)` 收集**候选池**，然后：

- **legacy（旧口径，只为对照）**：候选按「首次出现顺序」去重成 dia 列表，`hit@k` 取前 k。
- **ranked（新口径，主口径）**：给每个 dia 一个分数＝**覆盖它的卡片里最高的 BM25 分**（取自 `card.score_breakdown["bm25"]`，`retrieval_facade.py:613-630` 已把真实分数写在卡上），按分数从高到低排 dia，取前 k；同分时先按首次出现顺序、再按 dia id 兜底（要确定性）。
- **rrf（新口径的第二实现，用于交叉检查）**：dia 的 RRF 分 = 对每个关键词累加 `1/(60 + 该关键词返回列表里覆盖它的最优名次)`；同样取前 k。

**两种口径的候选池必须完全一致**——只有排序变。请在报告里用数字证明这一点（同一题同一臂的池大小／并集大小在两种口径下应相同，只有名次不同）。

**卡片 → dia 的回查**（两条通道都要处理）：
- 投影卡：`source_pointer["block_or_claim_id"]` → 绑定修订里的 block → `source_refs[*].ao_id` → dia（一个 block 覆盖多个 AO 时，它的所有 dia 都算这张卡覆盖）。
- atom 卡：`source_pointer["ao_id"]` → dia。
- 去重键：投影卡用 `source_pointer["card_id"]`，atom 卡用 `payload_ref`（atom 卡的 source_pointer 里没有 card_id）。**报告里写清你用的是什么。**

### 3. 要测的臂（零 LLM，全量 10 个会话 1982 题）

| 臂 | profile | 说明 |
|---|---|---|
| `P_legacy` | `{0,0,12}`，通道暂停 | 生产现状（0 分），**只跑 legacy 口径**，用于冻结基线门检 |
| `A12` | `{0,0,12}`，通道开 | 暂停前的生产口径 |
| `A4` | `{0,0,4}`，通道开 | 与 B 同座位数对照 |
| `B4` | `{0,4,0}`，投影＋resolver | R6d 的臂 |
| `B12` | `{0,12,0}`，投影＋resolver | **座位敏感性测试：新口径下 12 座不应再低于 4 座** |
| `T` | — | 纯 Python 词重叠参考（既有实现，逐字复用） |

`A*`／`B*` 四条臂**两种口径都要出数**（legacy 与 ranked；RRF 只需对 `A4`／`B4` 出，用于交叉检查）。

指标：每题 `hit@5`／`hit@10`、并集大小、空并集数；总体与按 category；并附 `A4 vs B4`、`A12 vs B12`、以及同一臂 `4 座 vs 12 座` 在两口径下的对照。

### 4. 门检（任一失败就以非零退出，不要静默）

- **legacy 口径下 `P_legacy` 与 `T` 必须仍等于冻结基线**：`P 0.0%/0.0%/空并集 100.0%`、`T 56.0%/61.8%`（与 R6d 同法比对；`--limit-convs` 时跳过这一条）。
- 每个会话 `len(blocks) == len(atoms)`、`construction_mode == "fallback"`、claims 为 0、卡片数 == blocks 数。
- fail-closed：`registry.search(principal_labels=("not-locomo",))` 为空。
- 非空：`A4`／`A12`／`B4`／`B12` 在 ranked 口径下的空并集必须远小于 100%（若某臂恒为空，是接线错误，报告失败而不是报告 0 分）。
- 一致性自查：同一题同一臂，legacy 与 ranked 的**池大小相同**；`hit@5 ⊆ hit@10` 违反 0 例。
- 把 T 的 61.8%@10 摆在同一张表里——本波要回答的问题之一就是：**新口径下，atom 通道能不能接近 T**（旧口径下差得远，很可能是口径造成的）。

## 提交与报告

- 一条提交，信息形如 `bench(causal-memory): globally ranked L1 arm on LoCoMo (zero-LLM)`。
- 报告必须写：新文件路径；`git diff` 证明两个既有跑分件未变（`git show --name-only` 只有新文件）；完整的臂 × 口径数字表（含 T）；座位从 4→12 在两口径下的变化；`A4 vs B4` 与 `A12 vs B12` 的差值（回答「同座位数下投影通道与 atom 通道是否打平」在新口径下是否仍成立）；旧口径与新口径在同一臂上的差值（说明口径本身值多少个百分点）；你自行选定的地方（合并细则、去重键、平局处理）；以及运行的**完整命令**（含 venv 与 `--data` 路径）。
- 数据：`--data` 默认 `/home/zhoujie22/river2_0/evol_bench/LoCoMo/data/locomo/locomo10.json`；逐题 JSON 写 `--out`。全量大约十几分钟。
