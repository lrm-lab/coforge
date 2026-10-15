# R6b brief：Phase 2 接缝（带提供方的钩子调用）＋ 诊断侧服务端调用点

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（已有 `988148ad8`、`12f783d19`、`c63995f8e`、`145adc72b`、`63c915d5a`、`3cb319824`、`ef21efb8c`、`32218e516`、`e298e0158`、`8f6b4efdc`、`17d6310ba`、`f9ec022f9`、`a3977bbe3`）。**追加新提交；不要 rebase／amend；不要 push；不引新依赖；不动 `benchmark/`。**

设计依据（**已定案，按此实现**）：`CONSENSUS.md` 决策 **#101／#105／#106／#107**（每个失败子图各写一份普通 fork；诊断子图命中的形态）、**#119**（提取模型由 Phase 2 调用、Phase 1 钩子不变）、**#122**（诊断侧不进工具面）、**#124**（Phase 2 的 adaptive 修订身份）、**#125**（模型输出契约不在本波）。理由与代价见 `impl/decisions-20260929.md`、`impl/decisions-20260930.md`。

## 这一波只做三件事

1. **Phase 2 接缝**：`_run_memory_extraction` 的提取成功之后，增加一次**带提供方**的 `maybe_index_session_trajectory` 调用（#119）；没有提供方时**完全不动**。
2. **诊断侧服务端调用点**：读「本次 commit 的冻结视图上，哪些失败子图欠 fork」＋ 调 `retrieve_historical_subgraphs` ＋ 调 `write_failure_subgraph_fork`，三者的生产调用点。**不做成 MCP 工具**（#122）。
3. 可选注入的「诊断触发」出口（sink）：把第 2 条的失败子图清单交给一个可注入的回调；默认不注入＝什么都不做。依据是叙述 101（诊断等 commit 后的子图提取再做）。

## 明确不做（做了就是越界）

- **不改提取路径的 prompt／输出 schema**。模型输出的结构化契约今天带不出 blocks／claims：生成的 operations 模型是 `extra="ignore"`（`session_memory/schema_model_generator.py:335`）、协议骨架只列 `delete_ids` 加 memory 类型字段（`session_memory/extraction_output_protocol/json_protocol.py:80-93`）、指令正文只讲长期记忆（`session_memory/session_extract_context_provider.py:198-255`）、解析层 L3 过滤额外字段（`session_memory/utils/json_parser.py:375-382`）。**这四处都不要碰**（#125）。
- 不新增 MCP 工具，不改工具计数（保持 18），不改 `search`／`find` 的函数体，不改 `mcp_endpoint.py` 里已有的两个因果工具。
- 不接评测循环（`evaluation_loop.py`／`evaluation_orchestrator.py` 在生产上仍是死代码，本波不唤活）。
- 不做跨会话语料（`session_acl_callback` 对非本会话 fail closed；`build_retrieval_facade` 只带一个会话目录）。跨会话是设计另一条线，本波不碰。
- 不给诊断侧任何东西做成模型可调用的工具，也不给 Memory Agent 加工具。

## 1. Phase 2 接缝怎么接

**插入点**：`openviking/session/session.py` 的 `_run_memory_extraction` 尾部，`get_current_telemetry().set("memory.extracted", total_extracted)`（约 `:2284`）之后、`else:`（约 `:2285`）之前。理由（已核对）：这一点在写 `.failed.json` 的 `try` 内（约 `:2420-2431`）、在 `_write_done_file`（约 `:2354`）之前，所以队列重试会重放它；而 `resume_queued_commit` 开头 `.done` 已存在就早返回（约 `:1702-1715`），放在 `:1821` 之后的写法是一次性、不可重放的。

**调用形态**（照 Phase 1 的 `session.py:1556` 写法）：`maybe_index_session_trajectory(self, task_id, extraction_provider=<提供方>)`。`task_id` 就是 Phase 2 参数里那个 `task_id`（`resume_queued_commit` 从 `msg.task_id` 传入 `_run_memory_extraction`，与 Phase 1 铸造的 `task_id` 是同一个值，已核对）。

**提供方怎么进来**（注入通道，三处，都要默认 None）：

- `Session.__init__`（`session.py:416-467`）新增仅关键字参数，如 `extraction_provider: ExtractionProvider | None = None`，存成属性。
- `SessionService.session(...)`（`openviking/service/session_service.py:189-221`）把 `SessionService` 上的提供方透传给 `Session`。`SessionService` 上加一个 setter，形状抄同类 `set_tool_output_externalization_config`（`session_service.py:88-91`）：`set_extraction_provider(provider)`，默认 None。
- `SessionService.__init__` 里初始化为 None。**不要读配置**（不新增 config key，不改 `ov.conf` 语义）。

**没有提供方时**：**不要调用钩子**（一次都不要）。理由：Phase 1 已经落过 fallback 视图，Phase 2 再调一次没有提供方的钩子只会在预算里白烧一次构建——且 `#82` 的预算是真的会被消耗的。所以判据是 `provider is not None` 才调。

**有提供方时**（#124 的身份口径，**必须实现**）：

- `extraction_write.py:198` 的 `revision_id` 改成 `post-run:{session_id}:{task_run_id}:adaptive`（`f"post-run:{session_id}:{task_run_id}:adaptive"`），并把该模块 docstring 里写死 `post-run:{session}:{task}` 的那句一起改掉（`:181`）。`view_id` 不变。
- Phase 1 的 fallback 身份不变：`trajectory_index_hook.py:260` 仍是 `post-run:{session_id}:{task_run_id}`；`job_id`（`:243`）两条都用 `post-run:{session_id}:{task_run_id}`，不变。
- 结果：同一次 commit 两条修订共存于 `(session_id, purpose=post_run_index)` 的 history，`latest()` 返回后注册的 adaptive；`retrieval_facade._revision()`（`retrieval_facade.py:1670-1683`）要求 id 唯一，**同 id 会让它直接抛错**，这就是本条口径的硬理由（详见 `decisions-20260930.md` #124）。
- 提供方抛错／返回值不是 `ExtractionPayload` 时：**fallback 修订必须保持原样、仍是 latest**，不得被删被改；异常由 `maybe_index_session_trajectory` 自己的 `except` 兜住（它只 log warning），这一层你不用再包。要有一条测试锁住这个行为。
- 把 `service.process_next(...)` 的返回值（`IndexedResult` / `SkippedResult`）在 Phase 2 这条路径上**记一条日志**（info/warning，含 skip reason）。现在 `_index_commit` 把返回值丢掉了，而预算不足（`SKIP_BUDGET_EXHAUSTED`）或暂停（`SKIP_PAUSED`）会让 adaptive 静默不落——要看得见。Phase 1 那条路径保持原样（不改它的行为，加日志可以）。

## 2. 诊断侧服务端调用点（新模块，建议 `openviking/session/diagnosis_wiring.py`）

四个东西，都**不是** agent 工具，都只由服务端代码调用：

```python
def latest_post_run_revision(session: Any) -> InfluenceViewRevision | None
def post_extraction_diagnosis_briefs(session: Any) -> tuple[FailureSubgraphBrief, ...]
def retrieve_historical_subgraphs_for_failure(
    session: Any, ctx: Any, viking_fs: Any, *, view_revision_id: str, subgraph_id: str,
) -> tuple[DiagnosticSubgraphHit, ...]
def write_diagnosis_fork(
    session: Any, ctx: Any, viking_fs: Any, *, subgraph_id: str,
    seven_sections, branches, diagnosis_run_id: str, model_version: str,
    contemporaneous_basis, hindsight_attribution=None, used_skills=None,
    view_revision_id: str | None = None,
) -> ForkRevision
```

- `FailureSubgraphBrief`：一个失败子图一条，字段至少 `view_revision_id`、`subgraph_id`、`fork_idempotency_key`（用 `failure_subgraph_fork_idempotency_key`）、`grounding_position`（用 `default_failure_grounding_position`，返回 `("block", "block:<id>")`）。**一个失败子图一条 brief**，不合成、不分组、不造 `cause_set`（#105／#106）。
- `latest_post_run_revision` / `post_extraction_diagnosis_briefs`：**纯读**，不调模型、不写盘。用 `trajectory_index_hook.session_directory(session)` ＋ `ViewSupersedeIndex(<dir>/VIEWS_FILENAME)` 的 `latest(session_id, PURPOSE_POST_RUN_INDEX)`，再用 `subgraph_forks.failure_subgraphs_owed_forks(revision)`。视图文件不存在／没有修订时返回 `None`／空元组，**不要报错**。
- `retrieve_historical_subgraphs_for_failure`：用 R6a 的 `build_retrieval_facade(*, session=..., ctx=..., viking_fs=...)` 造门面，然后 `facade.retrieve_historical_subgraphs(view_revision_id, subgraph_id, tuple(acl_principals(ctx)))`（`acl_principals` 在 `openviking/storage/acl.py:192`）。`view_revision_id` 缺省＝当前 latest。不做 3 份以外的处理、不回填（库已经做完了）。
- `write_diagnosis_fork`：解析 fork store 根（与 `retrieval_wiring.py:50-66` 同法：`canonical_user_root(ctx)` → `viking_fs._uri_to_path(..., ctx=ctx)` → `CausalExperiencesStore(root)`），然后调 `subgraph_forks.write_failure_subgraph_fork(store, revision, subgraph_id, ...)`（签名见 `subgraph_forks.py:144-160`）。**标签口径（#118／#124 的下游）**：`workspace_id = session_acl.session_owner_label(session)`，`workspace_labels = (workspace_id,)`——只给 owner 自己这一条，fail closed；`position_kind`／`position_ref` 缺省取 `default_failure_grounding_position` 的结果。`diagnosis_run_id`／`model_version`／`seven_sections`／`branches`／`contemporaneous_basis` **由调用方给**：本仓库没有生产者（已核），**不要编造默认值**，缺了就按库原有的 `ValueError` 抛。
- 门在库里已经有了（`_require_workspace_in_labels`，`subgraph_forks.py:129`）：它的 `ValueError` 原样抛，不包、不吞。

## 3. 诊断触发出口（sink，可选注入）

- `Session.__init__` 再加一个仅关键字参数，如 `diagnosis_sink: Callable[[tuple[FailureSubgraphBrief, ...]], None] | None = None`；`SessionService` 同样给一个 setter 与透传。
- 在**同一插入点**（第 1 条那两行之后）：算出 briefs，**非空时**才调 sink（空就不调，避免每次 commit 都触发一次空回调）。没有 sink 就不算 briefs 或算了也不用——由你选，但**没有 sink 时不得有任何副作用**。
- **整个接缝（钩子调用 ＋ briefs ＋ sink）必须包一层 `try/except Exception: logger.warning(..., exc_info=True)`**：Phase 2 的 `.done` 必须照写，不能被这一层拖垮。要有一条测试锁住「sink 抛错，Phase 2 仍然完成」。

## 测试要求（必做）

新增／补充，最少覆盖：

1. **无提供方**：Phase 2 走完，`views.json` 上 `(session, post_run_index)` **只有一条**修订，id 是 `post-run:{session}:{task}`、`construction_mode=fallback`；sink 未被调用。
2. **有提供方**：两条修订，id 分别是 `post-run:...` 与 `post-run:...:adaptive`，`latest()` 是 adaptive，`_revision(adaptive_id)` 唯一且取得到，fallback 仍在 `history` 里；adaptive 的 `content_hash` 与 fallback 不同；投影卡片的 supersede 撤下发生在 adaptive 注册时（`withdraw_superseded` 的既有语义，至少断言不报错、不残留 fallback 来源的活跃卡片）。
3. **提供方抛错**：只有 fallback 一条、仍是 latest、Phase 2 完成。
4. **同内容重放**：同一 commit 路径跑两次（同提供方同载荷），不产生第三条修订（内容寻址幂等）。
5. **sink 抛错**：Phase 2 完成。sink 收到的是**一个失败子图一条** brief，条数与视图上 `is_failure` 的子图数一致，`grounding_position` 是 `("block", "block:<id>")`。
6. **诊断读**：`retrieve_historical_subgraphs_for_failure` 用 owner 标签能拿到命中；换成不相交标签**抛错**（不是空结果，库的既有语义）；不存在的 subgraph id 抛错。
7. **fork 写入门**：`workspace_id` 由 owner 标签推出、写成功；若有人把 `workspace_labels` 传成不含 `workspace_id` 的集合，**写不进去**（库的 `ValueError`）。
8. **工具面未变**：`mcp_endpoint.py` 的工具集合仍是 18 个（既有 `tests/unit/test_mcp_tool_annotations.py` 或同类断言）；`search`／`find` 的函数体逐字未改。

**测试要走的路径**：Phase 2 的接缝测试要尽量经过真实调用路径（`_run_memory_extraction`／`resume_queued_commit`），既有夹具参考 `tests/unit/session/test_session_commit_resume.py`、`tests/session/test_session_commit.py`（有 `test_phase2_splits_with_the_committed_auto_commit_policy` 等）；只测新加的私有方法不算覆盖接缝。

## 提交与报告

- 提交信息用 `feat(session): ...` ／ `fix(session): ...` 风格，一条提交讲清一件事（接缝／诊断调用点可以分开提）。
- 报告里必须写：**你改的每一处 file:line**；测试命令与数字（并说明本机既有的 `ov.conf` 缺失导致的失败基线，don't paper over）；**自行选定的地方**（签名、缺省、日志级别）；以及你对下面两条的核查结果：
  (a) Phase 2 第二次构建会计入 `#82` 的预算——默认 `TrajectoryIndexConfig` 的 `max_builds_per_window`／`window_seconds` 是多少、预算不足时这次调用返回什么、你打的是哪条日志；
  (b) `IndexJob` 的 `job_id` 两条路径相同，若 Phase 1 的构建被跳过（预算／暂停）留在盘上，Phase 2 入队是覆盖还是追加（读 `TrajectoryIndexService.enqueue` 的 `_pending` 结构，给结论与行号）。
