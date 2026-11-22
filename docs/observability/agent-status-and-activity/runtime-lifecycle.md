# Runtime 生命周期 detailKind 与冷空闲回收

以下 `detailKind` 描述 Agent runtime 进程的接收、退出、重启和 session 替换；权威定义同样在
`AGENT_ACTIVITY_DETAIL_KIND`。Provider 信号类的值见 [detail-kinds.md](detail-kinds.md)。

| detailKind            | 上报条件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 展示                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `message_received`    | 消息投递/唤醒后既有的“Message received”上报，改用这个 kind 而不是通用的 `model_request_started`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 可见，写入历史                                                                         |
| `runtime_crashed`     | 四个 provider 一致：进程在非主动停止下意外退出，且退出前最近一次 `error` 事实还没有被 `completed` 事件解决（`errorClass`/`errorReason`/`fingerprint` 由 Daemon 核心统一分类，见[「错误与重连的单一转换点」](../activity-delivery-and-errors.md)）；否则报 `idle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 可见，写入历史，视为错误                                                               |
| `runtime_interrupted` | 主动 stop/restart 打断了一个正在忙碌（working/thinking）的 turn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 可见，写入历史，视为在线                                                               |
| `stalled_recovery`    | 新消息到达时，Agent 的 turn 仍忙碌且 provider 已连续沉默超过阈值——会话声明 `steersBusyTurn`（消息能送进进行中 turn：Claude Code、Codex、Pi、CoForge、Kiro、Cursor、Grok、Antigravity）为 15 分钟，未声明、消息只能排队到 turn 结束的（OpenCode、DSH、Command Code、Devin、Droid）为 60 分钟（对齐 Raft 1.0.63 的 `RUNTIME_PROGRESS_STALE_MS`/`NON_STDIN_ALIVE_RECOVERY_MS`）——或者有消息排队满 15 分钟而 session 始终没有开始新一轮（等待时长取 `AgentDeliveryGate.queuedForMs`，不是 provider 沉默时长——空闲 Agent 刚收到的第一条消息不算卡住）；两种情况都要求没有未结束的工具调用、会话已上报可恢复的 native session。Daemon 不把消息塞进卡住的 turn，而是留给下一次 launch，结束 provider 进程（不报 stopped/crashed），用同一个 launchId 唤醒并恢复同一 session（`daemon-runtime/stalled-recovery.ts` 判定，`daemon-runtime/runtime-release.ts` 执行，与冷空闲回收共用）；这次唤醒同样经过[冷空闲回收](#冷空闲回收)的判断，沉默超过冷却间隔且上下文超过阈值时改开新 session。沉默时长从最近一个 provider 事件或开启新 turn 的通知起算（与参考客户端一致）；进程退出后，旧 turn 里未结清的 tracked @mention 留给下一次 launch（恢复同一 session 时，已在 turn 内告知的留在原 session 里）；重启期间到达的消息和 tracked @mention 同样等下一次 launch，由它的输入告知一次；进程 10 秒内不退出或拒绝退出时报一条 error 级 `runtime_error`（“Restarting the stalled <Runtime> runtime failed”），重新启动失败沿用启动失败的错误，同一 launch 不再重试。阈值和文案与参考客户端一致 | 可见，写入历史，info 级，文案“Restarting stalled <Runtime> runtime for queued message” |
| `runtime_unavailable` | Daemon 检测到已存的 native Session 无法恢复——缺失（kiro/pi 的 `session_missing`，或 Claude/Codex 驱动内部静默替换）或被 provider 拒绝 replay（`provider_replay_rejected`）；上报一次 `agent:session:invalidate` 后，以同一 `launchId` 冷启动新 session。冷空闲回收决定不恢复旧 session 时也以 info 级上报本 kind（不发 invalidate），文案“Starting a fresh <Runtime> session (idle Nm, ~Xk context) with a briefing”，见[冷空闲回收](#冷空闲回收)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 可见，写入历史，视为 working                                                           |

## 冷空闲回收

空闲超过运行时 prompt-cache 寿命且上下文超过阈值的 native session 会在停止/唤醒时回收并携带简报重启新 session（支持 Claude 5m/1h 缓存档位门控）；停止与唤醒流程、日志事件和环境变量见 [冷空闲回收](wake-session-recycle.md)。

## 恢复后秒崩（resumed early crash）

对齐 Raft 1.0.63 的 `noteResumedEarlyCrashClose` 与 `repeated_early_crash`：一个已存的 native
session 如果每次恢复后几秒内就让 runtime 静默崩溃，说明它在 provider 无法上报的层面已损坏，继续
恢复只会让每次唤醒都烧掉一次 launch 并卡住任务。

- **判定**（`daemon-runtime/resumed-early-crash.ts`）：launch 请求恢复某个已存 session、进程在
  15 秒内自行退出、退出前没有任何模型输出（主 session 的 text/thinking/tool_start，子 agent
  的不算）、且不是 Daemon 主动收尾——stop、take-offline、任何投递 hold（退避或熔断）、daemon
  停止都不计。"自行退出"由 `AgentSession.onExit` 带的退出详情证明，与 Raft 的
  `signal === null && code > 0 && code < 128` 一致：只有 1–127 的自退出码计次；信号死亡
  （stop、升级重启、OOM）、干净退出、以及适配器无法判断死因的退出都不计，
  `launch.stopping` 标记仍作为补充闸门。非计次的退出、session id 变化都会清零连击。
- **兜底**：同一 session 连续两次计次（`RESUMED_EARLY_CRASH_FALLBACK_THRESHOLD`）后，Daemon 发
  `agent:session:invalidate`（reason `repeated_early_crash`），清掉本地 session 引用与
  restart config 里的恢复指针，再以 `sessionMode: "create"`、无 session id 走普通 launch 通道
  冷启动新 session；排队中的投递照常带进新 launch。Activity 沿用 `runtime_unavailable`
  cold-start 文案：“Stored <Runtime> session keeps crashing on resume; cold-starting a new
  session…”。连击状态只在内存里，daemon 重启后重新计。

## 卡住判定的诊断日志

一次卡住修复要能在事后从日志复原它当时的输入（字段约定见
[local-logging](../../local-logging.md) §4/§6）：

- 判定行（`turn_stalled`）与重启行（`agent.runtime.stalled_recovery`）带 `reason`
  （`silent_turn` / `queued_turn_never_started` / `noticed_but_frozen`）、`threshold_ms`（本次用的
  阈值：15 或 60 分钟）、`silent_for_ms`、`last_event_at`（最近一个 provider 事件的时刻）、
  `steers_busy_turn`。
- 可见 notice（`agent_runtime:turn_stalled`）是另一条规则：窗口有 tool（10 分钟）与 model（20 分钟）
  两条，计时只看工作量事件，判定与诊断行见
  [stalled-turn-windows](./stalled-turn-windows.md)。
- 工具调用只写一行，且只写 ledger 自己计时满 `TOOL_CALL_LOG_MIN_MS`（5 秒）的调用：
  `agent_runtime:tool_finished`（调用正常结束）或 `agent_runtime:tool_unfinished`（turn 结束时仍
  未报告结束，或进程随 launch 一起结束）。字段为 `agent_id`、`launch_id`、`call_id`、`tool`、
  `duration_ms`，正常结束时另加 `exit_code`、`ok`；不记参数和输出。`duration_ms` 是从 start 事件
  到结束的窗口，所以该行时间戳减 `duration_ms` 就是调用开始时刻。每个 launch 有记录上限，超出时
  只写一条 `agent_runtime:tool_log_truncated`。
- provider 进程写的 `code_agent.*` 记录从自己的启动环境读 `agent_id` 与 `launch_id`
  （`packages/anvil/src/jsonl-process.ts`），所以它们能和上面两类按同一个 launch 关联。
