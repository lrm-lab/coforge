# R5c 独立复核（ZCode，2026-09-29）

提交 `17d6310ba` `feat(session): label causal projections with the session owner`，在 `feat/causal-subgraph-retrieval`，未 push。

## 交付物核对

`git show --stat`：5 个文件，`session_acl.py`（新，103 行）、`subgraph_forks.py`（+24）、`trajectory_index_hook.py`（+39）、`tests/test_session_acl.py`（新，277 行）、`tests/test_subgraph_forks.py`（+79）。没碰 `session.py`、没碰 `influence_view.py`／`influence_projection.py`（注册表本身没改，只接线）、没碰 `benchmark/`、没有新依赖。

代码与决策 #116–#118 逐条对上：

- `session_owner_label` 解析顺序就是 `ctx.user.user_id` → `_meta.created_by_user_id` → `_session_uri` 的 user 段，空串落到下一条，三条都没有抛 `ValueError`；标签形状 `user:{uid}`，**不含 `group:`**（`session_acl.py:21-58`）。
- `session_acl_callback` 是闭包，只认自己绑定的 `session_id`，别的 id 抛错而不是返回空序列（fail closed）。
- 钩子构造 `ProjectionRegistry(session_dir / "projections.json", session_acl=...)` 并传 `projection_registry=` ＋ `revalidation_callback=`；标签解析失败只跳过注册表、**视图与索引照常落盘**（`_projection_registry`，`trajectory_index_hook.py:274-291`）——简报要求的「可索引性 ≠ 可见性」落实了。
- fork 写入侧 `_require_workspace_in_labels` 在 `submit_fork_draft`／`persist_provisional_draft` **之前**执行，`str`／`bytes`／非序列／空序列／空条目都拒；数据注入，没有把 ACL 回调塞进写模块。

## 我复跑

```
uv run pytest tests/test_session_acl.py tests/test_subgraph_forks.py tests/test_trajectory_index_hook.py \
  tests/test_influence_projection.py tests/test_trajectory_index.py tests/test_influence_view.py \
  tests/test_retrieval_facade.py tests/test_extraction_write.py -q -o addopts=''
→ 3 failed, 127 passed in 1.94s
```

3 条失败都是点名的基线（`test_acl_change_without_revalidation_callback_warns_once`、`test_missing_projection_registry_warns_once_and_still_indexes`、`test_supersede_without_revalidation_callback_warns_once`），与 cursor 报的一致。

## 我的探针：标签空间能不能真的与读侧对上（`/tmp/probes/exp_r5c_interop.py`）

15 条断言全过。最有价值的三条：

- **归属**：钩子（causal 配置）跑一次 commit 后，`projections.json` 里卡片的 `acl_labels` 恰好是 `("user:alice",)`。
- **隔离**：用 `acl_principals(ctx)` 造读侧 principal，alice 看到自己的卡片（1 张），**bob 看到 0 张**——并且断言了 bob 的 principal 集合里**确实含 `user:*` 通配**，也就是说这条隔离不是靠通配符没生效侥幸通过的，而是因为卡片只挂了具体 owner 标签（对象侧不挂 `user:*`）。
- **解析顺序**：ctx 压过 meta、meta 压过 URI，三条都缺才抛。
- **supersede**：第二次内容不同的 commit 之后，第一份修订的卡片**离开了索引**（搜索结果里 0 张），审计行留在 `removed_records()` 且 `reason == "superseded"`。
- **owner 未知**：`views.json` 仍落盘，`projections.json` **不出现**（可见性 fail closed，索引不因此中断）。

## 已知残留（如实记，不是缺陷）

1. **`needs_revalidation` 没有持久消费者**：钩子接的 `_warn_revalidation_not_persisted` 只打 warning；`ProjectionRegistry` 自己那个 `revalidation_callback` 按简报没有注入，所以撤卡时注册表仍打既有的 “not configured” 警告。日志里两条 warning 都能看到。决策 #85／#86 的「ACL 变更触发再投影／撤下」在生产上仍无触发源，`handle_acl_change` 可被显式调用但没人调。**这一条要 R6 或后续设计决定**。
2. **owner 未知时会多一条噪声 warning**（服务的 “projection_registry is not configured”），行为正确，只是日志上不好区分「没接」与「解析失败」。低危。

## 一件要说清的事：#82 现在到什么程度

决策 #82 的「supersede 旧投影退出索引」**在生产路径上真的发生了**（探针第 4 条），这是 R5a 之后补上的另一半。但**读侧仍未接线**：`projections.json` 今天没有任何生产读者，`InfluenceProjectionAdapter` 只在测试与 `benchmark/` 里构造。读侧属于 R6（见 `R6-recon.md`）。
