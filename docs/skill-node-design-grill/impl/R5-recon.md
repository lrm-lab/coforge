# R5 勘查结论（ZCode 派 Explore 只读跑，2026-09-29）

用来写 R5a brief 的现状图。**只记事实**。

## 1. commit 路径

```
POST /{session_id}/commit  → server/routers/sessions.py:660 commit_session()
  → service/session_service.py:405 SessionService.commit_async()
  → session/session.py:1241 Session.commit_async()              [Phase 1，持路径锁]
       ├─ :1554 maybe_write_session_archive_attribution(self, archive_uri)
       ├─ :1569 await get_queue_manager().enqueue(SESSION_COMMIT, msg)   ← 持久边界
       ├─ :1575 await get_task_tracker().create("session_commit", task_id=...)
       ├─ :1605 await self._save_meta()
       └─ :1606 await self._write_phase1_ready_marker(archive_uri)
QueueFS worker（storage/queuefs/queue_manager.py:235）
  → storage/queuefs/session_commit_processor.py:116 on_dequeue → :83
  → session/session.py:1686 Session.resume_queued_commit()      [Phase 2]
       ├─ :1700/1717 看 archive/.done、.failed.json
       ├─ :1806 await self._run_memory_extraction(...)
       └─ :2344 _merge_and_save_commit_meta / :2352 _write_done_file / :2401 tracker.complete
```

生产里只有 `task_id`（uuid4，`session.py:1508`）与 `archive_uri` 两个 id 概念。**`task_run_id` 在 `openviking/` 里只出现在 `influence_view.py`（12 处）与 `trajectory_index.py`（9 处），没有生产产出方。**

## 2. causal 模式的门

模式是**配置字段**，不是 session 属性：`openviking_cli/utils/config/memory_config.py:110` 的 `memory.skill_trajectory_mode`（`legacy`｜`causal`，默认 `legacy`），解析在 `:219-254`（`resolve_skill_trajectory_mode`／`is_causal_mode_enabled`，`workspace_id`／`session_id` 参数被显式 `del` 掉，留给后续切片）。

门站点（都在调用入口、吞异常）：`ao_ledger_recorder.py:472`（实时记录 AO）、`:488`（写 `ao-attribution.jsonl`）、`causal_experiences.py:1358`（fork 写盘）、`causal_clusters.py:482`、`causal_bridges.py:972`。**`session.py` 里没有任何 causal／skill_trajectory 引用。**

## 3. 谁构造视图

`InfluenceViewDraft(` 在生产代码里只有一个构造点：`influence_view.py:1710`，在 `build_minimal_fallback_view` 内部；唯一生产调用方是 `trajectory_index.py:518`（`TrajectoryIndexService._build_locked`）。其余全是测试。

`build_minimal_fallback_view(session, *, clock=None) -> InfluenceViewRevision`（`influence_view.py:1616`）：必需 `session_id`、`task_run_id`、`ao_records`（非空，每条要 `ao_id`／`sequence`／`participant_id`／`segment_id`／`session_id`／`content_hash`，同一 segment 只能一个参与者、一段连续序列）；可选 `purpose`（默认 `post_run_index`）、`view_id`、`revision_id`、`frozen_at`、`snapshot_watermark`、`summary`。`freeze(enforce_checks=True)` 违规则 `HighSeverityViolation`。

## 4. 后台机制

`openviking/session/` 里**没有** worker／队列／线程池／暂停机制（只有 `threading` 锁）。真正的 durable runner 是 `openviking/storage/queuefs/`，`SESSION_COMMIT` 队列就是 commit 已在用的那个；并发上限 `DEFAULT_MAX_CONCURRENT_SESSION_COMMIT = 8`（`queue_manager.py:28`），daemon 线程，注册在 `service/core.py:619-625`。**QueueFS 里没有 pause／defer／budget 门**（`WorkspacePolicy.paused` 在生产不可达）。

commit 路径上已有的有界手段：`AutoCommitPolicy`（`auto_commit_policy.py:52`）、`ExtractionBatchLimits`（`extraction_batch.py:32`）、`retry_async`（`_MEMORY_EXTRACTION_MAX_RETRIES = 3`）、`_PHASE2_QUEUE_WAIT_TIMEOUT_SECONDS = 1800.0`、`.done`／`.failed.json`／phase1-ready 标记、路径锁（`_SESSION_PHASE1_LOCK_TIMEOUT_SECONDS = 30.0`）。

## 5. commit 上的既有钩子

1. `maybe_write_session_archive_attribution(self, archive_uri)` — `session.py:1554`（Phase 1，causal 门，legacy 是 no-op）。
2. `maybe_record_session_tool_exchanges(self, messages)` — `session.py:870`（实时）。
3. `get_task_tracker()` 的 create/start/complete/fail。
4. telemetry／`_stats`。
5. Phase 2 的 `asyncio.gather(*extraction_tasks)`。

**没有** 回调注册表、`on_commit`／`post_commit`／事件总线。

`TrajectoryIndexService.__init__`（`trajectory_index.py:284`）：`(path, supersede_index, *, builder=None, fallback_session=None, clock=None, projection_registry=None, revalidation_callback=None)`；`Builder = Callable[[session_id, task_run_id, outcome_status], InfluenceViewRevision]`，`FallbackSession = Callable[[IndexJob], Mapping]`，`RevalidationCallback = Callable[[revision_id], None]`。**唯一构造点**是 `tests/test_trajectory_index.py:76-99`。`ProjectionRegistry` 也没有生产构造点。

## 6. `process_next` 全貌

`trajectory_index.py:362-395`：`paused` → `SkippedResult(reason=paused)`（job 留在队列、不构建、不注册）；无待办 → `ValueError("no pending index job")`；预算不允许 → `SkippedResult(reason=budget_exhausted)`；否则 `_build_locked(job)` → `ViewSupersedeIndex.register(revision)`（若 `(session_id, purpose, content_hash)` 未登记过；登记过则跳过注册但仍算一次构建）→ 若换了 revision 且注入过回调则通知 `previous.revision_id` → `_sync_projections_locked`（注入 registry 时）→ 出队、记时间戳、落盘快照、返回 `IndexedResult`。

`_build_locked`（`:510`）：无 `builder` 时用 `fallback_session(job)`，没有该回调就用 `_synthetic_fallback_session(job)`（`:254`，**单条合成 AO**：`ao-{job_id}`、`sequence=1`、`segment_id=seg-{session_id}`）。构建结果必须与 job 的 `session_id`／`task_run_id` 一致，否则 `ValueError`。

## 7. 提取模型与 CoForge

`openviking/session/` 里**有**模型调用，但**不在** causal 子树上：`compressor_v3.py:707`（VLM resolver）、`memory/extract_loop.py:130`（`VLMBase` ReAct 循环）、`session.py:2867+`（WM／归档摘要的 `vlm.get_completion_async`）。**causal／evaluation_*／trajectory_index／influence_* 这些文件本身不调用任何模型**，是纯确定性状态＋文件 IO。

诊断座位与信封都在 causal 层：`WorkerSeatPool`（`evaluation_orchestrator.py:495`）、`reserve_diagnosis`（`:547`）、`DiagnosisBrief`（`handoff_envelope.py:195`）／`DiagnosisOutcome`（`:258`）、`DiagnosisFn`（`evaluation_loop.py:60`，在 `:256` 被调用，返回值必须是 fork 提案序列）。

**CoForge 是另一个仓库**（`/home/zhoujie22/river2_0/coforge`，TS/Bun），本仓库内没有 `coforge/` 目录、`coforge` 字符串零命中。反向也成立：**CoForge 里 `openviking`／`OpenViking` 零命中**，没有 OpenViking 检索工具、没有 MCP 客户端、没有子图或索引服务的任何引用。本仓库内的 agent 面只有 `agent-plugins/`（MCP 代理＋skill）、`examples/openclaw-plugin/`、`bot/vikingbot/`，也都不引用 causal 模式。

## 8. 测试落点

commit 路径：`tests/session/test_session_commit.py`(20)、`tests/session/test_session_commit_race.py`(2)、`tests/unit/session/test_session_commit_resume.py`(7)、`tests/session/test_commit_skill_inference.py`(11)、`tests/test_session_async_commit.py`(1) 等。

「legacy 下不干活」的断言：`tests/test_ao_ledger_recorder.py:328`（seam 级，monkeypatch `is_causal_mode_enabled`，断言 legacy 下两个文件都不存在）、`:247`（两个钩子是 no-op）、`tests/test_causal_experiences.py:385`、`tests/test_causal_clusters.py:335`、`tests/test_skill_trajectory_mode.py:24,60`。`tests/test_causal_bridges.py` **没有** legacy 拒绝测试。

## 9. 「不存在」清单（与 R5 相关）

- `session.py`／`trajectory_index.py`／`influence_view.py`／`influence_projection.py`／`subgraph_forks.py`／`evaluation_loop.py`／`retrieval_facade.py` 里 causal 模式零命中。
- `TrajectoryIndexService`／`IndexJob`／`WorkspacePolicy`／`ProjectionRegistry` 的生产构造与 `enqueue`／`process_next`／`flush_deferred` 的生产调用：不存在。
- `task_run_id` 的生产产出方：不存在（没有 task run 实体）。
- commit 路径上的回调注册表／事件总线：不存在。
- QueueFS 的 pause／defer／budget 门：不存在（`WorkspacePolicy.paused` 生产不可达）。
- 本仓库内的 `coforge/`、CoForge 对 OpenViking 的引用：都不存在。
- ADR-0004／0010／0012 等文件：本仓库里不存在，只在 docstring 里被引用。
