# Agent 状态与活动上报通道

Agent 的业务状态只有 `active` 和 `inactive`，Web 分别显示为在线和离线。`active` 表示
Daemon 持有可运行配置并能接受消息，不要求 Agent runtime process 当前存在。首次启动成功后发送
`agent:status(status=active)`，并每 30 秒刷新一次 90 秒租约；进程意外退出时保持
`active`，新消息到达后重新启动。人工停止发送 `agent:status(status=inactive)` 并立即清除
租约。Daemon/Computer 正常关闭也必须在关闭 WSS 前为其管理的 active Agent 发送
`inactive`；只有崩溃、断电或断网等无法上报的异常才依赖租约自然回落为 `inactive`。
Backend 每次接受状态上报后都通过 Workspace 授权的 Centrifugo status channel 向浏览器
发布状态和租约截止时间。页面首次加载及 WSS 重连读取 Redis 快照，平时不轮询 backend；
若续租事件停止，页面在截止时间本地显示为离线。
`agent:status` 与 `agent:activity` 是两个独立的上报通道（两类消息），都通过 daemon 的 WSS 发送。Activity 使用专用的 `agent:activity:<workspace_id>` namespace 做 best-effort publication；服务端和
前端不得从某个错误字符串推导第三种状态，也不得在每个 activity 上重复发送 status。

Agent runtime 的生命周期明细和诊断通过 `agent:activity` 上报，而不是扩展状态。为使
Daemon、服务端存储和前端展示使用同一契约，每条 activity 固定使用以下业务字段：

| 事件 | 用途 | 是否改变 Agent 状态 |
| --- | --- | --- |
| `agent:status` | 携带 `active` 或 `inactive`，报告状态变化 | 按 payload 变更 |
| `agent:activity` | 报告启动、执行、错误和警告明细 | 不改变 |

| 字段 | 语义 |
| --- | --- |
| `activity` | 稳定类型，例如 `running_command`、`reading_file`、`using_tool`、`error` |
| `level` | `info`、`warning` 或 `error` |
| `message` | `running_command`/`tool_started` 固定为不含参数的通用标签（详见[「`running_command` 与工具摘要」](../running-command-summary.md)，例如「Running command…」「Reading file…」）；命令、路径等参数摘要只出现在 `tool_start` entry 的 `toolInput` 字段里，从不拼入 `message`；文件读写、编辑和工具 Activity 完整保留 provider 消息；错误和警告使用 Daemon 核心处理后的诊断文本（provider 只上报原始事实，见[错误与重连的单一转换点](../activity-delivery-and-errors.md)） |
| `occurred_at` | daemon 记录的 UTC RFC 3339 时间 |
| `launch_id` | 每次实际 OS process launch 的新身份；替换后不得复用 |
| `client_seq` | 同一 `launch_id` 内从 1 开始严格递增的 daemon 序号 |

第一批 activity 类型只定义实际需要的过程记录，不预先枚举 Agent 状态机：

| activity | 用途 |
| --- | --- |
| `starting` | 开始启动或重启 Agent runtime process |
| `stopped` | Agent runtime process 已停止或退出 |
| `idle` | Agent 当前没有执行中的 turn（一次 turn 完成，且它启动的后台 task 都已结束，见 `subagent_activity`）；冷空闲回收停掉 runtime 时也用它，见[冷空闲回收](runtime-lifecycle.md#冷空闲回收) |
| `running_command` | Agent 正在执行命令 |
| `reading_file` / `writing_file` / `editing_file` | Agent 的文件工具操作 |
| `runtime_error`（`runtimeError.errorClass=LauncherError`） | 启动失败：`errorReason` 为稳定原因（见[启动失败原因](../activity-delivery-and-errors.md#启动失败原因)），`detail` 给出原因和下一步；下线类见[该节](../activity-delivery-and-errors.md#需要人处理的运行时错误agent-下线) |
| `runtime_error`（无 `runtimeError`） | 安全回收失败（进程未确认退出）；使用脱敏后的可操作原因 |
| `error` / `warning` | provider 运行错误或可恢复警告 |

## 目录

- [Provider 信号的 detailKind](detail-kinds.md): 工具结束、thinking、压缩、review、subagent 等只在 provider 有真实信号时上报的 `detailKind`。
- [Runtime 生命周期 detailKind 与冷空闲回收](runtime-lifecycle.md): 消息接收、崩溃、打断、卡住重启、session 不可恢复，以及冷空闲回收的 Activity、日志事件和环境变量。
- [服务端写入的 Computer 生命周期记录](computer-lifecycle.md): 服务端为 Computer 停止、升级、重启、启动写入的 `computer_*` 记录。
- [忙碌心跳与 liveness sweep](heartbeat-and-liveness.md): 忙碌心跳、`runtime_progress`、服务端 liveness sweep 与探测应答。
