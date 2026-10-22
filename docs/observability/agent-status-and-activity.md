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
| `message` | `running_command`/`tool_started` 固定为不含参数的通用标签（详见[「`running_command` 与工具摘要」](running-command-summary.md)，例如「Running command…」「Reading file…」）；命令、路径等参数摘要只出现在 `tool_start` entry 的 `toolInput` 字段里，从不拼入 `message`；文件读写、编辑和工具 Activity 完整保留 provider 消息；错误和警告使用 Daemon 核心处理后的诊断文本（provider 只上报原始事实，见[错误与重连的单一转换点](activity-delivery-and-errors.md)） |
| `occurred_at` | daemon 记录的 UTC RFC 3339 时间 |
| `launch_id` | 每次实际 OS process launch 的新身份；替换后不得复用 |
| `client_seq` | 同一 `launch_id` 内从 1 开始严格递增的 daemon 序号 |

第一批 activity 类型只定义实际需要的过程记录，不预先枚举 Agent 状态机：

| activity | 用途 |
| --- | --- |
| `starting` | 开始启动或重启 Agent runtime process |
| `stopped` | Agent runtime process 已停止或退出 |
| `idle` | Agent 当前没有执行中的 turn（一次 turn 完成，且它启动的后台 task 都已结束，见 `subagent_activity`） |
| `running_command` | Agent 正在执行命令 |
| `reading_file` / `writing_file` / `editing_file` | Agent 的文件工具操作 |
| `runtime_error`（`runtimeError.errorClass=LauncherError`） | 启动失败：`errorReason` 为稳定原因（见[启动失败原因](activity-delivery-and-errors.md#启动失败原因)），`detail` 给出原因和下一步；下线类见[该节](activity-delivery-and-errors.md#需要人处理的运行时错误agent-下线) |
| `runtime_error`（无 `runtimeError`） | 安全回收失败（进程未确认退出）；使用脱敏后的可操作原因 |
| `error` / `warning` | provider 运行错误或可恢复警告 |

`detailKind` 上还有以下值，只在对应 provider 确有真实信号时才
上报；`packages/coforge-sdk/src/internal/index.ts` 的 `AGENT_ACTIVITY_DETAIL_KIND` 是
唯一权威定义：

| detailKind | 上报条件 | 展示 |
| --- | --- | --- |
| `tool_end` | Claude 的 `tool_result`、Codex 的 `item/completed`（命令、文件修改的每个文件、MCP 工具、网页搜索、协作工具）、Kiro 的 `tool_call_update` 终态、Pi 的 `tool_execution_end`；detail 固定为 “Tool finished”。帧上带 `toolOutcome`（与参考客户端 1.0.50 一致，每个工具都报，包括 Web 隐藏的 `send_message`）：`callId` 即对应 `tool_start` entry 的 `callId`（provider 的 tool call id）；`ok` 表示调用是否跑完：已知 `exitCode` 时一律为 true（无论退出码是否为 0，与参考客户端一致），否则为 provider 未报告失败；`durationMs` 优先取 provider 自测时长（Pi 的 `durationMs`、Codex `commandExecution`/`mcpToolCall` 的 `durationMs`），否则由 Daemon 用单调时钟（`performance.now()`）从同一 launch 观察到的 tool-start 计时，没观察到 start 时不带；`exitCode` 来自 Codex `commandExecution.exitCode`、Grok `Bash` 的 `rawOutput.exit_code`、Pi shell 工具结果的 `structuredContent.exit_code`，以及 Claude Code 出错的 `tool_result` 文本开头的 `Exit code N`（Bash 工具的文本约定，参考客户端同样这样读）。没有结束事件的调用（turn 被打断、进程崩溃）不报 outcome；turn 结束（`completed`）时 Daemon 忘掉该 launch 的所有调用，之后才到的结束不带 `durationMs`。老 Daemon 不带 `toolOutcome`/`callId`，老 Web 解码时忽略这两个字段 | 可见，写入历史（`callId` 随 `entries` 写入；`toolOutcome` 目前只随实时帧下发，不写入历史），Activity timeline 展示为一行状态行（主标题 Working，副标题“Tool finished”），也出现在 Agent 卡片的 Recent activity |
| `thinking_end` | 由 Daemon 从归一化事件流中统一推导（`ActivityTrajectory`）：一次 thinking 运行开始后，下一个 text-delta、tool-start、tool-end、压缩信号（`compaction-started`/`-finished`/`-interrupted`）、review 信号（`review-started`/`-finished`）、turn 结束或 error 到来时上报一次，之后新的 thinking 运行会重新宣告 `thinking_started`；对每个 provider 都成立，不依赖各 provider 的专属信号；detail 固定为 “Thinking finished” | 同 `tool_end`，副标题“Thinking finished” |
| `compacting_context` | Claude 的 `system/status=compacting`（原先误报为 `runtime_progress`）；Kiro 的 ACP `compaction_update`（`status=in_progress`）；Pi/CoForge 的 SDK `compaction_start` 事件；Codex 的 `contextCompaction` item 的 `item/started`。自 2026-09-18 起，provider 只上报归一化的 `compaction-started`/`compaction-finished`/`compaction-interrupted`/`progress` 信号（`packages/agent/src/contract.ts`），由 Daemon core（`packages/daemon/src/agent-runtime/phase-tracker.ts`）统一去重（同一次压缩只报一次“开始”）并决定是否上报 Activity；detail 固定为 “Compacting context” | 可见，写入历史，文案“Compacting context…” |
| `compaction_finished` | 上述 provider 各自的结束信号（Claude 的 `compact_boundary`；Kiro 的 `compaction_update` 转为 `completed`；Pi/CoForge 的 `compaction_end`，未被中止时；Codex 的 `contextCompaction` item 的 `item/completed`）。Daemon core 还会在压缩仍处于打开状态时，从恢复输出（文本/thinking）、新工具调用或 turn 结束推断出压缩已结束，并在这些信号自身的 Activity 之前上报；detail 为 “Context compaction finished”，推断时为 “Context compaction finished (inferred from resumed output / resumed tool use / turn end)”（与参考客户端一致） | 同 `tool_end`，副标题为 daemon 上报的 detail（为空时回退为“Compaction finished”） |
| `system_message`（压缩中断） | 压缩处于打开状态时收到 `compaction-interrupted`（Pi 的 `compaction_end` 被中止；Kiro 的 `compaction_update` 转为 `failed`/`cancelled`；Grok 的 `auto_compact_cancelled`/`auto_compact_failed`，或 turn 结束（含进程意外退出）时压缩仍未收尾）。只报一次；没有打开的压缩时不报。信号不区分中止与失败（失败另有 error 上报），与参考客户端的未知原因文案一致 | 可见，写入历史，info 级，文案“Context compaction interrupted; completion was not confirmed” |
| `reviewing_changes` | provider 进入 review 模式：Codex 的 `enteredReviewMode` item 的 `item/started`，provider 上报归一化的 `review-started`；Daemon core 与压缩共用同一套去重（同一次 review 只报一次“开始”）。只有 Codex 产生该信号 | 可见，写入历史，info 级，detail “Reviewing changes” |
| `review_finished` | review 处于打开状态时收到 `review-finished`（Codex 的 `exitedReviewMode` item 的 `item/completed`）；没有打开的 review 时不报。review 由工具调用和输出组成，因此不像压缩那样从输出或新工具调用推断结束；turn 结束只静默关闭 review，不另报一行 | 同 `tool_end`，detail “Review finished” |
| `review_stale` | review 开始 10 分钟后仍未收到结束信号（与参考客户端 1.0.50 一致；压缩是 5 分钟），每次 review 只报一次 | 可见，写入历史，info 级，detail “Review mode still active; no finish event observed” |
| `subagent_activity` | 任意携带 subagent 归属（Claude `parent_tool_use_id`）的 trajectory entry，归属里知道类型时还带 `subagentType`（线上 `ActivityTrajectoryEntry.subagent_type`，可选；取 Claude Code 记录自身的 `subagent_type`，否则取启动该 subagent 的顶层 `Agent`/`Task` 调用的 `input.subagent_type` 或该调用 `task_started` 的 `subagent_type`；Claude 适配器在生成归属时压成单行、最多 `ACTIVITY_SUBAGENT_TYPE_MAX`（40）个码点（含省略号），什么都不剩时不带）；以及 Claude Code 每个非 `ambient` task 的生命周期（`task_started`/`task_progress`/`task_notification`，subagent、后台命令、Monitor 都算，与参考 Computer 1.0.50 一致；`ambient: true` 是 Claude Code 自身的工作，按官方 SDK 文档不进活动指示），Daemon core 把它写成“Subagent started/working (<subagent_type>)”，notification 按其 `status` 写成“Subagent completed/failed/stopped (<subagent_type>)”（没有 status 时为“Subagent update”），只在当前 launch 忙碌时上报（turn 中，或下述后台等待中；其余时候到达的不唤醒 Agent），与上一条相同的不重复上报。后台等待：Daemon 按 `task_id` 统计当前 launch 已 started、尚未收到带终止 `status` 的 notification 的 task（同一 `task_id` 重复 started 只算一个；新 turn 不清零；新 launch、停止、进程退出清零，Claude 换成新 session 时为旧进程的 task 补报 `stopped`）；无错误结束的 turn（或 Daemon 发现已结束、没有结果的 turn）若仍有 N 个未结束，就以本 kind 报“Waiting for N background task(s)”而不报 `idle`，忙碌心跳照常续租、liveness probe 照常应答它、`coforge-computer restart` 的 runner hold 也把它算作忙碌（受原有等待上限约束）；此后每个 task 结束都报缩小后的等待，最后一个结束时才报 `idle` 并走 turn 结束的 Idle 步骤（System Cleaner 提示在此时呈现）。等待期间 `hasLiveTurn=false`，新消息照常开启新 turn。后台 task 结束后 Claude Code 自行开启的 turn（以顶层 `init` 开头）也是真正的 turn：期间 Agent 显示 Working，结束时若仍有未结束的 task，同样报上述等待行。只有 Claude 产生这两类信号 | 可见，写入历史；Agent 当前状态显示“Subagent working…”。生命周期行（没有 entries）的主标题为“Subagent working”，副标题是上述文案；trajectory 帧不合并成一行，每个 entry 像主 Agent 的一样各成一行，其中工具行和 system 行带 badge（归属知道类型时为“Subagent: <type>”，否则为“Subagent”），thinking/文本行不带 |
| `message_received` | 消息投递/唤醒后既有的“Message received”上报，改用这个 kind 而不是通用的 `model_request_started` | 可见，写入历史 |
| `runtime_crashed` | 四个 provider 一致：进程在非主动停止下意外退出，且退出前最近一次 `error` 事实还没有被 `completed` 事件解决（`errorClass`/`errorReason`/`fingerprint` 由 Daemon 核心统一分类，见[「错误与重连的单一转换点」](activity-delivery-and-errors.md)）；否则报 `idle` | 可见，写入历史，视为错误 |
| `runtime_interrupted` | 主动 stop/restart 打断了一个正在忙碌（working/thinking）的 turn | 可见，写入历史，视为在线 |
| `stalled_recovery` | 新消息到达时，Agent 的 turn 仍忙碌，但 provider 已连续 15 分钟没有任何事件；且没有未结束的工具调用、会话已上报可恢复的 native session。Daemon 不把消息塞进卡住的 turn，而是留给下一次 launch，结束 provider 进程（不报 stopped/crashed），用同一个 launchId 唤醒并恢复同一 session（`daemon-runtime/stalled-recovery.ts`）。沉默时长从最近一个 provider 事件或开启新 turn 的通知起算（与参考客户端一致）；进程结束后、新 launch 上报 session 之前，旧 turn 里未结清的 tracked @mention 以 `IDENTITY_UNKNOWN` 交还云端；重启期间到达的消息等下一次 launch，tracked @mention 同样以 `IDENTITY_UNKNOWN` 拒绝，都由云端在新 session 上报后重发；进程 10 秒内不退出或拒绝退出时报一条 error 级 `runtime_error`（“Restarting the stalled <Runtime> runtime failed”），重新启动失败沿用启动失败的错误，同一 launch 不再重试。阈值和文案与参考客户端一致 | 可见，写入历史，info 级，文案“Restarting stalled <Runtime> runtime for queued message” |
| `runtime_unavailable` | Daemon 检测到已存的 native Session 无法恢复——缺失（kiro/pi 的 `session_missing`，或 Claude/Codex 驱动内部静默替换）或被 provider 拒绝 replay（`provider_replay_rejected`）；上报一次 `agent:session:invalidate` 后，以同一 `launchId` 冷启动新 session | 可见，写入历史，视为 working |

## 服务端写入的 Computer 生命周期记录

以下五个 `detailKind` 不由 Daemon 上报，只由服务端写入该 Computer 上每个 active Agent 的
Activity（`apps/web/src/server/agents/computer-lifecycle-activity.server.ts`）。它们使用
独立的 `launch_id`（`computer-lifecycle:<request_id>`，`client_seq=1`），不改变 Agent 状态，
也不并入 Agent 的某次运行。除 `computer_operation_failed` 为 `error` 级外，其余都是 `info`
级且 `detail` 为空：行只显示标签，更早写入的带 `detail` 的同类行也一样。

| detailKind | 写入时机 | 标签 | detail | 圆点 |
| --- | --- | --- | --- | --- |
| `computer_disconnected` | Workspace daemon 主动关闭前发送 `daemon:v1:runtime:shutdown`，原因为 `computer_restart` 或 `computer_stop`（来自关闭时仍新鲜的 runner hold） | `Disconnected` | 空 | offline |
| `computer_upgraded` | 新 daemon 实例首次 ready，且服务端升级记录确认由该实例完成，或无升级记录但 Computer 版本相对上一实例变化 | `Upgraded` | 空 | idle |
| `computer_operation_failed` | 新实例首次 ready，且宣告的升级未完成（升级记录失败，或无升级记录且版本未变） | `Computer operation failed` | 说明仍在运行的版本和下一步命令 | error |
| `computer_restarted` | 新实例首次 ready，且之前宣告了重启，或服务端重启记录由该实例完成 | `Restarted` | 空 | idle |
| `computer_started` | 新实例首次 ready，且不属于以上情况（冷启动、崩溃后再启动、次日启动） | `Started` | 空 | idle |

同一 daemon 实例的后续 ready（重连、重试）不再写入。意外断线没有服务端信号（Centrifugo
没有 disconnect proxy，Computer 在线状态只是 90 秒租约自然过期），因此不写
`computer_disconnected`；下一次 ready 写 `computer_started`。这些值统一使用 `computer_*`
前缀，只在服务端与浏览器之间使用。

`starting`、`stopped`、`idle` 是 timeline 记录，不是新的 Agent 业务状态；当前状态仍只
由 `agent:status` 的 `active` / `inactive` 表示。只有真正发生过程或观察结果时才记录
对应 activity，不能用定时 heartbeat 不断重复制造相同 activity——但见下方的忙碌心跳例外：为了不让安静运行超过 60 秒的 turn（一条 shell 命令或一次安静的模型调用）
在展示层被误判为 online，Daemon 在 Agent 处于 `working`/`thinking` 时，每 60 秒
（`ACTIVITY_HEARTBEAT_MS`）重发最近一条忙碌 Activity，显式标记 `is_heartbeat=true`、
`client_seq` 递增、`entries` 为空。服务端把这类心跳（以及下方的 `runtime_progress`）
仅用于把展示租约 `WORKING_LEASE_MS` 续期到 90 秒，并保持 `working`/`thinking`；不写入
`agent_activities` 历史，也不计入前端“最近活动”列表；只有可见状态真的变化时才推进
`agent:display` 的 revision。`runtime_progress` 是新增的 discriminator，用于 provider
产生的、没有可渲染文本的 stream/system 事件（例如 Claude Code 的部分 stream 帧、Codex 的
原始 reasoning 增量和非最终回答的 agent message（`commentary`/`partial_answer`）、Kiro 的 `tool_call_update`/`plan`/`usage_update` 通知、Pi/CoForge 的
turn/message 生命周期事件）；这些信号自 2026-09-18 起统一上报为归一化的 `progress` 事件
（`packages/agent/src/contract.ts`），由 Daemon core（`packages/daemon/src/daemon-runtime/runtime.ts`）
决定是否上报——不再是固定的“每 10 秒最多一条”限流，而是只在 Agent
当前这次 launch 尚未显示为忙碌（working/thinking）时才上报一次；一旦已经忙碌，同样的信号
不重复产生 Activity，存活展示由上述忙碌 Activity 心跳维护，也不产生新的 Agent 业务状态。

心跳只覆盖续租，不覆盖租约已经到期之后的情形：租约一旦到期，服务端没有可信来源，只能在
下一次读写时把 Agent 惰性投影为 `online`。为此服务端自己运行一个 liveness sweep，而不是等浏览器按需触发：`OBSERVE_ACTIVITY`/`OBSERVE_STATUS` 维护一个按
`expiresAt` 排序的 lease 索引（busy 时 `ZADD`，转为非 busy 或 `inactive` 时 `ZREM`）；
`AgentActivitySweep` 每 5 秒（`ACTIVITY_SWEEP_INTERVAL_MS`）在一个 Redis 锁下 tick 一次
（`NX PX 4500`，未抢到锁的实例整轮跳过，保证同一时刻整个集群只有一个实例在扫描），批量
取出已过期的 lease，对每个成员运行 `SWEEP_STALE`：还新鲜则从索引移除；刚过期且未探测过
则记录一次待定探测并向其 Daemon 发布新的 `agent:activity_probe` 意图；已探测但仍在等待则
跳过；探测已经等待超过 `ACTIVITY_PROBE_TIMEOUT_MS`（5 秒）则判定为不可达，清除可见忙碌
状态并直接把结果推给 `agent:status:<workspace_id>`，浏览器随即可见 Agent 变回 online。Daemon 用一条带 `probe_id` 的普通 `agent:activity` 应答，按序取第一条
成立的：仍有未读投递（Memory Agent 批量观察的普通频道消息不算）回复 `message_received`，
启动中回复 `starting`，有最近一条忙碌 Activity 则重发它，否则回复 `idle`；探测应答不算新的忙碌证据。服务端把它当成真实观测处理，
而不是当成心跳：只有心跳和 `runtime_progress` 本身不改变可见状态，探测应答可以把展示从
`working`/`thinking` 纠正为 `idle`，也可以续租并保持忙碌，并清除该 Agent 待定的探测记录。
探测应答同样不写入 `agent_activities` 历史，也不进入前端“最近活动”列表。浏览器自身完全
不发起探测请求；`useAgentStatuses` 只是把 `expiresAt` 之后的 `refresh()` 再推迟
`ACTIVITY_PROBE_TIMEOUT_MS + 1000ms`，作为 sweep 推送丢失时的兜底，而不是触发探测的手段。

```text
event: agent:activity
activity: running_command
level: info
message: Running command…
entries: [{ kind: "tool_start", toolName: "bash", toolInput: "bun test packages/daemon/test/daemon-runtime.test.ts", callId: "call_1" }]

event: agent:activity
activity: tool_end
level: info
message: Tool finished
toolOutcome: { callId: "call_1", ok: true, durationMs: 1500, exitCode: 1 }
```
