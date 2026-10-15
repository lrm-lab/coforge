# R5a brief：把轨迹索引服务挂到 session commit（真实台账进视图 ＋ 入队/驱动）

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（已有 `988148ad8`、`12f783d19`、`c63995f8e`、`145adc72b`、`63c915d5a`、`3cb319824`、`ef21efb8c`、`32218e516`）。**追加新提交；不要 rebase／amend；不要 push；不引新依赖；不动 `benchmark/`。**

设计依据：决策 #82「独立异步索引服务：预算/优先级/降级/暂停，supersede 旧投影退出索引」、#83「视图按 session/task run supersede 演化；历史 revision 可引用不检索」、#110／#111／#112（子图只由 commit 后的提取产生；Memory 不持有提取工具；诊断仍在 commit 后触发）、#81（post_run 视图有界覆盖＋coverage_manifest）。

这一波只做**接线与真实数据**：让 commit 之后真的冻结一份**来自真实 AO 台账**的 post_run 视图并进索引服务。**不写 fork、不做诊断、不做提取模型的调用**（那是 R5b／R6）。

## 现有接缝（勘查结论，照它做）

- commit 分两段：`Session.commit_async`（`openviking/session/session.py:1241`，Phase 1）→ QueueFS `SESSION_COMMIT` → `SessionCommitProcessor` → `Session.resume_queued_commit`（`:1686`，Phase 2）。
- **唯一的同形状先例**是 `openviking/session/ao_ledger_recorder.py` 里的两个模块级钩子：`maybe_record_session_tool_exchanges(session, messages)`（`session.py:870` 调）与 `maybe_write_session_archive_attribution(session, archive_uri)`（`session.py:1554` 调，Phase 1 里归档落盘之后、入队之前）。形状是：`is_causal_mode_enabled(...)` 一次布尔检查就返回、`try/except` 吞异常只记 `logger.warning`。
- 索引服务 `TrajectoryIndexService`（`trajectory_index.py:281`）构造参数：`(path, supersede_index, *, builder=None, fallback_session=None, clock=None, projection_registry=None, revalidation_callback=None)`。`_build_locked`（`:510`）在**没有** `builder`／`fallback_session` 时走 `_synthetic_fallback_session`（`:254`）——那是**单条合成 AO** 的退化视图，与真实轨迹无关。
- 真实台账读接口：`list_ao_ledger(session_dir, session_id, *, cursor=None, limit=50, snapshot_watermark=None, include_live=False)`（`ao_ledger_reader.py:287`），翻页写法照 `SegmentAtomAdapter._items`（`retrieval_facade.py:1401-1420`）。台账文件是 session 目录下的 `ao-ledger.jsonl`（`ao_ledger.py:27`）。
- `IndexJob`（`:104`）必填 `job_id`、`session_id`、`task_run_id`、`priority ∈ {0,1,2}`、`outcome_status`、`enqueued_at`。`WorkspacePolicy(max_builds_per_window, window_seconds, paused)`（`:155`）。`process_next`（`:362`）在 `paused`／预算耗尽时返回 `SkippedResult` 且 **job 留在队列**、不构建、不注册。
- 模式开关：`is_causal_mode_enabled(...)`（配置在 `openviking_cli/utils/config/memory_config.py:110`，默认 `legacy`）。`TrajectoryIndexService` 与 `ProjectionRegistry` **今天没有任何生产构造点**。

## 要做的

1. **新模块**（例如 `openviking/session/trajectory_index_hook.py`）：照 `ao_ledger_recorder.py` 的形状提供模块级钩子，例如 `maybe_index_session_trajectory(session, ...)`。causal 门、`try/except` 吞异常只记 warning、legacy 一次布尔检查就返回。**在 `session.py` 的 Phase 1 里紧跟 `maybe_write_session_archive_attribution` 之后调用**（`:1554` 附近），改动保持最小：一个 import ＋ 一次调用。
2. **真实台账进视图**：给服务注入一个 `fallback_session(job) -> Mapping`，用 `list_ao_ledger(..., include_live=True)` 翻页取真实 AO 记录，拼出 `build_minimal_fallback_view` 需要的映射（`session_id`、`task_run_id`、`purpose=post_run_index`、`view_id`、`revision_id`、`frozen_at`、`snapshot_watermark`、`ao_records`）。**生产默认不许走 `_synthetic_fallback_session`**：那是合成单条 AO，会让视图与真实轨迹无关。
3. **落盘路径约定**：为 `ViewSupersedeIndex` 与 `TrajectoryIndexService` 定一个 session 目录下的约定（如 `<session_dir>/views.json`、`<session_dir>/trajectory-index.json`），在报告里写明。台账里已有 AO 时，构建出的视图必须与台账分段对应（不是一条）。
4. **入队 ＋ 驱动**：入队一个 `IndexJob`；驱动用 `process_next(policy)`，policy 从配置读（在 `memory_config.py` 加字段，或由调用方注入——你选一个一致的做法）。**默认值与「谁决定 paused／预算」在设计里没有规定**：选一个明确默认、写进报告、标明是实现侧选择。
5. **映射（设计没写，必须报告，不许自行发明判定）**：
   - `task_run_id` ← 这次 commit 的 `task_id`（今天会话里没有「task run」这个实体，只有 `task_id`；照你选的映射写清）。
   - `priority`／`outcome_status`：**commit 时无法从会话状态推出任务成败**（会话里只有 `record_auto_commit_success`，那是自动提交策略的印子，不是任务成败）。只允许取一个**明确的中性默认**并写进报告。**不许**自己发明「运行失败」的判定——失败是由提取（结论块／失败标记，决策 #103／#108）确立的，那是 R5b 的输入。
6. **不许**：新增任何「任务运行中」的提取或索引入口（#110／#111／#112）；不许把索引服务挂到 Memory Agent 工具面；不许在这波写 fork 或发起诊断。
7. 幂等／可恢复：同一 run 重复 commit 不许产生第二份视图或第二条索引记录（沿用服务自带的 `(session_id, purpose, content_hash)` 幂等）；`deferred`／`flush_deferred` 的语义不许改。构建或索引失败**不许**影响 commit 本身的成功（照钩子形状吞异常）。

## 测试

新建 `tests/test_trajectory_index_hook.py`（或你认为合适的位置），至少覆盖：

- **seam**：causal 下 commit 会入队并构建一份视图；legacy 下**一个文件都不写**（形状照 `tests/test_ao_ledger_recorder.py:328` 的 `test_session_commit_seam_causal_vs_legacy`）。
- **真实台账**：给定 session 目录里的 `ao-ledger.jsonl`（多条 AO），构建出的视图按台账分段，**不是**单条合成 AO。
- **paused**：不构建、不注册，job 留在队列。
- **预算**：耗尽时 `SKIP_BUDGET_EXHAUSTED`，job 留在队列。
- **幂等**：同一 run 重复 commit 不产生第二份视图。
- **失败隔离**：构建抛异常时 commit 仍成功（异常被吞、有 warning）。

## 交付要求

- 只改 OpenViking；`session.py` 只做最小改动（一个 import ＋ 一次调用），不顺手重构这个巨型文件。
- 跑：`uv run pytest tests/test_trajectory_index_hook.py tests/test_trajectory_index.py tests/test_ao_ledger_recorder.py tests/session/test_session_commit.py tests/test_skill_trajectory_mode.py tests/test_influence_view.py tests/test_retrieval_facade.py -q -o addopts=''`。已知基线失败（不要改、如实报告）：`test_influence_projection.py::test_acl_change_without_revalidation_callback_warns_once`、`test_trajectory_index.py::test_missing_projection_registry_warns_once_and_still_indexes`、`test_trajectory_index.py::test_supersede_without_revalidation_callback_warns_once`；另外 `tests/` 里有一批需要外部服务或本机路径的测试在本环境本来就报错（16 处 `FileNotFoundError` 一类），若你的命令里出现这类错误，先确认是不是基线，再如实报告。
- 提交到 `feat/causal-subgraph-retrieval`，`feat(session): ...` 风格，不要 push。
- 回复报：新 commit 短哈希；新模块与钩子签名；落盘路径约定；`fallback_session` 怎么读台账；`IndexJob` 五个字段各自怎么来（尤其 `task_run_id`、`priority`、`outcome_status`）；policy 从哪读、默认值是多少；测试条数与结果；以及任何两处设计对不上、你只能自己选一处的地方，写出来让我去设计对话确认。
