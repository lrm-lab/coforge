# R5c 前置勘查：生产环境的会话 ACL 标签能从哪来（ZCode，2026-09-29）

目的：待设计确认第 8 条卡住 R5c／R6——`ProjectionRegistry`、`RetrievalSubgraphAdapter` 需要一个 `session_acl(session_id) -> Sequence[str]` 回调，而生产代码里**没有任何构造点**。这份勘查回答「仓库里已经存在哪些身份／范围材料可以直接当标签」，供设计对话定案。**我不改设计，只报事实与我的建议。**

## 1. 回调契约

`openviking/session/influence_projection.py:46` → `SessionAcl = Callable[[str], Sequence[str]]`，只吃 session id。三个注入点（投影注册表 `:379`、诊断子图适配器 `retrieval_facade.py:1578`、fork／历史过滤用 `workspace_id` 与 `action["acl_labels"]`）。

判定原语是集合求交：`retrieval_facade.py:828` `_labels_visible(labels, principal) = bool(principal.intersection(labels))`；投影注册表里是同一句（`influence_projection.py:444`）。

`grep` 全仓库：`ProjectionRegistry(`／`HybridRetrievalFacade(`／`ForkBranchAdapter(`／`RetrievalSubgraphAdapter(`／`CausalExperiencesStore(`／`write_failure_subgraph_fork(` 只出现在 `tests/*` 与 `benchmark/causal_memory/l1_locomo_hitk.py`（benchmark 自己硬编码 `LABELS`）。`session_acl=`／`SessionAcl`／`principal_labels` 在 `openviking/server/`、`openviking/service/`、`openviking_cli/`、`bot/`、`agent-plugins/` 里**一次都没出现**。

## 2. 关键发现：仓库里已经有一套生产 ACL 标签空间，语义与它完全一致

`openviking/storage/acl.py:192-198`

```python
def acl_principals(ctx) -> frozenset[str]:
    return frozenset({f"user:{ctx.user.user_id}", "user:*", *(f"group:{gid}" for gid in ctx.group_ids)})
```

`acl.py:272` `acl_allows(acl, ctx, action) -> not principals.isdisjoint(acl)` ——**与 `_labels_visible` 是同一个求交语义**。已有生产接线：`viking_vector_index_backend.py:2881-2935` 的 `_tenant_filter`（`account_id` 做租户隔离 ＋ `acl_direct_grants`／`acl_inherited_grants` 做 ACL），以及 `viking_fs/_access.py:182-210` 的按文件读门。开关是 `AccountAclSettings.enabled`（`openviking/config/account_config.py:34-37`，默认 `False`）＋ `AclManager.is_enabled(account_id)`（`acl.py:288`）。

**范围限制**：`acl.py:255` 的 `is_acl_uri` 只覆盖 `viking://resources`，**不含 session／memory**。所以这套标签空间今天管的是资源，不是会话。

## 3. 身份材料在哪、commit 时能不能拿到

`openviking/server/identity.py:92-117` 的 `RequestContext`：`user.user_id`／`account_id`（`:117`）、`group_ids: tuple[str, ...]`（`:99`，服务端解析、声明「调用方不得通过 header 提供」）、`role`、`actor_peer_id`、`bypass_acl`。`UserIdentifier` 是 `(account_id, user_id)` 对（`openviking_cli/session/user_id.py:17-77`）。

**Phase 1（`Session.commit_async`，钩子所在地 `session.py:1556`）**：`self.ctx`（`:439`）与 `self.user`（`:438`）都在，`ctx.user.user_id`、`ctx.group_ids`、`ctx.account_id` 都能读。`_meta.created_by_account_id`／`created_by_user_id`（`:281-282`，写入于 `:460-461`）也在。

**Phase 2（`Session.resume_queued_commit`，`session.py:1688`）**：session 由 `SessionCommitProcessor` 从 `SessionCommitMsg.user` 重建（`session_commit_processor.py:36-46`）。`SessionCommitMsg` 的字段是 `task_id, session_id, session_uri, user, memory_policy, record_auto_commit_success, event_search_tags, auto_commit_policy`（`session_commit_msg.py:10-28`）——**没有 `group_ids`、没有 `actor_peer_id`**；处理器构造的 ctx 是 `RequestContext(user=..., role=Role.USER)`，所以 Phase 2 里 `group_ids == ()`。`account_id`／`user_id` 活着（磁盘上 `.meta.json` 的 `created_by_*` 与队列消息的 `user` 都有）。另外 `SessionService.session()` 会 `replace(ctx, actor_peer_id=None)`（`service/session_service.py:205`）。

**可持久化的身份↔会话映射**：会话 URI 是 `viking://user/<user_id>/sessions/<session_id>`（`core/namespace.py:174-183`，**不含 account id**）；`.meta.json` 里有 `created_by_account_id`／`created_by_user_id`；任务追踪表 `TaskRecord.account_id`／`user_id`／`resource_id == session_id`（`service/task_tracker.py:83-85`），且 `bind_task_context`（`service/task_work_index.py:53-70`）已经在 Phase 2 提交时绑好了归属。注意 `SessionAcl` 只吃 session id，所以回调要自己把 session → owner 查出来（上面三个来源都行）。

**`workspace_id`**：fork／历史代码要的那个标签，生产上**没有生产者**——只有测试与 `benchmark/` 传它；`bot/` 里的 `workspace_id` 是沙箱／agent id（`ov_server.py:51-52`），与 OV 租户无关。

**其它看着像但不是身份**：`CitationLedger` 的 `source_channel_labels` 生产上只有默认值 `("memory",)`（`evaluation_loop.py:174`），是通道名不是身份，`evaluation_loop.py:384` 把它当 principal 传了；`privacy` 配置的 `labels` 是目标元数据。`MemoryConfig`／`TrajectoryIndexConfig` 里**没有任何 acl／labels 字段**（`memory_config.py:18-48`），只有 `is_causal_mode_enabled` 收下又丢掉 `workspace_id`／`session_id`（`:269`，注明「reserved for later slices」）。

## 4. 结论给我的建议

三档方案，按代价从低到高：

- **(A) 复用既有标签空间，标签取 `user:{user_id}`（＋`user:*`）**：`acl_principals` 已经这么算，语义与 `_labels_visible` 一致；Phase 1／Phase 2 都拿得到 owner（ctx 或 `.meta.json`／队列消息的 `user`）；回调按 session 目录／`.meta.json` 解析 owner。**不需要扩队列消息**，代价是「同账号其他用户看得到」，与资源 ACL 的 `user:*` 语义一致。
- **(B) 同上再加 `group:{gid}`**：标签空间更细，但 `group_ids` **在 Phase 2 被队列消息丢掉**（`SessionCommitMsg` 无此字段），要补字段＋迁移，且它现在是服务端解析的、声明调用方不可提供。
- **(C) 新造 `workspace_id` 的语义和生产生产者**：代价最大，且 `workspace_id` 在 `bot/` 已是另一个意思，容易混。

我倾向 **(A)**，并把「要不要含 group」作为设计问题留给设计对话。**另一个同样要定的是开关**：资源侧 ACL 默认 `enabled=False`（`account_config.py:34-37`），若检索侧沿用同一开关，默认行为就是「标签仍算得出来、但门是否生效」需要一次明确表态——这直接影响 R6 能不能默认接线。

**R5c／R6 仍按我的建议等这一条定案**：在此之前把检索门面接生产，会以「无标签」状态跑起来，按现有约定那是全部不可见。
