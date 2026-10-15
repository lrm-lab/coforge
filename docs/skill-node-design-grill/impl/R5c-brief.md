# R5c brief：生产侧的会话 ACL 标签来源 ＋ 投影注册表接线 ＋ fork 写入侧的门

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（已有 `988148ad8`、`12f783d19`、`c63995f8e`、`145adc72b`、`63c915d5a`、`3cb319824`、`ef21efb8c`、`32218e516`、`e298e0158`、`8f6b4efdc`）。**追加新提交；不要 rebase／amend；不要 push；不引新依赖；不动 `benchmark/`。**

设计依据（**已定案，按此实现，不要自己改设计**）：`skill-node-design-grill/CONSENSUS.md` 决策总账 **#82**（索引服务里 supersede 旧投影退出索引）、**#85／#86**（投影通道 ACL 继承与再投影、ACL 变更触发撤下＋`needs_revalidation`）、**#116–#118**（2026-09-29 实现期代定，全文见 `skill-node-design-grill/impl/decisions-20260929.md`，勘查见 `impl/R5c-acl-source-recon.md`）。

三条已定的口径，照抄：

- **#116**：对象的可见性标签＝该会话 owner 的单一标签 `user:{user_id}`；owner 解析顺序 `session.ctx.user.user_id` → `session._meta.created_by_user_id` → 会话 URI（`viking://user/<user_id>/sessions/<id>`）的 user 段。读侧沿用既有 `openviking/storage/acl.py:192` 的 `acl_principals(ctx)`，两边同一标签空间。不含 `group:` 标签。解析不出 owner → 不可见。
- **#117**：不新建检索侧开关，也不受资源侧 `AccountAclSettings.enabled` 控制。
- **#118**：`workspace_id` 在生产即 `user:{user_id}`；fork 写入侧要求 `workspace_id` 属于调用方给出的 `workspace_labels`，不属于则拒绝。

## 背景：今天差的是什么

`TrajectoryIndexService` 已经有 `projection_registry` 与 `revalidation_callback` 两个注入位（`trajectory_index.py:292-293`），`_sync_projections_locked`（`:468`）会在每次构建后 `registry.register(revision)` ＋ `registry.withdraw_superseded(session_id, purpose, revision_id)`；注册表侧 `register`（`influence_projection.py:397`）、`withdraw_superseded`（`:530`）、`handle_acl_change`（`:506`）、`_labels_for`（`:620`）全都写好了。**缺的只是生产侧的构造点与标签回调**：R5a 挂的钩子没传这两个参数，所以生产上 `_sync_projections_locked` 只打一条「projection_registry is not configured」的警告就返回——决策 #82 的「旧投影退出索引」在生产上不发生。

`SessionAcl = Callable[[str], Sequence[str]]`（`influence_projection.py:46`，只吃 session id）。

## 要做的

### 1. 标签解析与回调（新模块 `openviking/session/session_acl.py`）

```python
def session_owner_label(session: Any) -> str           # 解析顺序见 #116，解析不出抛 ValueError
def session_acl_callback(session: Any) -> SessionAcl   # 闭包：只认自己这个 session_id，别的 id 抛错（fail closed）
```

- 解析顺序必须是 `ctx.user.user_id` → `_meta.created_by_user_id` → `_session_uri` 的 user 段；三者都拿不到才抛。取到的值做非空校验。
- 回调返回 `(f"user:{user_id}",)`。**对其他 session id 抛错**，不要返回空序列（空序列会让「用错注册表」这种事静默通过）。
- 不要 import 服务端（`openviking/server/`）代码进 session 包；这个模块只需要字符串。

### 2. 钩子接线（`openviking/session/trajectory_index_hook.py`）

- session 目录下的投影文件沿用既有命名风格，加一个模块常量（如 `PROJECTIONS_FILENAME = "projections.json"`）。
- 每次 commit 构造 `ProjectionRegistry(session_dir / PROJECTIONS_FILENAME, session_acl=session_acl_callback(session))`，并把 `projection_registry=` 与 `revalidation_callback=` 传给 `TrajectoryIndexService`。
- **可索引性 ≠ 可见性（重要）**：标签解析失败**不得**让整段钩子失败。解析失败时记一条 warning，然后**只**跳过注册表（`projection_registry` 传 `None`），视图与索引照常落盘。理由：fail-closed 管的是「谁能看见」，不是「要不要冻结视图」——索引本身不是安全操作。
- `revalidation_callback` 生产侧今天**没有消费者**：接一个会打 warning、带上被通知 revision id 的函数即可；**不要**新造持久文件、不要改 `SERVICE_VERSION`。这一条要在报告里如实说明（见交付要求）。

### 3. fork 写入侧的门（决策 #118，`openviking/session/subgraph_forks.py`）

- `write_failure_subgraph_fork` 增加一个必填数据参数（如 `workspace_labels: Sequence[str]`），当 `workspace_id` 不落在其中时抛错、不写盘。**fail closed**：标签为空或缺失也拒绝。
- 用数据注入，**不要**给这个写模块注入 ACL 回调（理由见 `decisions-20260929.md` #118）。
- 既有调用点只有测试与 `benchmark/`（不动 benchmark）；测试按新签名改。

### 4. 不要做

- **不要**把 `InfluenceProjectionAdapter` / `HybridRetrievalFacade` 接到任何生产读取路径——读侧接线是 R6。
- **不要**给 #85／#86 造新的触发源（ACL 变更事件在生产上没有来源，这是已知残留）；`handle_acl_change` 保持可被显式调用即可。
- 不要改 `session.py` 的 Phase 1／Phase 2 结构；不要碰提取模型（#119 是 R6 的事）。
- 不要在投影卡片里塞新的 id 或七段以外的东西。

## 测试

新增 `tests/test_session_acl.py` 或你认为合适的位置，至少覆盖：

- owner 解析三条来源各一条（ctx 优先于 meta、meta 优先于 URI、只有 URI 时也能解析）。
- 三者都没有 → 抛错；`session_acl_callback` 对**别的** session id 抛错。
- 标签形态是 `user:{user_id}`，且与 `acl_principals(ctx)` 的读侧集合相交（用 `RequestContext` 造一个 reader，断言交集非空）。
- 钩子：causal 模式下走一次 commit，session 目录下**真的出现卡片**且 `acl_labels == ("user:<uid>",)`。
- 钩子：两次内容不同的 commit 之后，旧修订的卡片**离开了索引**（`registry.search(principal_labels=...)` 只剩新修订的卡片），审计行留在 `removed_records()`。
- 钩子：标签解析失败时**视图仍然落盘**，且不注册卡片（不抛到 commit）。
- fork 写入侧：`workspace_id` 不在 `workspace_labels` 里 → 抛错且**没有落盘**；在里面 → 正常写入。
- 序列化里仍然没有 `subtask` 字样。

## 交付要求

- 只改 OpenViking；不顺手重构；不跨波做 R6 的事。
- 跑：`uv run pytest tests/test_session_acl.py tests/test_subgraph_forks.py tests/test_trajectory_index_hook.py tests/test_influence_projection.py tests/test_trajectory_index.py tests/test_influence_view.py tests/test_retrieval_facade.py tests/test_extraction_write.py -q -o addopts=''`。已知基线失败（不改、如实报告）：`test_trajectory_index.py::test_missing_projection_registry_warns_once_and_still_indexes`、`test_trajectory_index.py::test_supersede_without_revalidation_callback_warns_once`、`test_influence_projection.py::test_acl_change_without_revalidation_callback_warns_once`（这三条钉的是「没注入时的警告」行为，注入之后仍应保持原样通过）。
- 提交到 `feat/causal-subgraph-retrieval`，`feat(session): ...` 风格，不要 push。
- 回复报：新 commit 短哈希；两个新函数签名与解析顺序；`projects.json` 的实际文件名；注册表与回调的接线点；标签解析失败时的降级行为；`revalidation_callback` 接了什么、为什么不是持久的；fork 新签名与门的判定；测试条数与结果；以及任何你只能自己选一处的地方。
