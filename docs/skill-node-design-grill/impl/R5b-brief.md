# R5b brief：提取模型写入侧（把模型给的子图／失败标记落成冻结视图）

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（已有 `988148ad8`、`12f783d19`、`c63995f8e`、`145adc72b`、`63c915d5a`、`3cb319824`、`ef21efb8c`、`32218e516`、`e298e0158`）。**追加新提交；不要 rebase／amend；不要 push；不引新依赖；不动 `benchmark/`。**

设计依据：决策 #101（检索子图由提取时的模型划定并写入冻结 view）、#108（失败标记由提取模型写入）、#110／#111／#112（子图只由 commit 后的提取产生；不进行中提取；Memory 不持有提取工具）、叙述 91–94、99。

**这一波只做写入侧的 API 与接线插座，不调用任何模型。** 谁去调提取模型、在哪调，目前没有定论（本仓库与 coforge 都没有落脚点），不在这一波范围内——你只需要把插座做出来。

## 背景

R5a 已经把索引服务挂到 commit，但今天生产路径**只会**用真实台账建**确定性 fallback 视图**（`build_minimal_fallback_view`，`construction_mode=fallback`），子图恒为空。设计要的是提取模型给出 blocks／claims／coverage／子图与失败标记，落成 `construction_mode=adaptive` 的冻结视图。

现有可复用的部件（都已验证过）：

- `InfluenceViewDraft(...)` + `add_retrieval_subgraph(...)` + `freeze(enforce_checks=True)`（`influence_view.py`）：结构校验、五条子图 violation、`content_hash` 已含 `retrieval_subgraphs`。
- `RetrievalSubgraph`（`:703`）：`subgraph_id`／`block_ids`／`claim_ids`／`failure_marked`／`failure_evidence_refs`；`is_failure` 只读显式标记。
- `TrajectoryIndexService` 的 `Builder = Callable[[session_id, task_run_id, outcome_status], InfluenceViewRevision]`（`trajectory_index.py:50`），`_build_locked`（`:510`）会校验返回的 revision 与 job 的 session／task run 一致。
- R5a 的落盘约定：session 目录下 `views.json`、`trajectory-index.json`；`trajectory_index_hook.py` 里已有 `fallback_session` 读真实台账的写法。

## 要做的

1. **写入侧函数**（放 `trajectory_index_hook.py` 或同目录新模块，你选一致的位置）：给定
   - `session_id`、`task_run_id`、`view_id`、`revision_id`、`frozen_at` 这类视图身份字段，
   - 提取模型的载荷：`blocks`、`claims`、`coverage`、`retrieval_subgraphs`（含失败标记与证据），
   构造草案 → 校验 → `freeze(enforce_checks=True)`，返回**一份** `InfluenceViewRevision`。
   - **不许**用 `build_minimal_fallback_view` 走这条路；这条路的 `construction_mode` 是 `adaptive`。
   - 校验不过就让 `HighSeverityViolation` 抛出去，**不许**吞掉、不许半写。
   - 另提供一个显式的退化入口（叫什么都行），供调用方在校验失败时**自己决定**改用确定性 fallback 视图，并把 `construction_mode=fallback` 记下来。设计原文（`influence_view.py` 的 docstring）就是「调用方应改用 `build_minimal_fallback_view`」。
2. **Builder 插座**：实现一个 `Builder` 形状的可调用，让 `TrajectoryIndexService` 在**配了提取提供方**时用提取载荷建视图；**没配时行为与 R5a 完全一致**（用真实台账的确定性 fallback）。提供方以注入方式给（参数默认 `None`），**不要**在配置里塞模型名或去实例化任何模型客户端。
3. **子图 id 的基本卫生**：载荷里的 `subgraph_id` 若内嵌 `session_id`、`view_id` 或 `task_run_id`，拒绝并报错（子图 id 会随诊断命中交给模型，取向与 R2b／#98 一致）；**不许**出现 `subtask` 字样或 `subtask_id` 字段。若你发现这条与设计冲突，报告，不要自行放宽。
4. **不许**：调用任何模型；新增「任务运行中」的提取或索引入口（#110／#111／#112）；把任何东西挂到 Memory Agent 工具面；写 fork 或发起诊断。
5. 与 R5a 的幂等语义保持一致：同一 `(session_id, purpose, content_hash)` 不产生第二份视图。

## 测试

新建 `tests/test_extraction_write.py`（或你认为合适的位置），至少覆盖：

- 标准提取载荷（多 block、多 claim、两个子图其中一个带失败标记）→ 冻结视图带子图与标记，`construction_mode` 是 `adaptive`，`to_dict`／`from_dict` 往返相等。
- 结构非法（未知 block 引用、claim 两端出子图、block 超 12、标记与证据不匹配）→ 抛 `HighSeverityViolation`，**且没有落盘**。
- 退化入口：校验失败后由调用方显式改用 fallback → `construction_mode=fallback`、子图为空。
- `subgraph_id` 内嵌 session／view／task-run id → 拒绝。
- 序列化里没有 `subtask` 字样。
- 插座：配了提供方时走提取载荷；**没配时走真实台账的确定性视图**（与 R5a 行为一致）；两条路径都经 `process_next` 落到 `views.json`。
- 配了提供方但提供方抛错时，不许影响 commit（沿用 R5a 的吞异常边界，或按你的接线点如实报告）。

## 交付要求

- 只改 OpenViking；不顺手重构；不跨波做 R6 的事。
- 跑：`uv run pytest tests/test_extraction_write.py tests/test_trajectory_index_hook.py tests/test_trajectory_index.py tests/test_influence_view.py tests/test_retrieval_facade.py -q -o addopts=''`。已知基线失败（不改、如实报告）：`test_trajectory_index.py::test_missing_projection_registry_warns_once_and_still_indexes`、`test_trajectory_index.py::test_supersede_without_revalidation_callback_warns_once`、`test_influence_projection.py::test_acl_change_without_revalidation_callback_warns_once`；`tests/session/test_session_commit.py` 在本环境有 20 处 fixture setup 的 `FileNotFoundError: /local/_system/runtime_config/cluster.json`（机器路径，基线），如实报告即可。
- 提交到 `feat/causal-subgraph-retrieval`，`feat(session): ...` 风格，不要 push。
- 回复报：新 commit 短哈希；写入侧函数与插座签名；`construction_mode` 怎么定；退化入口怎么被调用；提供方注入点在哪、默认行为是否与 R5a 逐字一致；测试条数与结果；以及任何你只能自己选一处的地方。
