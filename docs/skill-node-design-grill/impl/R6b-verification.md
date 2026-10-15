# R6b 验证（ZCode，2026-09-30）

派发：`impl/R6b-brief.md` → `impl/R6b-cursor-raw.log`。两个提交：

| 提交 | 内容 |
|---|---|
| `2619df677` | `feat(session): index an adaptive view after phase 2 extraction` |
| `5aebd83cb` | `feat(session): add server-side diagnosis calls after phase 2` |

**未 push**（`git status -sb` 无上游；`git log origin/feat/causal-subgraph-retrieval..HEAD` 不可解析）。无 rebase／amend；`benchmark/`、`openviking/server/`、`pyproject.toml`、`uv.lock` 在 `a3977bbe3..HEAD` 上**逐字未动**。

## 这是什么（一句话）

Phase 2 提取成功之后，**只有注入提供方时**才再调一次轨迹索引钩子；adaptive 修订用 `…:adaptive` 与 Phase 1 的 fallback 分开身份（#124）。诊断侧的读（失败子图 brief、历史子图检索）与写（fork）成了服务端调用点，**没有**进 MCP 工具面（#122）。模型输出契约不在本波（#125）。

## 我独立跑出来的结论

**自写探针** `/tmp/probes/exp_r6b_seam.py`（数据 `/tmp/r6b-data`，41 项断言，全部 PASS，退出码 0）。它不引用波次自己的 fixture，走的链是：真实台账 → Phase 1 钩子（无提供方）→ `Session._run_post_extraction_causal_seam`（无／有／抛错提供方）→ 磁盘 `views.json`／`trajectory-index.json` → 真实门面 `build_retrieval_facade` → `diagnosis_wiring` 三个函数。

关键实测：

- **无提供方＝零副作用**：修订仍只有 fallback 一条；`trajectory-index.json` 的 `build_timestamps` 条数不变（**没有第二次构建**，不烧 #82 预算）；sink 一次都没被调。
- **有提供方**：两条修订共存，id 为 `post-run:session-1:task-1` 与 `post-run:session-1:task-1:adaptive`，`latest()` 是 adaptive，两者都能在真实门面上被 `_revision()` **唯一**取到（这正是 #124 的硬理由：同 id 会抛 `not unique`）；adaptive 内容哈希与 fallback 不同；构建计数 1 → 2。
- **提供方抛错**：不新增修订，adaptive（或只有 fallback 时）保持 latest，Phase 2 照写 `.done`（异常被钩子自己的 `except` 吞成 warning，见日志 `trajectory index hook failed`）。
- **同内容重放**：不产生第三条修订（内容寻址幂等成立）。
- **brief 形态**：一个失败子图一条，`grounding_position == ("block", "block:b-1")`（覆盖失败证据 AO 的那个 block），带 `fork_idempotency_key`。
- **诊断读**：跨 task run 命中（用 task-1 的失败子图查到 task-2 的历史子图）；换不相交 principal **抛错**（`querying session 'session-1' is not visible to the principal`），不是空结果。
- **fork 写入**：落盘在 owner 根 `users/default/causal-experiences/forks/...`，`workspace_id == "user:default"`，`influence_grounding.view_revision_id` 指向**本波写的那条 adaptive 修订**、position 是覆盖失败 AO 的 block；传 `workspace_labels=("user:stranger",)` 时抛错且**不写盘**（文件集合不变）。
- **同 id 重放残留**（我预判、实测复现）：同一 `revision_id` 两次入库（内容不同）后 `_revision()` 抛 `not unique`。既有库语义，非本波引入；已记 `pending-design-decisions.md` 第 16 条。

**测试（我自己重跑）**

- 聚焦：`tests/session/test_phase2_causal_seam.py`、`tests/session/test_diagnosis_wiring.py`、`tests/test_extraction_write.py`、`tests/test_trajectory_index_hook.py`、`tests/test_session_acl.py`、`tests/test_retrieval_facade.py`、`tests/unit/test_mcp_tool_annotations.py`、`tests/server/test_mcp_causal_read.py` → **81 passed**。
- 宽扫：`uv run pytest tests/*.py -q -o addopts=''` → **773 passed / 7 failed / 16 errors**，与基线（`regression-sweep-20260929.md`）**数量与失败名单逐一相同**；连跑三遍稳定。**一次**跑出 772/8，未捕获到第 8 个名字，随后三遍均 773/7——按既有记录里那条顺序相关怪癖（`caplog` 收不到 stdout 告警）理解，但**没有实证到具体是哪一条，如实记**。
- 钩子文件被改过，所以专门核对了 `tests/test_trajectory_index.py` 的两条已知基线：base（`/tmp/ov-base`）与 HEAD 都是 `2 failed, 12 passed`，失败原因一致。
- 工具面未变：`mcp_endpoint.py` 逐字未动（`git diff` 空），注册的 `@mcp.tool` 仍是 18（grep 命中 21 行，其中 3 行是文档串），计数日志 `mcp_endpoint.py:2124` 仍是 18；`diagnosis_wiring` 不被 MCP 侧 import。

## 两处要记的观察（不是缺陷，但要知道）

1. **sink 没有水位，重放会再触发一次**：同内容重放不新增修订，但 briefs 从当前 latest 修订现算，所以 sink 会为同一批失败子图**再被调用一次**（我实测 1 → 2 次）。这与 #107 的 fork 幂等键是一致的（重复触发产生的 fork 写入是同一个），代价是重复触发会重复花诊断的钱；今天生产没有 sink（默认 None），没有现成花费。若将来要求「每个修订只触发一次」，需要水位（会话目录里记已交接的 `fork_idempotency_key`）。
2. **`view_revision_id` 缺省＝latest，多 run 会话里可能指错**：`write_diagnosis_fork`／`retrieve_historical_subgraphs_for_failure` 都允许不传，缺省取该 session 的最新 post-run 修订。我的探针两次踩到（task-2 候选注册后 latest 变了，拿 task-1 的子图去查／去写直接抛错）。brief 本身带 `view_revision_id`，**调用方应传**；缺省是单 run 便利。库的报错是清楚的（`subgraph 'sg-cutover' is not on view revision '...'`），不会写错地方。

## 一处历史瑕疵（HEAD 正确）

`2619df677` 的中间态把 `@tracer("session.commit.phase2", ...)` 挂到了**新接缝方法**上（那一刻 `_run_memory_extraction` 没有 tracer）；`5aebd83cb` 已把装饰器挪回 `_run_memory_extraction`，并且新接缝方法不再被装饰。HEAD 语义正确。因为简报要求不 rebase／不改写历史，这个只影响「单独 checkout `2619df677`」的中间提交，保留。我核对过当前文件（`session.py:1938` 接缝方法、`:1967` 装饰器、`:1968` `_run_memory_extraction`）。

## 代码落点（我核对过的）

- 接缝：`session.py:1938-1966`（方法）、`:2318`（调用点，提取分支内、`memory.extracted` 之后、`else` 之前；提取失败会在 `:2253` 抛，接缝不跑——与 #119 的降级语义一致）。
- 提供方／sink 注入：`session.py:436-438`（仅关键字、默认 None）、`session_service.py:105-119`（两个 setter，不读配置）、`:240-241`（`session()` 透传）。
- 身份：`extraction_write.py:199` 改成 `…:adaptive`（docstring `:180-182` 同步）；Phase 1 的 `trajectory_index_hook.py:260` 与两条的 `job_id`（`:247`）不变。
- 日志：`trajectory_index_hook.py:305-322`，只在有提供方时记；跳过是 warning（带 reason），建成是 info。
- 诊断侧：`diagnosis_wiring.py`（新，192 行）四个入口 ＋ `FailureSubgraphBrief`；不 import 模型、不写 MCP。
- 测试：`tests/session/test_phase2_causal_seam.py`（走真实 `commit_async` → `resume_queued_commit` → `_run_memory_extraction`）、`tests/session/test_diagnosis_wiring.py`、`tests/test_extraction_write.py` 两处期望改 `:adaptive`、`tests/unit/test_mcp_tool_annotations.py` 加 `len(tools) == 18`。

## 波次自身的两个自查（简报要求）

- (a) 默认策略 `max_builds_per_window=32`／`window_seconds=60.0`（`openviking_cli/utils/config/memory_config.py:29-40`）。有提供方时**每次 commit 用两次构建**（Phase 1 一次、Phase 2 一次）；窗口内耗尽返回 `SkippedResult(reason="budget_exhausted")`，修订不落、任务留在队列。我核对过：这条路径现在会打 warning（`phase2 trajectory index skipped reason=…`），不再静默。
- (b) 两条路径 `job_id` 相同、`priority` 相同，`_pending` 是 `dict[session_id, IndexJob]`（`trajectory_index.py:307`），同优先级入队是**覆盖**（`:340-341`）；Phase 1 若因预算／暂停没消费掉，Phase 2 的入队把它换掉。我的探针另证了正常路径下 Phase 1 就被消费（`build_timestamps` 1 → 1 → 2）。
