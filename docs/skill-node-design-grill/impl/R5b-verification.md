# R5b 独立复核（ZCode，2026-09-29）

提交 `8f6b4efdc` `feat(session): freeze extraction payloads into adaptive influence views`，在 `feat/causal-subgraph-retrieval`，未 push。

## 交付物核对

`git show --stat 8f6b4efdc`：只改三个文件，`openviking/session/extraction_write.py`（新，206 行）、`openviking/session/trajectory_index_hook.py`（+43/−15）、`tests/test_extraction_write.py`（新，680 行）。

- **`session.py` 没被改**：`commit_async` 仍按 R5a 那样调 `maybe_index_session_trajectory(self, task_id)`，不传提供方。生产行为与 R5a 逐字一致（见下）。
- **`influence_view.py` 没被改**：冻结校验与 `content_hash` 保持 R3 的形态，这波没有为了写入侧放宽任何校验。
- **没有新依赖**：`extraction_write.py` 只 import `collections.abc`／`datetime`／`typing` 加本仓库既有模块。
- **没碰 `agent-plugins/`、没碰 `benchmark/`**。

## 我复跑

```
uv run pytest tests/test_extraction_write.py tests/test_trajectory_index_hook.py \
  tests/test_trajectory_index.py tests/test_influence_view.py tests/test_retrieval_facade.py \
  -q -o addopts=''
→ 2 failed, 88 passed in 2.02s
```

两个失败是点名的基线（`test_missing_projection_registry_warns_once_and_still_indexes`、`test_supersede_without_revalidation_callback_warns_once`），与 cursor 报的一致。

## 我的探针一：插座 → 钩子 → 落盘 → R4a 读回（`/tmp/probes/exp_r5b_seam.py`）

用**真实 AO 台账**（3 条 `AOLedger.append`）＋注入的提供方走生产钩子，再用 R4a 的 `RetrievalSubgraphAdapter` 从磁盘读回。19 条断言全通过：

- 提供方被调用一次，参数是 `(session_id, "task-1", "unspecified")`；
- `views.json` 落盘，`post_run_index` 修订恰好 1 份，`construction_mode == "adaptive"`（不是 fallback），`revision_id == "post-run:session-1:task-1"`；
- 两个子图都活下来，失败标记只有 `sg-cutover` 一个；序列化里没有 `subtask` 字样；
- **回读**：另一份修订（`retrieve_historical_subgraphs` 的查询侧）拿到 1 份命中，`view_revision_id` 正是插座写的那份，命中带 `sg-cutover` 的 `b-1`／`b-2` 两块与失败标记；
- 未知 block 引用被 `HighSeverityViolation` 拒绝，且拒绝后磁盘上仍是 2 份修订（半写未发生）。

这一条是本波最关键的独立性证据：**R5b 的写入侧与 R4a 的读取侧能接上**，而这在两边各自的测试里都没有覆盖（R4a 的测试直接用 `InfluenceViewDraft` 造修订）。

## 我的探针二：三处边界（`/tmp/probes/exp_r5b_probe2.py`）

### 1. id 卫生规则的宽窄（低危，实现侧已如实报告，我不建议现在改）

拒绝是**大小写敏感的整段子串比对**，比对对象是 `session_id`、`task_run_id`、`view_id`、`revision_id` 四个字符串：

| session_id | task_run_id | subgraph_id | 结果 |
|---|---|---|---|
| `sess-UUID-abc` | `task-9` | `sg-cutover-1` | 接受 |
| `t1` | `task-9` | `sg-cut1-probe` | **拒绝**（`cut1` 里含 `t1`）|
| `session-1` | `run1` | `sg-runner-a` | 接受（`runner` 不含 `run1`）|
| `session-1` | `task-1` | `sg-cutover-1` | 接受 |

即：短 id 会误伤合法子图 id。方向是**宁严勿松**（拒绝的是这次提取，调用方可以改名，且不会泄漏 id），且真实 session id 是 uuid 形状，所以我不建议现在改判定规则——但这是一条要记下来的实现侧选择。

### 2. 跨提交的内容寻址幂等（需要设计对话看一眼）

同一次会话、两个**不同**的 commit（`task-1`、`task-2`），提取载荷逐字相同 → 磁盘上只有 **1** 份修订，`post-run:session-1:task-1`。`task-2` 那份因为 `(session_id, purpose, content_hash)` 撞上而被当成「已见过」，没有自己的修订。

这是 R5a 服务的既有语义（本波按简报保持），但放到自适应路径上有一个具体后果：**「某次任务运行自己的当前修订」在内容与更早一次相同时并不存在**。R4a 的诊断入口按 `view_revision_id` 取查询修订，若诊断从 `task-2` 发起而它没有修订，只能退回到 `task-1` 那份。载荷逐字相同意味着块、claim、失败证据也相同，语义上等价，所以我判低危；但要设计对话确认「按内容寻址」是不是这里想要的语义，还是「每次 commit 一份修订」。

### 3. 空台账闸门（继承自 R5a，低危）

配了提供方、但会话的 AO 台账没有任何行时，钩子在调提供方**之前**就返回：探针里 `provider calls == []`，`views.json` 不存在。理由是设计里提取跑在已提交的 AO 上，没有 AO 就没有材料；但这条闸门今天也在管着自适应路径，值得记一笔。

## 与 R5a 的行为一致性

无提供方时，源码不是逐字相同而是等价：`IndexJob` 被提前构造，`enqueued_at` 仍是一次 `datetime.now(timezone.utc).isoformat()`，`frozen_at` 与 `job.enqueued_at` 同值（`fallback_session` 里 `"frozen_at": job.enqueued_at`），`view_id`／`revision_id` 两个字符串与 R5a 完全一致。配了提供方时才给 `TrajectoryIndexService` 传 `builder`。

一处结构性限制（不是缺陷，是插座的边界）：`extraction_index_builder` 固定 `purpose=post_run_index`，而 `TrajectoryIndexService._build_locked` 只校验返回修订的 `session_id`／`task_run_id`，**不校验 `purpose`／`revision_id`**。今天只有 post-run 一条入队路径，所以没有实际影响；若将来有诊断侧作业走同一个插座，会有「按 post-run 语义冻结诊断视图」的隐患。

## 累计状态

R0–R5b 共 10 个提交（R5c 之后为 11 个），`R5b` 复跑与探针均通过；全分支横向回归核对见 `regression-sweep-20260929.md`（无跨模块回归）。R5c／R6 的两处待定已由用户授权代定并写入 `CONSENSUS.md` #116–#119。
