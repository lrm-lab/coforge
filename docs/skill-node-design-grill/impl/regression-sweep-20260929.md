# 全分支横向回归核对（ZCode，2026-09-29）

目的：11 个提交之后，确认聚焦文件之外的测试没有被带坏。

## 分支上跑

`uv run pytest tests/*.py -q -o addopts=''` → **745 passed / 7 failed / 16 errors**（11 秒）。

7 个失败：

| 测试 | 判定 |
|---|---|
| `test_trajectory_index.py::test_missing_projection_registry_warns_once_and_still_indexes` | 已知基线 |
| `test_trajectory_index.py::test_supersede_without_revalidation_callback_warns_once` | 已知基线 |
| `test_prompt_manager.py::test_profile_memory_template_includes_stable_identity_work_style_and_preferences` | base 上复现 |
| `test_prompt_manager.py::test_preferences_memory_template_keeps_topic_specific_preferences` | base 上复现 |
| `test_edge_cases.py::TestBoundaryConditions::test_directory_upload_with_circular_symlinks` | base 上复现（环境：软链接） |
| `test_citation_ledger.py::test_offline_counts_warn_once` | base 上复现 |
| `test_causal_bridges.py::test_corrupt_jsonl_line_is_skipped_and_store_stays_usable` | base 上复现 |

16 个 error 全在 `tests/test_session_task_tracking.py`（加 `tests/test_session_async_commit.py` 那一条），根因是 `tests/utils/mock_agfs.py:129` 的 `FileNotFoundError: /local/_system/runtime_config/cluster.json`——机器绝对路径，环境基线。

## base 上核对

把 `e8a8babf4` 导出到 `/tmp/ov-base`（`git archive`，不动仓库），用同一个 venv 跑那 5 个可疑失败加 `tests/test_session_task_tracking.py`：

```
5 failed, 15 errors in 7.83s
```

**5 个失败逐一在 base 上复现，errors 同样是 fixture 路径问题。** 这 5 个文件（`prompt_manager`、`edge_cases`、`citation_ledger`、`causal_bridges`）在 R0–R5b 里一次都没被改过。

## 结论

**11 个提交没有带来聚焦文件之外的回归。**

## 复跑（R5b＋R5c 之后）

同一分支再跑一次 `uv run pytest tests/*.py -q -o addopts=''` → **773 passed / 7 failed / 16 errors**（10.5 秒）。失败与错误是同一批，通过数从 745 涨到 773——R5b＋R5c 新增的 28 条测试全绿，没有带入新的失败。

## 一条值得记下的怪癖

`test_influence_projection.py::test_acl_change_without_revalidation_callback_warns_once` 在这次宽扫里**没有**失败，但在聚焦命令里稳定失败。这与之前查到的根因一致：它断言告警进了 `caplog`，而告警实际打到了 stdout；`caplog` 能不能收到受同一次运行里其他测试的顺序影响。所以它是**顺序相关**的基线失败，不是我们改好的。
