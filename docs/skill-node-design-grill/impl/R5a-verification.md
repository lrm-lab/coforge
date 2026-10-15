# R5a 验证记录（ZCode 独立复跑）

提交：`e298e0158`（`feat(session): freeze a post-run view from the AO ledger on commit`），4 文件 +804。未 push。

## 我复跑的结果

`uv run pytest tests/test_trajectory_index_hook.py tests/test_trajectory_index.py tests/test_ao_ledger_recorder.py tests/session/test_session_commit.py tests/test_skill_trajectory_mode.py tests/test_influence_view.py tests/test_retrieval_facade.py -q -o addopts=''`
→ **90 passed / 2 failed / 20 errors**，与自述一致。

- 2 个失败是基线（`test_missing_projection_registry_warns_once_and_still_indexes`、`test_supersede_without_revalidation_callback_warns_once`）。
- 20 个 error 全在 `tests/session/test_session_commit.py` 的 **fixture setup**，根因是 `tests/utils/mock_agfs.py:129` 抛 `FileNotFoundError: /local/_system/runtime_config/cluster.json`——机器绝对路径，发生在任何 commit 逻辑之前；而且这些测试默认跑在 legacy 模式，新钩子在那里只是**一次布尔检查就返回**，不可能影响它们。判定为环境基线。

## 逐条核对（读代码）

- `session.py` 的 diff 就是**两行**：一个 import（`:28`）＋ Phase 1 里 `maybe_write_session_archive_attribution(self, archive_uri)` 之后的一行调用（`:1556`）。没有别的改动。
- 钩子 `trajectory_index_hook.py`：`maybe_index_session_trajectory(session, task_id, *, config=None)`；`is_causal_mode_enabled` 一次检查就返回；整段 `try/except` 吞异常只记 `logger.warning`。
- **台账为空时直接返回，不写任何文件**（`if not ao_records: return` 在任何落盘之前）——这条很关键：它避免了「每次 commit 都写一份空视图」。
- `fallback_session` 闭包用 `list_ao_ledger(..., limit=MAX_PAGE_LIMIT, include_live=True)` 翻页读**真实台账**；服务始终带 `fallback_session`，所以生产路径**不会**走 `_synthetic_fallback_session`（那条会合成单条 AO）。
- 落盘路径：session 目录下 `views.json`（`ViewSupersedeIndex`）与 `trajectory-index.json`（服务队列快照）。session 目录用 `viking_fs._uri_to_path(...)` 取本地路径——**与 `ao_ledger_recorder.py:300` 的既有写法一致**，不是新发明的取路径方式。
- 测试 9 条：真实台账分段（断言不是单条合成 AO）、翻页超过一页、paused、预算耗尽、同一 run 重复不产生第二份视图、后续 commit 无新 AO 不加视图、构建失败不影响 commit、默认 policy、以及一条真的驱动 `Session.commit_async` 的 **seam 级**测试（causal 与 legacy 对比）。

## 三件需要记下来的事

**1. #82 只落实了一半。** 决策 #82 的原文是「独立异步索引服务：预算/优先级/降级/暂停，**supersede 旧投影退出索引**」。R5a 没有注入 `projection_registry` 或 `revalidation_callback`（作者主动报了这一条），所以 `_sync_projections_locked` / `withdraw_superseded` / `needs_revalidation` 在生产上都还不会发生。要补齐需要一个生产侧的 `ProjectionRegistry`，而它的构造需要 `session_acl`（会话标签来源）——那个来源今天不存在。**这不是可以顺手补的**，要定「生产环境的会话 ACL 标签从哪来」。已列入待确认清单。

**2. `IndexJob.priority` 没有中性档。** 作者把未知结果放在 `priority=2`（枚举里最低紧急度）＋ `outcome_status="unspecified"`，并明确写「这不是成功判定」。合理，但意味着今天**任何 commit 都不会触发高优先级索引**，失败优先级要等提取（R5b）给。

**3. 视图的 `snapshot_watermark` 被换成了派生摘要。** `list_ao_ledger` 给的 token 含 `issued_at`，写进视图会让 `content_hash` 每次 commit 都变、服务自带的 `(session_id, purpose, content_hash)` 幂等失效。所以分页仍用读者的 token，写进视图的是 `ao-ledger:{sha256(ao_id, sequence, content_hash)}`。这是作者为保住幂等做的选择，我认为判断正确，但它意味着视图上的 watermark 不是台账读者的原始水位——已列入待确认。

另有两条实现侧选择（台账行没有 `segment_id`／`participant_id`／`content_hash` 时的兜底：一行一块、参与者 `"unspecified"`、按行内稳定字段算哈希；以及预算按**单 session** 的 `build_timestamps` 计而不是整个工作区），都写进了待确认清单。
