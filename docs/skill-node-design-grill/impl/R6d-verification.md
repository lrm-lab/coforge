# R6d 独立验证（ZCode，2026-09-30）

派发件：`R6d-brief.md`。cursor 报告：`R6d-cursor-raw.log`。提交：**`fbb816f50`**（`bench(causal-memory): projection-channel arm on LoCoMo (zero-LLM)`，父 `5aebd83cb`，未 push）。

**一句话**：因果通道有了第一个离线数字——**B 臂（只开投影，零 LLM，确定性 fallback 视图）hit@5 = 306/1982 = 15.4%，hit@10 = 722/1982 = 36.4%，空并集 0/1982**。这个数字与 cursor 报告逐位一致，且经我独立重建的探针与全量复算核对。

## 1. 提交审计（越界检查）

| 检查 | 结果 |
|---|---|
| `git show --name-only fbb816f50` | **只有** `benchmark/causal_memory/l1_locomo_projection_arm.py`（+570 行，新文件） |
| `git diff 5aebd83cb fbb816f50 -- benchmark/causal_memory/l1_locomo_hitk.py` | 空（**逐字未变**） |
| `git diff e8a8babf4 HEAD -- .../l1_locomo_hitk.py` | 空 —— 它仍是冻结基线 `eval/l1-locomo-hitk-full.json` 的同一个产出者 |
| `git diff --name-only 5aebd83cb fbb816f50 -- openviking tests pyproject.toml uv.lock` | 空（**源码零改动**，本轮纯评测件） |
| 工作树 | 干净；分支 16 个提交，未 push |
| ruff check／format --check | `All checks passed!` / `1 file already formatted` |
| `py_compile` | 通过 |

依赖面：只用了既有依赖（`openviking` 包内 + 标准库），没有新增。台账分页走生产的 `_page_ao_records`（内部 `list_ao_ledger(include_live=True)` 翻页），行形状过生产的 `_view_ao_record`——**没有手搓领域对象**，也没有创建 `ov.conf`、没走被暂停的 live 栈。

## 2. 机制探针（我自己写的，不导入 cursor 的新文件）

`/tmp/probes/exp_r6d_projection_chain.py`：4 条假消息 → `AOLedger`（每消息一个 `segment_id`／`participant_id`）→ `_page_ao_records` → `_view_ao_record` → `build_minimal_fallback_view` → `ProjectionRegistry.register(acl_labels=("locomo",))` → `InfluenceProjectionAdapter(content_resolver)` → `HybridRetrievalFacade`（投影 4 座）。**14/14 通过**：

- 台账往返后 action 里的 `segment_id`／`participant_id` 仍在（`_text_field` 会看 `action`，`trajectory_index_hook.py:110-119`）；
- `len(blocks) == len(atoms)`、`construction_mode == "fallback"`；
- 卡片数 == blocks 数；`search(principal_labels=("locomo",))` 全见；**空 principal 与不相交 principal 都返回 0**（fail-closed 仍在，且门在门面路径上也生效）；
- 卡片 → `source_pointer.block_or_claim_id` → block → `source_refs[0].ao_id` → dia 能正确回溯（`xavier` 命中 `d2:1`、`d3:1`）。

**探针顺带查出一个必须记账的事实**：带 resolver 取回 2 张卡，**不带 resolver 取回 0 张**。原因是 fallback 的 block 摘要是占位串 `segment <segment_id> sequences a-b`（`influence_view.py:1661`），`input`／`output` 为空，而投影通道的 BM25 文档 = 摘要 + card_id + semantic_type + 解析出的 AO 正文（`retrieval_facade.py:1158-1164`）。**生产唯一的构造点 `retrieval_wiring.py:72` 没有传 `content_resolver`**，所以今天生产里 fallback 形状的投影通道是内容盲的；B 臂的数字因此是「接了 resolver 的**上界**」。已记为待裁定第 18 条，本轮不改实现。

## 3. 数字核对（我用自己的聚合脚本独立算）

`/tmp/l1-locomo-projection-arm.json`（cursor 全量跑的逐题件）独立聚合：

| 臂 | hit@5 | hit@10 | 空并集 |
|---|---|---|---|
| P（facts，通道暂停） | 0.0%（0） | 0.0%（0） | 100.0%（1982/1982） |
| T（词重叠参考） | 56.0%（1109） | 61.8%（1225） | — |
| **B（投影，fallback＋resolver）** | **15.4%（306）** | **36.4%（722）** | **0.0%（0/1982）** |

按 category 的 B@10（与 cursor 报告一致）：cat1 27.3%（282）／cat2 44.2%（321）／cat3 26.1%（92）／cat4 36.3%（841）／cat5 39.0%（446）。B 并集大小：mean 15.0、median 15、max 37、**min 1**（没有一道题是 0）。数据自洽性：`B_hit5 ⊆ B_hit10` 违反 0 例（`any_hit` 用同一个列表，应当如此）。

**与冻结基线的逐行对照**（`eval/l1-locomo-hitk-full.json`，1982 行）：

| 对照项 | 结果 |
|---|---|
| 行数／每会话题数分布 | 完全相同 |
| `question` 逐行 | **0 处不同** |
| T 的两个 hit 逐行 | **0 处不同**（冻结 T 1109/1225 ↔ 新跑 1109/1225） |
| P 的两个 hit | 343 处不同（冻结 230/343 → 新跑 0/0） |
| `p_union_size` | 1982 处不同（冻结非零 → 新跑全 0） |

P 的差异**正好是 R6c 已归因的 fact 通道暂停**（`FACT_LANE_PAUSED=True`，`retrieval_facade.py:114`，分支第一个提交 `988148ad8`），不是本波引入；冻结基线是暂停**之前**跑的。T 与题干逐行一致，是「本波没有碰错参照臂」的硬证据。

## 4. 全量复跑与同座位对照臂

**（a）我自己全量复跑一遍**（`/tmp/r6d-zcode-rerun.json`）：

- stdout 门检如期生效：`P/T match the frozen baseline (P 0.0%/0.0%/empty 100.0%, T 56.0%/61.8%)`；10 个会话每个都打印 `atoms == blocks == cards`、`mode=fallback`（419／369／663／629／680／675／689／681／509／568）。
- 链路回溯样例打印出来且自洽：`block_or_claim_id=fallback-session_1:D1:3-3-3` → `dia_id=D1:3`、`dia_in_gold=True`、`keyword_in_ao_text=True`。
- **逐题 JSON 与 cursor 那次跑字节完全相同**（`md5=df02fedb955fce9b6d38e4501be022eb` 双方一致，`cmp` 无差异）→ 判分器**可复现**。可复现的原因是脚本把 `revision_id` 固定成 `post-run:{session}:l1`（构建器默认发 uuid，而 card id 进 BM25 文档）。

**（b）同座位对照臂**（我另写 `/tmp/probes/exp_r6d_control_arms.py`，把 fact 通道经**构造参数** `fact_lane_paused=False` 打开——不改文件、不改模块全局）：

| 臂 | 座位 | hit@5 | hit@10 | 并集 mean/max |
|---|---|---|---|---|
| A4：segment_atom 通道，通道开 | 4 | **15.7%** | **36.4%** | 14.98 / 37 |
| A12：segment_atom 通道，通道开 | 12 | 11.4% | **15.2%** | 34.94 / 90 |
| B：投影通道（fallback＋resolver） | 4 | 15.4% | **36.4%** | 15.00 / 37 |

两条重要读数：

1. **A12 精确复现 R6c 的「HEAD＋掰回开启」数字 15.2%@10**（R6c 用的是改脚本内常量那条路，我用构造参数这条路，两边一致）——说明我的对照脚本本身可信。
2. **B ≈ A4（15.4 vs 15.7 @5；36.4 ↔ 36.4 @10）**：在**同座位数**下，因果投影通道与「直接对消息正文做 BM25」的 atom 通道**没有可测差别**。也就是：在 fallback 形状的视图上，投影通道目前等于 atom 通道的第二份拷贝——**既不亏也不赚**。B 的 36.4% 不是「因果结构带来的收益」。
3. **座位越多，这个口径下的分数反而越低**（A12 < A4）：因为排序是「按关键词逐个取前 k、再按首次出现去重」，并集从 15 涨到 35，gold 被挤出前 10。**这是口径的伪影，不是通道变差**——`hit@k` 在这个口径下被并集规模拉扯，A12 与 B 不可直接比。冻结基线里 P 的 12 座 17.3%@10 同样受这个拉扯。

**（c）逐行交叉核对**（我的实现 vs cursor 的实现，1982 行）：行序与 gold 对齐；**hit@5 差异 0 行、hit@10 差异 6 行、并集大小差异 69 行**，而两侧聚合都是 306/722。差异根因：我把 `revision_id` 写成了 `...:zcode`（cursor 用 `...:l1`），card id 因此不同，而 card id 会进 BM25 文档、并在**平局**时决定次序（`registry.search` 按 `(created_at, card_id)` 排序）。判为**良性**（聚合相同、差异只在平局），但顺带暴露一个口径事实：这个通道的排名对平局敏感，而平局由不透明 id 决定。

## 5. 观察与限制（给读数字的人）

1. **B 的排序口径与 T 不同**。B 沿用 P 的「按关键词逐个 retrieve，卡片首次出现顺序去重」，每次查询只取 4 张（profile 的投影座位），所以并集 median 15、max 37——`B@10` 是「这个扩散并集的前 10」，不是全局 BM25 排名；T 是对全部 AO 的全局 idf 排名。**B@10 与 T@10 不能当同一把尺子**（这也是 P 的既有口径，为了可比性才沿用）。第 4(b) 节还证明这个口径**会被并集规模拉扯**（同通道 4 座 36.4% → 12 座 15.2%）。
2. **B 这一轮几乎全部来自 fallback＋resolver，不含因果结构**，而且**与同座位的 atom 通道打平**（第 4(b) 节）。因果结构（claim、子图、失败标记、coverage）在 fallback 视图里**一次都没出现**。所以这个数字说明的是**管线通了、能给数、且不比直接 BM25 差**，不是「因果检索的收益」——收益问题要等自适应视图（第 15 条／#125）。
3. **B 是上界**：生产没接 resolver（第 18 条），所以按今天的生产接线，fallback 形状的投影通道会低于这个数。
4. **fallback 的文档内容几乎只剩「结构串」**：不带 resolver 时，文档里可匹配的只有 `segment`／`sequences`／`session_1`／`d1`／`3` 这类来自段 id 的 token（`influence_view.py:1661` 的占位摘要），也就是说**数字型问题会撞上 dia id 里的裸数字**——一条小的精度渗漏。这条与第 18 条同源。
5. 两个脚本都会在 `/tmp` 留 `mkdtemp` 目录不清理（既有脚本同行为），本轮没有新的写盘面。
6. **重复代码是已知代价**：新脚本把 `_tokens`／`_STOP`／`token_ranked_dias`／`any_hit`／`production_ranked_dias` 复制了一份，为的是让基准文件逐字不变。好处是脚本自带的 P/T 冻结基线断言**同时充当这份拷贝的漂移探测器**——原文件若变、数字就会不符而失败。风险私有函数改名（`_page_ao_records`／`_view_ao_record`）会让脚本在 import 期大声失败，可接受。
7. 本轮**没有加 pytest 测试**：产物是跑分件，它的不变式以运行期门检形式强制（`_fail` 非零退出：blocks==atoms、claims==0、卡片数、`search` 非空与不相交标签取空、B 空并集≠100%、链路回溯样例存在、P/T 冻结基线；`--limit-convs` 时跳过基线那一条）。`openviking/` 零改动，所以既有测试面按构造不变；我复跑聚焦 6 文件 **66 passed**，`tests/test_trajectory_index.py` 仍是 R6b 记录在案的那 **2 个基线失败**。

## 6. 结论

- 本波**没有越界**：`benchmark/` 只新增一个文件，`l1_locomo_hitk.py` 逐字未变（且自 base 提交起未变），`openviking/` 零改动，未 push。
- 因果通道拿到第一个可用数字：**B = 15.4%@5 / 36.4%@10（fallback＋resolver，4 座）**，空并集 0，链路可回溯，全量跑**字节级可复现**。
- 但经对照臂，这个数字**不能读成「因果检索的收益」**：同座位数的 atom 通道是 15.7%@5 / 36.4%@10——**打平**；而 12 座的 atom 通道只有 15.2%@10，说明**当前「按关键词并集首次出现」的口径会随并集规模退化**，跨座位数比较无效。真正的收益问题要等带因果结构的自适应视图（第 15 条／#125），并且**先要把判分口径从「并集首次出现」换成「候选全局排序」**，否则自适应视图也会被同一个伪影压住。
- 新增待裁定：第 18 条（生产未接 resolver；B ≈ A4 支持「先不接」）与第 19 条（判分口径）。
