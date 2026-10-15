# R8c 设计：把「截断种类」写成类型化字段，再用 R7b 的尺子重测一次（收口 #147）

用户 2026-10-01：「让cursor来做吧」（＝把我给的两条候补里**不花模型预算**的那条派给 cursor：#147 的修法；#125 仍等模型预算授额）。

## 0. 为什么做这一波

R7b 的判决（#146–#148）指出：设计 §3 要 `boundary` 承载 R8a 的 `cut:toolCall`／`cut:toolResult`／`text_end`（「死在等结果」≠「死在没发出去」），但**视图的类型化字段里没有这个区分**——`tool_call` 与 `tool_result` 在视图里**都是 `agent_action`**，区别只躺在块摘要散文里，而签名按隔离要求不读散文。结果是：真切片上 6 个尾部**全是 `result_cut`**（其中 4 个 R8a 记的是 `cut:toolCall`），轴 A 的负极 `call_cut` **在真数据上没有实例**，轴 A 的夹具读数**不可外推**。

本波要做的就是把这件事**拆干净**：如果抽取侧把已经算出来的种类写成类型化字段，那么

- 「类型化通道是常数」这个现象里，**哪些是「抽取没给」、哪些是「通道读不到」**就分开了；
- `boundary` 能不能按设计意图恢复成 R8a 的 `tail_shape`，有一条**可判定的接线判据**（`boundary_v2 == tail_shape` 逐 episode 一致）；
- 生产丢掉的字段里至少会有一个在真切片上**非恒定**，后续波（含 #125）才有东西可用。

**这不是效果量测试**，标签照 R7b：#151 的 L1 一律标「基于夹具，判别力 ≠ 效果量」，L2 只报分布与一致性。

## 1. 现场事实（我逐条读过代码，本波的设计就建立在这上面）

| 事实 | 位置 |
|---|---|
| 视图的块角色只有 4 个值：`task`／`orchestrator`／`agent_action`／`conclusion` | `openviking/session/influence_view.py:28` `BLOCK_ROLES` |
| R8a 的抽取在 parse 阶段**已经**算出每个记录的 `kind`：`task`／`tool_call`／`tool_result`／`orchestrator`／`conclusion`（`assistant_text` 在尾部判定后被改写成 `orchestrator`／`conclusion`，`omitted` 被跳过） | `benchmark/causal_memory/sb_influence_extraction.py:634-655`、`:693-701` |
| AO **台账**里本来就写着这个种类：action 载荷的 `block_kind` ＝ `item["kind"]` | 同上 `:752` |
| 但构造 `InfluenceBlock` 时**没传下去**（`role` 由 `kind` 映射，`kind` 只留在抽取侧自己的 `metas` 里） | 同上 `:822-867`（`role` 映射在 `:822-850`） |
| 生产词法文本只读 `summary`／`input`／`output` ＋ claim 散文 ⇒ 新字段对它不可见 | `openviking/session/retrieval_facade.py:1476-1488` |
| `influence_view.py` 里**没有** schema 版本常量；`from_dict` 只读已知键、不拒绝多余键 ⇒ 加字段两个方向都兼容 | 全文 grep 无 `SCHEMA_VERSION`；`from_dict` 用 `payload.get(...)` |
| `InfluenceBlock(` 的构造点共 10 处（生产 2、测试 7、benchmark 1） | `grep -rn "InfluenceBlock("` |
| 有默认值的新字段 ⇒ 只有**抽取侧**必须显式传；R7b 两件与全部测试保持字节不动 | 本设计 §2 |
| 设计的 `POSITION_KINDS` 里有 `cut`，但 `_position_inside_subgraph` 现在只认 `block:`／`edge:` 前缀，`cut` 走「不匹配、不抛错」分支 | `retrieval_facade.py:1491-1499` |

## 2. #149 生产 schema：`InfluenceBlock.block_kind`（加性、带默认值）

- `InfluenceBlock` 末尾加一个字段：`block_kind: str = "unknown"`（**默认值必须留**：10 处构造点里只有抽取侧需要显式传，R7b 的 `r7b_discriminability.py` 与 7 个测试文件因此**一个字节都不用改**）。
- 新常量：`BLOCK_KINDS = frozenset(("task", "tool_call", "tool_result", "orchestrator", "conclusion", "unknown"))`；映射 `BLOCK_KIND_ROLES = {"task": "task", "tool_call": "agent_action", "tool_result": "agent_action", "orchestrator": "orchestrator", "conclusion": "conclusion"}`。
- **一致不变量**（关键设计点）：新字段是既有 `role` 的**细化**，不是并列信息。`validate()` 要求 `block_kind ∈ BLOCK_KINDS`；当 `block_kind != "unknown"` 时还必须 `BLOCK_KIND_ROLES[block_kind] == role`。⇒ 老读者继续用 `role` 全部照旧，**不存在新老字段互相矛盾的状态**，也不需要改任何既有语义。
- `"unknown"` 的用途**只有一个**：旧载荷没有这个键。`from_dict` 缺键填 `"unknown"`；新写的草稿不许填 `"unknown"`（抽取侧必须给真值；这一点由 §3 的抽取侧改动＋测试保证，**不**在 `validate()` 里禁，以免旧载荷读不进来）。
- `to_dict`／`from_dict` 往返该字段。
- **不动** `retrieval_facade.py` 的任何一行：`_subgraph_retrieval_text` 仍是那三样＋claim 散文，`SUBGRAPH_TEXT_POLICY_VERSION` 保持不变 ⇒ **词法通道看不见新字段**，这正是 §4 回归门要证明的。
- 不引入 schema 版本门（现场没有版本常量，引入只会扩大面）。

## 3. #150 抽取侧：只做「把已有的事实传下去」

- 构造 `InfluenceBlock` 时把 `block_kind=item["kind"]` 传下去。**不许重新推断**：不许读摘要文本、不许看 `pattern:` 前缀、不许从 `role` 反推、不许猜。
- 报告里给出 14 个 episode 的 `block_kind` 分布（对 `to_dict()` 的块载荷统计）。
- 重跑抽取到**新目录** `/tmp/sb-influence-r8c/`（`--out /tmp/sb-influence-r8c/report.json`，检查点落在 `/tmp/sb-influence-r8c/checkpoints/`）。**R8b 的 `/tmp/sb-influence-r8b/` 不动**：它是 v1 记录，本波的回归门要用它。

## 4. #151 重测尺子（新文件，R7b 两件字节冻结）

新文件 `benchmark/causal_memory/r8c_typed_truncation.py`。**`r7b_structural_signature.py` 与 `r7b_discriminability.py` 一个字节都不改**（它们是被验证过的 v1 记录，产物哈希 `2c77d55f…`）；本波只新增文件。

**启动时**：打印冻结规则（字段清单＋权重表＋平局＋cap＋种子），并**断言自己的权重表与 R7b 模块的 `FIELD_WEIGHTS` 相同**（不一致就非零退出）——防漂移。

**两条回归门（硬门，任一不过即非零退出）**：

1. **打分规则没漂**：在 **R8b 的 v1 检查点**上重算 L2 的结构名次，必须与 R7b 报告 `l2.queries[*].candidates[*].structural_rank` **30/30 全等**（6 查询 × 5 候选）。
2. **词法通道看不见新字段**：14 份修订的 `_subgraph_retrieval_text` 在 **v1 载荷**与 **v2 载荷**上**逐条 SHA256 相同**。

**新读数**：

- `boundary_v2`：由尾部块的 `block_kind` 派生——`tool_call → call_cut`，`tool_result → result_cut`，其余 → `text_end`（`unknown` → `unknown`，且必须报出来）。
- **接线判据**：`boundary_v2` 必须与 R8a 记录的 `tail_shape` 在 **14/14** episode 上一致（narrow 6 个里 4 个 `cut:toolCall`＋2 个 `cut:toolResult`）。这条是「设计意图被落地」的可判定证据，**不**是效果量。
- 新签名字段：成员块的 `block_kind` 计数（`task`／`tool_call`／`tool_result`／`orchestrator`／`conclusion`，封闭词表＋整数），权重在打分前冻结；**另加一个只用于消融的字段集**：v1 字段集、v1＋新字段集，两套名次都报。
- L1：保留 R7b 的四条轴（同一夹具规则，`block_kind` 缺省 `unknown` 时走 v1 规则），**新增轴 A′**：尾部 `block_kind` = `tool_call` vs `tool_result`（散文逐字节相同）。
- L2：报 6 个查询上 `block_kind` 的分布、两套字段集的名次差、以及每个候选的新字段对比。**不许报胜负**。

## 5. #152 本波不做／不许读成什么

**不做**：`position_kind="cut"` 的语义落地（`default_failure_grounding_position` 仍返回 block 位置）；`validate_view` 的台账校验（仍留 #125）；不改 `_subgraph_retrieval_text`；不动 `l1_locomo_hitk.py`。

**不许读成**：
- 「新字段在真切片上非恒定」**不等于**「结构有价值」——真切片仍**没有裁决、没有修复链**，池子仍是 6 查询 × 5 候选；
- `boundary_v2 == tail_shape` 是**接线正确性**，因为两者同源（都来自同一个 `item["kind"]`），**不是**「结构臂更准」；
- L1 仍是夹具，一律标「基于夹具，判别力 ≠ 效果量」。

## 6. 本波交付

| 项 | 内容 |
|---|---|
| 生产 | `openviking/session/influence_view.py`：`BLOCK_KINDS`／`BLOCK_KIND_ROLES`／`InfluenceBlock.block_kind`（默认 `unknown`）／`validate()` 一致不变量／`to_dict`／`from_dict`；**别的不动** |
| 抽取 | `benchmark/causal_memory/sb_influence_extraction.py`：传 `block_kind=item["kind"]`＋报分布 |
| 尺子 | `benchmark/causal_memory/r8c_typed_truncation.py`（新）：两条回归门＋`boundary_v2` 接线判据＋新字段消融＋L1′／L2′ |
| 测试 | `tests/`：往返、一致不变量（冲突即拒）、旧载荷缺键 → `unknown` 且仍可校验、`BLOCK_KIND_ROLES` 与 `BLOCK_ROLES` 的覆盖关系；既有测试若硬编码了块载荷键集合，允许改，但必须逐条列出 |
| 报告 | 分布表、两条回归门、接线判据 14/14、消融名次、L1′／L2′ 读数、标签与「不回答」 |

## 7. 本波不回答

- 诊断侧真实效用（仍无裁决、无修复链）。
- 结构通道在非夹具数据上的**相对收益**（仍然只能报一致性，不能报胜负）。
- 跨 session／跨 workspace 泛化。
- 模型写的七段／branches 在检索里的作用（**#125** 的范围）。
- `position_kind="cut"` 的语义（本波只把**块级**种类写成类型，没有动失败锚点的位置种类）。
