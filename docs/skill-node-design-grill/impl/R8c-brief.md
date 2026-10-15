# R8c 派发件：把「截断种类」写成**类型化字段**，用 R7b 的尺子重测一次（收口 #147；零 LLM／可复跑）

先读 **`impl/R8c-design.md`（本波设计正文，改动面与判据都已冻结）**，再读 `impl/R7b-verification.md` §5.3（#147 的现场证据：为什么轴 A 的负极在真数据上没有实例）、`impl/R7b-design.md` §3（设计要的 `boundary` 是什么）。

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支 `feat/causal-subgraph-retrieval`，基线 **`8d3c25a97`**。**追加新提交；不要 rebase／amend；不要 push；不引新依赖。**

## 0. 一句话

R7b 查明：设计 §3 要 `boundary` 承载 R8a 的 `cut:toolCall`／`cut:toolResult`，但视图里 `tool_call` 与 `tool_result` **都是 `agent_action`**，区别只在块摘要散文里，所以真切片上 6 个尾部全被标成 `result_cut`（其中 4 个 R8a 记的是 `cut:toolCall`）——轴 A 的负极**在真数据上没有实例**。本波把抽屉里已经有的事实（抽取 parse 阶段算出的记录种类）**写成类型化字段**，然后回答：`boundary` 能不能按设计意图恢复、真切片上生产丢掉的字段里还剩几个非恒定。

**这是接线与表示测试，不是效果量测试。**

## 1. 只做三件事

### 1.1 生产 schema：`InfluenceBlock.block_kind`（加性、带默认值，照设计 §2）

- `openviking/session/influence_view.py` 里加 `BLOCK_KINDS`／`BLOCK_KIND_ROLES`；`InfluenceBlock` **末尾**加字段 `block_kind: str = "unknown"`（**默认值必须留**——这样 7 个测试文件与 `benchmark/causal_memory/r7b_discriminability.py` 一个字节都不用改）。
- `validate()`：`block_kind ∈ BLOCK_KINDS`；当 `block_kind != "unknown"` 时还必须 `BLOCK_KIND_ROLES[block_kind] == role`。**新字段是 `role` 的细化，不是并列信息**：老读者用 `role` 全部照旧，任何「新老矛盾」的状态都要被拒。
- `to_dict`／`from_dict` 往返；**旧载荷缺键 ⇒ `"unknown"`**（`from_dict` 只读已知键、不拒绝多余键，两个方向都兼容）。
- **`retrieval_facade.py` 一行都不许改**：`_subgraph_retrieval_text` 保持只读 `summary`／`input`／`output`＋claim 散文，`SUBGRAPH_TEXT_POLICY_VERSION` 不变 ⇒ 词法通道看不见新字段（§4 门 2 要证明它）。`DEFAULT_SCHEMA` 之类不存在，不要引入版本门。

### 1.2 抽取侧：把已有的事实传下去（照设计 §3）

`benchmark/causal_memory/sb_influence_extraction.py`：构造 `InfluenceBlock` 时传 `block_kind=item["kind"]`。**不许重新推断**——不许读摘要文本、不许看 `pattern:` 前缀、不许从 `role` 反推、不许猜；`item["kind"]` 就是 parse 阶段（`:634-655`）与尾部判定（`:693-701`）算出来的那个值，台账里本来就写着它（`:752` 的 `block_kind`）。

重跑到新目录：`.venv/bin/python benchmark/causal_memory/sb_influence_extraction.py --stage all --out /tmp/sb-influence-r8c/report.json`（检查点落在 `/tmp/sb-influence-r8c/checkpoints/`）。**`/tmp/sb-influence-r8b/` 不许动**（v1 记录，门 1 要用）。报告里给 14 个 episode 的 `block_kind` 分布。

### 1.3 尺子重测：新文件 `benchmark/causal_memory/r8c_typed_truncation.py`（照设计 §4）

- **`r7b_structural_signature.py` 与 `r7b_discriminability.py` 一个字节都不改**（已验证的 v1 记录，产物 `2c77d55f…`）；本波只**新增**文件。
- 启动时打印冻结规则（字段清单、权重表、平局、cap、种子），并**断言你的权重表与 R7b 模块的 `FIELD_WEIGHTS` 相同**，不同就非零退出。
- 两条回归门（硬门）：① 在 **v1 检查点**上重算 L2 结构名次，与 R7b 报告 `l2.queries[*].candidates[*].structural_rank` **30/30 全等**；② 14 份修订的 `_subgraph_retrieval_text` 在 v1 与 v2 载荷上**逐条 SHA256 相同**。
- `boundary_v2`：尾部块 `block_kind` → `tool_call:call_cut`／`tool_result:result_cut`／其余 `text_end`（`unknown` 要报出来）。**接线判据：与 R8a 记录的 `tail_shape` 在 14/14 episode 上一致**（各 episode 的 `tail_shape` 从 R8a 检查点的同名字段读，不许手抄）。
- 新签名字段：成员块 `block_kind` 计数（封闭词表＋整数），权重打分前冻结；L2 报 **v1 字段集**与 **v1＋新字段集**两套名次（消融）。
- L1：保留 R7b 的四条轴（同规则，`block_kind` 为 `unknown` 时按 v1 规则走），**新增轴 A′**：尾部 `block_kind` = `tool_call` vs `tool_result`，散文逐字节相同。
- 词法臂**逐字调用生产** `RetrievalSubgraphAdapter.retrieve_historical_subgraphs`，并保留 R7b 那条钉子：每个查询的适配器 top-3 必须等于你自己重算的 `_rank_document_indexes` 前缀。

## 2. 交付与报告

- 两个提交（建议顺序）：① `feat(session): type the block kind on view blocks`（生产＋抽取＋测试）；② `bench(causal-memory): retest the diagnosis-side ruler on typed block kinds`（新跑分件）。标题可改，语义要准。
- 产物：`/tmp/sb-influence-r8c/report.json`（抽取）与 `/tmp/r8c-typed/report.json`（尺子），都支持 `--resume`；两次运行 report **逐字节相同**并给 SHA256。
- 报告（写在最终消息里）必须含：生产改动清单（逐文件逐行说明）、`block_kind` 分布表、**两条回归门的实际数字**、`boundary_v2` vs `tail_shape` 的 14/14 表、消融后的两套名次、L1′ 各轴读数、以及设计 §7 的五条「不回答」原样出现。
- **标签**：L1 一律标「基于夹具，判别力 ≠ 效果量」；**不许出现「结构臂更好」这类效果量表述**；L2 只报分布与一致性，不报胜负。

## 3. 硬约束

- `retrieval_facade.py`、`subgraph_forks.py`、`causal_experiences.py` **一行都不改**。生产侧**只允许**改 `influence_view.py` 的加性字段与 `validate()` 不变量。若你认为还有别处必须改，**停下来报告**，不要顺手改。
- `benchmark/`：只动 `sb_influence_extraction.py`（传一个字段＋报分布）与**新增** `r8c_typed_truncation.py`。**`r7b_*.py` 字节不变**；`l1_locomo_hitk.py` 字节不变；四个既有跑分件不得顺手改。
- `tests/`：允许**新增**测试与（仅当既有测试硬编码了块载荷键集合时）改既有测试，但改动必须逐条在报告里列出。`pytest` 全绿（给通过数）。
- 只读语料；零 LLM；不加依赖；不 push。
- 不动暂停的 live 栈（`eval/NEXT.md` 的「不要动」清单）；不建 `ov.conf`；不重跑／不重归档 `evo-lsk1`。
- **规则冻结在前**：字段清单、权重、平局、cap、种子、`boundary_v2` 派生规则、轴序，全部常量＋**任何分数之前打印**；看到数字后不许改规则／删轴／挑轴。
- `ruff check` ＋ `ruff format --check` 对改动与新文件全过。

## 4. 门检（任一条不过就非零退出）

1. 词法臂逐字调用生产；报告含 `SUBGRAPH_TEXT_POLICY_VERSION` 与 `DIAGNOSTIC_SUBGRAPH_HIT_CAP` 的实际值；适配器 top-3 ＝ 重算的生产排序前缀。
2. **词法不变**：14 份修订的 `_subgraph_retrieval_text` 在 v1／v2 载荷上逐条 SHA256 相同。
3. **打分规则未漂**：v1 检查点上重算的结构名次与 R7b 报告 30/30 全等。
4. **接线判据**：`boundary_v2` ＝ R8a `tail_shape`，14/14。
5. `BLOCK_KIND_ROLES` 与 `BLOCK_ROLES` 的覆盖关系有测试（映射的值域 ⊆ `BLOCK_ROLES`；`unknown` 不在映射里）；一致不变量有测试（`role` 与 `block_kind` 冲突即拒）；旧载荷缺键可读且 `unknown`。
