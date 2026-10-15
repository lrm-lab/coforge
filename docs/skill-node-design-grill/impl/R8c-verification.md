# R8c 独立验证（ZCode，2026-10-01）

派发件：`R8c-brief.md`（设计裁定 #149–#152）。cursor 报告：`R8c-cursor-raw.log`。提交：**`7bafc6324`**（`feat(session): type the block kind on view blocks`）＋ **`19c8cf934`**（`bench(causal-memory): retest the diagnosis-side ruler on typed block kinds`），基线 `8d3c25a97`，合起来 4 个文件、未 push。

运行件：cursor 的 `/tmp/sb-influence-r8c/`（抽取）与 `/tmp/r8c-typed/`（尺子）；**我的重跑** `/tmp/zcode-verify/r8c/`（另一个 `--out`）。我的探针：`/tmp/probes/r8c_gates.py`、`r8c_gates2.py`、`r8c_ablation.py`、`r8c_v2rank.py`，输出留在 `/tmp/zcode-verify/r8c/probes/`。

**一句话**：R8c **通过**。生产侧 diff 就是那**一个加性字段**（`influence_view.py` 23 插入 / **0 删除**，含 `validate()` 不变量、`to_dict`／`from_dict`、旧载荷缺键读成 `unknown`）；抽取侧只是把画布**已经算好的** `item["kind"]` 透传下去并能拒收词表外的值，没有二次推断；**抽取与尺子各自三方独立运行逐字节相同**（`790f9d2f…`、`c1f19e2e…`）；三条硬门我用自己写的规则复算全部成立（R7b 结构性名次 30/30、`_subgraph_retrieval_text` 在 v1／v2 载荷上 14/14 哈希相同、`boundary_v2` 与 R8a `tail_shape` 14/14）；878 个块的 `block_kind` 不变量 0 违例、878/878 旧载荷读成 `unknown`；受影响区测试**同一命令**下 HEAD 238 通过 / 基线 234 通过、**0 失败**（差额正好是新测试的 4 项）；3 个收集错误在两个提交上都一样。**两件报告没写的要进判决**：(1) **全部 15 条 fork 的 `content_hash` 都变了**——加性字段进了 `block.to_dict()`，而 `compute_content_hash` 覆盖块载荷，于是溯源指纹整体漂移（身份与幂等键 0 变化，见 §7.1）；(2) 报告的消融**只隔离了 `block_kind_profile`**，两列都把 `boundary` 钉在 v1 语义上，**类型化边界对名次的作用没有被报**——我补算了那一列，见 §7.2。

## 1. 提交审计

| 检查 | 结果 |
|---|---|
| `git show --stat 7bafc6324` | `influence_view.py` 23+/0−、`sb_influence_extraction.py` 30+/1−、`tests/test_influence_block_kind.py` 114+/0− |
| `git show --stat 19c8cf934` | 只加 `benchmark/causal_memory/r8c_typed_truncation.py` 1047+/0− |
| `git diff --name-only 8d3c25a97..HEAD` | **恰好 4 个文件**（上面四个），无第五个 |
| 禁改路径 | `retrieval_facade.py`、`subgraph_forks.py`、`causal_experiences.py`、`r7b_structural_signature.py`、`r7b_discriminability.py`、`l1_locomo_hitk.py` **0 行 diff**；`tests/` 里**没有修改**任何既有文件（只新增一个） |
| 工作树 / push | 干净；分支无 upstream、本地无该分支的远端 ref、reflog 里 `push` 计数 0 ⇒ **未 push** |
| 依赖 | 未加（只 import 生产模块与 stdlib） |

## 2. 生产 diff 是不是「只有一个加性字段」

`openviking/session/influence_view.py` 的 5 处改动我逐段看过（`git diff 8d3c25a97..HEAD`）：

| 位置（HEAD 行号） | 内容 |
|---|---|
| 29–39 | `BLOCK_KINDS`（含 `unknown`）与 `BLOCK_KIND_ROLES`（`unknown` **不在**映射里；值域 ⊆ `BLOCK_ROLES`） |
| 380 | `InfluenceBlock` 的**最后一个**字段 `block_kind: str = "unknown"`（有默认值 ⇒ 既有 10 个构造点不破） |
| 392–397 | `validate()`：值域必须是 `BLOCK_KINDS`；非 `unknown` 时 `BLOCK_KIND_ROLES[kind]` 必须等于 `role`，否则 `ValueError` |
| 449 | `to_dict()` 写出 `block_kind` |
| 480–481 | `from_dict()`：缺键填 `"unknown"`，只读已知键 |

**加性是字面的**：该文件 diff 为 **23 插入 / 0 删除**，没有整文件重排、没有顺手改别处。**旧载荷兼容我实测**：把 R8b 的 14 份检查点载荷喂给 `from_dict`，**878/878 个块读成 `unknown`**（§5.4）。

## 3. 抽取侧：是透传，不是推断

`sb_influence_extraction.py` 的 diff（30+/1−）我全看过，只有三件事：

1. 构造块时 `kind = item["kind"]`，若不在 `BLOCK_KINDS` 或等于 `"unknown"` 就 `_fail`（**新草稿不许写 `unknown`** 这条变成了硬门）；
2. `block_kind=kind` 传给 `InfluenceBlock`；
3. 报告加 `block_kind_distribution`（按 `to_dict()` 块载荷计数）并打印。

**这个词表是画布的判断，不是 R8c 的新推断**：`assistant_text` 在画布尾部改写处被归成 `conclusion`（末尾那段）或 `orchestrator`（前面的），`omitted` 在 `_build_blocks` 开头就 `continue`（[`sb_influence_extraction.py:699-704`](/home/zhoujie22/river2_0/OpenViking/benchmark/causal_memory/sb_influence_extraction.py:699)、[`:815`](/home/zhoujie22/river2_0/OpenViking/benchmark/causal_memory/sb_influence_extraction.py:815)）——R8c 只是把画布**早就定好的**种类写进类型字段。也正因此 `role` 字段一个字节都没变（`tool_call`／`tool_result` 本来就都是 `agent_action`），这解释了门 2 的 14/14 与 §6 的 `role_profile` 恒定。

**词表在本语料上没有被走满**：878 个块的分布是 `task 14 / tool_call 416 / tool_result 440 / conclusion 8` —— **`orchestrator` 一个实例都没有**，`unknown` 0。任何「以 `orchestrator` 为极」的对比在这份数据上和 R7b 的 `call_cut` 一样**没有实例**。

## 4. 确定性：抽取与尺子各三方独立运行一致

| 产物 | cursor 第一次 | cursor 第二次（`--resume`） | **我的第三次**（另一个 `--out`） |
|---|---|---|---|
| 抽取 `report.json` | `790f9d2f83b3bec6abf04732b74768f385bddc9e77a42bf19f300e98abe879be` | 同 | **同** ⇒ 逐字节相同 |
| 尺子 `report.json` | `c1f19e2e2ae9ebd45157df6e446db3d9990bfef1b211b97b38642b7dbe59ddf7` | 同 | **同** ⇒ 逐字节相同 |

抽取报告的 `TOOL_CALLS_SUM` = **444**，与 R8a 一致（跨波不变量没被打断）。尺子 `policy` 里引用的 R7b 报告哈希 `2c77d55f7d53e7a01980615dbacfb13646f4d70482a44b0f89abb8679e9f73fe` 与 R7b 原件相同。

## 5. 硬门复算（我自己写规则／自己调生产，不导入 cursor 的脚本）

### 5.0 门 1：词法臂逐字调用生产，且数字与我的重算一致（6/6）

`/tmp/probes/r8c_lexical_arm.py`：我用 `R7B._adapter(...)` 在 **v2 窄检查点**上自己建生产 `RetrievalSubgraphAdapter`，对 6 个查询**自己发起生产调用**，再自己按生产排序函数重算全序：

| 检查 | 结果 |
|---|---|
| `R7B._lexical` 是否调生产 | `RetrievalSubgraphAdapter.retrieve_historical_subgraphs`，且断言 `fn.__module__ == "openviking.session.retrieval_facade"`（[`r7b_discriminability.py:619-627`](/home/zhoujie22/river2_0/OpenViking/benchmark/causal_memory/r7b_discriminability.py:619)） |
| 生产常数来源 | `SUBGRAPH_TEXT_POLICY_VERSION`／`DIAGNOSTIC_SUBGRAPH_HIT_CAP` 由 R7b 从**生产模块 import**（[`r7b_structural_signature.py:30`](/home/zhoujie22/river2_0/OpenViking/benchmark/causal_memory/r7b_structural_signature.py:30)），R8c 再经 R7B 读；我实测运行期取值 `subgraph-text-pending-v0`／`3` |
| 我的生产调用 top-3 vs 报告 `adapter_top3` | **6/6 相同** |
| 我的生产调用 top-3 vs 我自己重算的生产排序前缀 | **6/6 相同**（池子每查询 5 个候选，`sg-tail`） |

### 5.1 门 2：词法通道看不见新字段（14/14）

`/tmp/probes/r8c_gates.py`：对 14 份主修订，分别用 v1／v2 载荷调用生产的 `_subgraph_retrieval_text`，逐份取 SHA256 ⇒ **14/14 相同**（其中 6 份有子图、8 份空串）。即：加这个字段**没有**改变任何进入 BM25 的文本，`SUBGRAPH_TEXT_POLICY_VERSION` 仍是 `subgraph-text-pending-v0`。

### 5.2 门 3：规则没有漂（30/30）

同一探针：我在 **v1 检查点**上用**自己按规则文本实现**的六条字段规则重算 6 查询 × 5 候选的结构名次，与 R7b 报告的 `structural_rank` **30/30 全等**（`FIELD_WEIGHTS_V1` 也在启动时断言与 R7b 的权重表相同，否则 `_fail`）。

### 5.3 门 4：wiring 正确（14/14）＋ 我的口径更正

`/tmp/probes/r8c_gates2.py`：从 v2 载荷取**修订级尾块**的 `block_kind` 推 `boundary_v2`，与 R8a 检查点里的 `tail_shape` 比 ⇒ **14/14**（4×`cut:toolCall`→`call_cut`、2×`cut:toolResult`→`result_cut`、8×`text_end`→`text_end`）；6 个窄子图的**子图尾块 ＝ 修订尾块**也一一核过（都 `True`）。

**口径更正（我自己的第一版探针错了）**：我最初从**子图成员**里取尾块，只得到 6/14，另外 8 份显示 `no_subgraph`。原因不是实现错，而是那 8 份修订**根本没有子图**，`boundary_v2` 只在有子图时才有定义。改成**修订级**尾部即为 14/14 —— 也就是 cursor 用的那个口径。这条写在这里是为了说明：报告的 14/14 是「修订级尾部」的陈述，**不是**「14 个子图」的陈述。

### 5.4 门 5 的一半：不变量与旧载荷（我自己复算）

| 检查 | 结果 |
|---|---|
| `block_kind ∈ BLOCK_KINDS` 且与 `role` 相容 | 878 个块 **0 违例** |
| 分布 | `task 14 / tool_call 416 / tool_result 440 / conclusion 8`（合计 878） |
| v1 载荷缺键 | **878/878 → `unknown`**，`from_dict` 不炸 |

## 6. 消融复算：他们的两列我对上 30/30

他们的消融是 `v1 字段集` 与 `v1 ＋ block_kind_profile(权重 2)` 两列，**两列都把 `boundary` 钉在 v1 语义**。我用**自己的算术**重算这两列（每对候选逐字段加权、自己按 `(session_id, subgraph_id)` 平局排序），**6 查询 × 5 候选的 30 个值全部对上**（`/tmp/probes/r8c_ablation.py`）。报告自报「30 个候选里 19 个 delta 非 0」，我从矩阵重数也是 **19**。

字段恒定性的独立复算（他们的表跟踪 14 个字段、恰好 4 个非常数）：

| 字段 | 我的重算 | 报告 |
|---|---|---|
| `boundary`（v1 规则） | 6 个全 `result_cut`（1 个取值） | distinct 1 ✓ |
| `block_kind_profile` | 2 个取值：`(1,6,5,0,0)`×3、`(1,5,6,0,0)`×3 | distinct 2 ✓ |
| `boundary_v2` | 2 个取值：`call_cut`×4、`result_cut`×2 | distinct 2 ✓ |
| `member_gap` | 70／41／8／55／10／11（6 个都不同） | distinct 6 ✓ |
| `relation_profile` | 2 个取值：`0001`=(8,2)、其余=(10,0) | distinct 2 ✓ |
| `role_profile`／`coverage_crossing`／`anchor_incidence`／其余 | 常数 | distinct 1 ✓ |

## 7. 报告没写的两件事

### 7.1 加性字段让**全部 15 条 fork 的 `content_hash` 都变了**（必须记账）

我把 R8b 与 R8c 两份抽取报告做递归语义 diff，结果是：**只有**两类差异 —— 新键（`block_kind_distribution`、`episodes[*].block_kind_counts`）以及**全部 15 条 fork 写记录的 `content_hash`**（连同 `readback_detail.content_hash` 镜像）。实测：`content_hash` 变化 **15/15**，而 `fork_revision_id`、幂等键 `(view_revision_id, subgraph_id)`、`fork_node_id` 变化 **0/15**；`l3` 与 `control` 两节深度相等。

机制：`InfluenceViewRevision.content_hash = compute_content_hash(blocks, claims, coverage, retrieval_subgraphs)`，其实现是「`{"blocks": [block.to_dict() for block in blocks], …}` 的规范 JSON 取 sha256」([`influence_view.py:788-800`](/home/zhoujie22/river2_0/OpenViking/openviking/session/influence_view.py:788))，而 fork 的接地／证据记录直接引用修订的 `content_hash`（[`subgraph_forks.py:204`](/home/zhoujie22/river2_0/OpenViking/openviking/session/subgraph_forks.py:204)、[`:223`](/home/zhoujie22/river2_0/OpenViking/openviking/session/subgraph_forks.py:223)）。块载荷多了一个键 ⇒ 哈希必然变。

**判定**：这是**一次内容哈希的正常行为**（内容变了，指纹就该变），身份与幂等完全不受影响（三把键都与它无关，`fork_node_id` 是 `uuid5(workspace_id, anchor)`、`revision_id` 是 `uuid5(view_revision_id, subgraph_id)`），写入形态 15 写 → 9 节点也与 R8b 相同。但它是**外部可见的溯源漂移**：任何在改动前落库的 fork，其 `content_hash` 与改动后重算的结果**不相等**，跨版本比对必须走身份键而不是哈希。cursor 的报告没有提这一条，判决里要写。

### 7.2 `boundary_v2` 对名次的作用没有被报（我补算的那一列）

报告的两列都把 `boundary` 钉在 v1 语义，所以**「类型化边界进了签名会怎样」在这份报告里没有读数**（`boundary_v2` 只出现在恒定性与 wiring 两节）。我按设计意图补了一列（boundary 换成 `boundary_v2`、查询与候选**都**换、profile 权重 2），`/tmp/probes/r8c_v2rank.py`：

- **6/6 查询的 top-1 都是同类**（`call_cut` 查询选出 `call_cut`，`result_cut` 选出 `result_cut`）；
- 与他们的 `rank_v1_plus` 列相比 **14/30 个名次不同**（与 `rank_v1` 比是 21/30）；
- 其中 **`0001` 那一行是例外**：五个候选**全部同分 14**（该查询的 `relation_profile=(8,2)`、`member_gap=70` 与任何候选都不等；三个 `call_cut` 候选拿边界 +2、两个 `result_cut` 候选拿 profile +2，正好抵消），于是它的 top-1 由**平局规则（会话名序）**给出 —— 和词法臂同一类「夹具命名决定」的读法限制；
- `0003／0008／0012` 三个查询不是平局：同类候选是 **17** 分、异类 13–14 分，优势来自边界与 profile **同时**命中。

反向也值得记：在不加类型化边界的 `v1+` 列里，查询 `0001` 的 top-1 是 `0010`（一个 `result_cut` peer，**异类**）—— 也就是说这份尺子的消融列本身在那一行会指向异类，**换用类型化边界才把它扳回同类**。这仍然**不是效果量**（没有裁决、没有修复链），只说明新字段在真切片上不是惰性的：它能把一处被平局决定的读法变成有量差异的读法。

## 8. 测试与 lint（HEAD vs 基线，同一条命令）

| 检查 | HEAD | 基线（`git worktree` 于 `8d3c25a97`，`PYTHONPATH` 指向该树） |
|---|---|---|
| 受影响区 11 个文件／目录 | **238 通过 / 0 失败** | **234 通过 / 0 失败** |
| 差额 | 正好是 `tests/test_influence_block_kind.py` 的 **4** 项 | — |
| 全库收集 | 10055 项 / **3 个收集错误** | 9988 项 / **同样的 3 个** |
| `ruff check` | 新／改文件：抽取脚本、新测试、新尺子全过；`influence_view.py` 1 个 **C420** | 同一个 C420 在基线就在（行号 1198 → HEAD 1221，正好 +23 行） |
| `ruff format --check` | 同上三个文件已格式化；`influence_view.py` 会重排 | 基线也会重排 ⇒ 既有漂移，非本波 |

- 收集错误的 3 个文件（`tests/service/test_task_processing_time.py`、`tests/storage/test_semantic_processor_permanent_storage_error.py`、`tests/vectordb/test_opengauss_database_integration.py`）在**两个提交上都是同样 3 个**，与本波无关。
- **基线的可证伪性我核过**：在 `/tmp/baseline-8d3c25a97` 里 `import openviking` 解析到**该树自己**的 `influence_view.py` 且没有 `block_kind`（PYTHONPATH 压过了 pip 的 editable finder），所以那次「基线」测的确实是基线代码。
- 两树全库收集差 **67 项**：其中 **4** 项是本波新测试，另 **63** 项在 4 个 git 绑定测试文件里（`tests/agfs/test_git_binding.py:15` 的 `pytest.importorskip("ragfs_python")` 之类的收集期门），是「基线 worktree 里 RAGFS 绑定起不来」这一**环境**差异，与 R8c 无关（受影响区两树的每文件收集数完全相同）。
- 与 cursor 报告的读数差异我如实记：它写「相关测试 113 项里 112 项通过」，失败的是 `test_acl_change_without_revalidation_callback_warns_once`，并自称把本波改动撤掉后同样失败。我这一轮在 HEAD 上跑的任何子集（含该测试）都是 **0 失败**，未能复现这一项；早先我在另一个更大的选择集里见过 3 个 `warns_once` 失败，但那次 HEAD 与基线**失败集完全相同**（181 vs 177 通过、各 3 失败），同样不指向 R8c。**结论不受影响**：可复现的比较里两边都是 0 失败。

## 9. 结论

1. **R8c 通过**：生产 diff 恰好是一个加性字段（23+/0−）、抽取是透传带 fail-fast、抽取与尺子三方独立运行字节相同、三条硬门我自己复算全部成立、不变量 878 块 0 违例、旧载荷 878/878 兼容、受影响区 0 失败且差额正好是新测试 4 项。
2. **设计缺口 #147 被填上，而且是可验证地填上**：`boundary_v2` 从**块级类型字段**推出，与 R8a 记录的 `tail_shape` **14/14 一致** ⇒ R7b 判决里「两种截断在类型字段上分不开」这一条被解掉：现在类型字段分得开（`call_cut` 4 个、`result_cut` 2 个，不再是 6 个 `result_cut`）。仍**不**等于效用：改名次 ≠ 找对子图（无裁决、无修复链）。
3. **两处补记进判决**：**(a)** 15 条 fork 的 `content_hash` 全部漂移（身份／幂等不受影响，但跨版本比对不能用哈希）；**(b)** 报告没报「类型化边界进签名」这一列，我补算的结果是 6/6 同类 top-1、`0001` 一行靠平局规则、与 `v1+` 列差 14/30 个名次。
4. **本语料仍读不出效果量**（报告守住了这条，标签仍是 `基于夹具，判别力 ≠ 效果量`）：结构通道只能报一致性（Spearman／top-3 Jaccard），不能报胜负；`orchestrator` 在这一语料上零实例。
5. 未动 live 栈、未调用模型、未 push；`l1_locomo_hitk.py` 与两个 `r7b_*.py` 字节不变。

## 10. 残留

- **`position_kind="cut"` 的语义本波没动**（只把**块级**种类写成类型）：失败锚点仍是 `cut`，两种截断的**锚点位置种类**依旧不可分 —— 要分它得改锚点侧，属后续波。
- **类型化字段没有进检索文本**（门 2 的 14/14 是**不变**的证据，不是收益的证据）：`SUBGRAPH_TEXT_POLICY_VERSION` 仍是 `subgraph-text-pending-v0`，词法通道照旧看不见 `block_kind`；要让它可见得改那个版本号，本波刻意没改。
- **`block_kind` 目前只有 `sb_influence_extraction` 一条写入路径，生产侧另有两个构造点不写它**：`build_minimal_fallback_view`（[`influence_view.py:1686`](/home/zhoujie22/river2_0/OpenViking/openviking/session/influence_view.py:1686)，段块 `role="agent_action"`、无 `block_kind`）与 `_with_diagnosis_root_sink` 的合成端点块（[`:1547`](/home/zhoujie22/river2_0/OpenViking/openviking/session/influence_view.py:1547)），**两者都会落成 `unknown`**。这不是冷路径：`trajectory_index.py:518` 与 `extraction_write.py:168` 都会走 fallback（[`trajectory_index.py:518`](/home/zhoujie22/river2_0/OpenViking/openviking/session/trajectory_index.py:518)、[`extraction_write.py:168`](/home/zhoujie22/river2_0/OpenViking/openviking/session/extraction_write.py:168)）。因为 `validate()` 有意允许 `unknown`（旧载荷兼容），这些视图能通过校验而**一个类型字段都没有**：下游若按 `block_kind` 取值，会在 fallback 视图上看到全 `unknown`（`boundary_v2` 会全退化成 `text_end`）。「新草稿不许 `unknown`」目前靠**抽取脚本的 fail-fast**，不是生产不变量。
- **`content_hash` 漂移的后果没有在存储侧验证**：我没有检查任何已落库的 fork／快照记录是否会被这次改动重算不一致（本波只在报告层面看到 15 条写记录）。
- 未测：诊断侧真实效用（仍无裁决、无修复链）；跨 session／跨 workspace；模型写的七段／branches 在检索里的作用（**#125**）。
