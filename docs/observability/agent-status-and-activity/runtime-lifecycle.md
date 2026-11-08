# Runtime 生命周期 detailKind 与冷空闲回收

以下 `detailKind` 描述 Agent runtime 进程的接收、退出、重启和 session 替换；权威定义同样在
`AGENT_ACTIVITY_DETAIL_KIND`。Provider 信号类的值见 [detail-kinds.md](detail-kinds.md)。

| detailKind            | 上报条件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 展示                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `message_received`    | 消息投递/唤醒后既有的“Message received”上报，改用这个 kind 而不是通用的 `model_request_started`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 可见，写入历史                                                                         |
| `runtime_crashed`     | 四个 provider 一致：进程在非主动停止下意外退出，且退出前最近一次 `error` 事实还没有被 `completed` 事件解决（`errorClass`/`errorReason`/`fingerprint` 由 Daemon 核心统一分类，见[「错误与重连的单一转换点」](../activity-delivery-and-errors.md)）；否则报 `idle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 可见，写入历史，视为错误                                                               |
| `runtime_interrupted` | 主动 stop/restart 打断了一个正在忙碌（working/thinking）的 turn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 可见，写入历史，视为在线                                                               |
| `stalled_recovery`    | 新消息到达时，Agent 的 turn 仍忙碌且 provider 已连续沉默超过阈值——会话声明 `steersBusyTurn`（消息能送进进行中 turn：Claude Code、Codex、Pi、CoForge、Kiro、Cursor、Grok、Antigravity）为 15 分钟，未声明、消息只能排队到 turn 结束的（OpenCode、DSH、Command Code、Devin、Droid）为 60 分钟（对齐 Raft 1.0.63 的 `RUNTIME_PROGRESS_STALE_MS`/`NON_STDIN_ALIVE_RECOVERY_MS`）——或者有消息排队满 15 分钟而 session 始终没有开始新一轮（等待时长取 `AgentDeliveryQueue.queuedForMs`，不是 provider 沉默时长——空闲 Agent 刚收到的第一条消息不算卡住）；两种情况都要求没有未结束的工具调用、会话已上报可恢复的 native session。Daemon 不把消息塞进卡住的 turn，而是留给下一次 launch，结束 provider 进程（不报 stopped/crashed），用同一个 launchId 唤醒并恢复同一 session（`daemon-runtime/stalled-recovery.ts` 判定，`daemon-runtime/runtime-release.ts` 执行，与冷空闲回收共用）；这次唤醒同样经过[冷空闲回收](#冷空闲回收)的判断，沉默超过冷却间隔且上下文超过阈值时改开新 session。沉默时长从最近一个 provider 事件或开启新 turn 的通知起算（与参考客户端一致）；进程结束后、新 launch 上报 session 之前，旧 turn 里未结清的 tracked @mention 以 `IDENTITY_UNKNOWN` 交还云端；重启期间到达的消息等下一次 launch，tracked @mention 同样以 `IDENTITY_UNKNOWN` 拒绝，都由云端在新 session 上报后重发；进程 10 秒内不退出或拒绝退出时报一条 error 级 `runtime_error`（“Restarting the stalled <Runtime> runtime failed”），重新启动失败沿用启动失败的错误，同一 launch 不再重试。阈值和文案与参考客户端一致 | 可见，写入历史，info 级，文案“Restarting stalled <Runtime> runtime for queued message” |
| `runtime_unavailable` | Daemon 检测到已存的 native Session 无法恢复——缺失（kiro/pi 的 `session_missing`，或 Claude/Codex 驱动内部静默替换）或被 provider 拒绝 replay（`provider_replay_rejected`）；上报一次 `agent:session:invalidate` 后，以同一 `launchId` 冷启动新 session。冷空闲回收决定不恢复旧 session 时也以 info 级上报本 kind（不发 invalidate），文案“Starting a fresh <Runtime> session (idle Nm, ~Xk context) with a briefing”，见[冷空闲回收](#冷空闲回收)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 可见，写入历史，视为 working                                                           |

## 冷空闲回收

与参考客户端 1.0.51 的 `wakeSessionRecycle` 一致，默认开启。空闲超过该运行时的 prompt cache
寿命，且最近一次上下文超过阈值（默认 128k token）的 native session 不再恢复：恢复会按全价重读
整个上下文。冷却间隔由 provider 声明：Claude Code 60 分钟，Codex 30 分钟（这台 Mac 上 35 分钟内
缓存几乎全中，OpenAI 默认缓存至少 30 分钟；Raft 1.0.53 虽把 codex 列进同一机制，但只读 Claude
的会话记录）。未声明的 provider 仍是 60 分钟。只有实现了 `readSessionResumeFacts` 的 provider
会被回收；seam 给不出的任何事实都按恢复处理。Memory Agent 不参与。

- **停止**：`daemon-runtime/cold-idle-sweep.ts` 每个 sweep 周期（默认 10 分钟）检查一次运行中的
  Agent。Daemon 自身状态的每个空闲条件都成立（没有 live turn、排队投递或输入、未结束的工具调用、
  后台 task、launch、stop、卡住重启、runner hold 或迁移），且 runtime 最近事件和 session 自身
  记录都早于冷却间隔时，结束进程，不报 stopped/crashed，Agent 保持 `active`。停止前上报一条
  info 级 `idle`：“Stopped idle <Runtime> runtime (idle Nm, ~Xk context) to free memory; it
  restarts on the next message”。停止期间到达的消息和 app-item 通知留给随后的 launch；进程不肯
  退出时报 error 级 `runtime_error`（“Stopping the idle <Runtime> runtime failed”），留下的
  消息交还给仍在运行的进程。
- **唤醒**：下一条消息照常走已退出 Agent 的唤醒路径。launch 注册之后才读取 session 事实并决定
  是否恢复（`daemon-runtime/wake-recycle.ts`）。回收时不带 session id 启动，session 上报以
  `replacedSessionId` 携带旧 id（不发 `agent:session:invalidate`），新 session 上报前保留旧引用，
  因此 launch 失败时下次仍用旧 id。launch 的第一条输入是简报：`MEMORY.md` 与
  `notes/active-context.md` 的开头（各自份额内，不跟随符号链接）加 provider 从旧 transcript 整理出
  的近况；简报建不出来时仍以空白新 session 启动。带 `resumePrompt` 或以 `create` 方式启动的 launch
  不回收。

| 日志事件                               | 级别       | 含义                                                                                                                                      |
| -------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.runtime.cold_idle_sweep`        | info       | 一次 sweep 的汇总：`agents`、`stops`，以及按原因计数的 `skipped_<reason>`                                                                 |
| `agent.runtime.cold_idle_sweep_failed` | warn       | sweep 本身失败                                                                                                                            |
| `agent.runtime.cold_idle_stop`         | info       | 停止一个冷空闲 runtime：`session_id`、`idle_ms`、`prior_context_tokens`                                                                   |
| `agent.runtime.cold_idle_stop_failed`  | warn/error | 停止失败；进程未退出时带 `still_running`                                                                                                  |
| `agent.runtime.cold_idle_wake_failed`  | error      | 停止期间有消息到达，随后的唤醒失败                                                                                                        |
| `agent.runtime.wake_recycle`           | info       | 唤醒时的决定：`outcome=resume`（带 `reason`）或 `outcome=recycle`（带 `prior_session_id`、`idle_ms`、`prior_context_tokens`、是否有简报） |
| `agent.runtime.wake_recycle_failed`    | warn       | 决定过程出错，按恢复处理                                                                                                                  |
| `agent.runtime.wake_briefing_failed`   | warn       | provider 简报建不出来，以不带它的新 session 启动                                                                                          |
| `agent.runtime.session_memory`         | info       | 一个 fresh session 的首条输入带上了 `MEMORY.md`/`active-context` 段（`has_memory_block`）                                                 |

| 环境变量                                  | 默认                          | 含义                                                                             |
| ----------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| `COFORGE_WAKE_RECYCLE`                    | 开                            | `0`、`false`、`off` 关闭回收；空值视为未设置                                     |
| `COFORGE_WAKE_RECYCLE_MIN_CONTEXT_TOKENS` | `128000`                      | 上下文阈值                                                                       |
| `COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS`    | provider 声明，否则 `3600000` | 冷却间隔。覆盖 provider 的声明。Codex 声明 `1800000`，Claude Code 声明 `3600000` |
| `COFORGE_WAKE_RECYCLE_SWEEP_MS`           | `600000`                      | sweep 周期；只读 Daemon 自身环境                                                 |
| `COFORGE_WAKE_RECYCLE_PANEL_TOKENS`       | `8000`                        | provider 简报的 token 预算                                                       |

这两段的 token 预算不属于回收：每个 fresh session（首次启动、provider 丢失 session 后的重建、`create`、Memory Agent 的每个新 conversation）和每次上下文压缩完成后都按同样的份额注入——`MEMORY.md` 3000 token（`STARTUP_MEMORY_BUDGET_TOKENS`）、`notes/active-context.md` 1000 token（`STARTUP_ACTIVE_CONTEXT_BUDGET_TOKENS`），两份份额不互相借。

除 sweep 周期外，Agent 自己的 runtime 环境变量覆盖 Daemon 的环境，两者都覆盖 provider 声明的冷却间隔；空值在两级都视为未设置，无法解析的值回落为默认。

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
- 10 分钟的可见 notice（`agent_runtime:turn_stalled`）走的是另一条规则——它只在有工具正在运行时
  才计时，所以没有 `reason`，`threshold_ms` 是它自己的窗口（默认 10 分钟，可用
  `COFORGE_STALLED_TURN_SILENCE_MS` 改）；它带 `open_tool` 与 `open_tool_for_ms`，这正是“沉默
  半小时里在跑构建”和“挂住了”的分界。
- 工具调用只写一行，且只写 ledger 自己计时满 `TOOL_CALL_LOG_MIN_MS`（5 秒）的调用：
  `agent_runtime:tool_finished`（调用正常结束）或 `agent_runtime:tool_unfinished`（turn 结束时仍
  未报告结束，或进程随 launch 一起结束）。字段为 `agent_id`、`launch_id`、`call_id`、`tool`、
  `duration_ms`，正常结束时另加 `exit_code`、`ok`；不记参数和输出。`duration_ms` 是从 start 事件
  到结束的窗口，所以该行时间戳减 `duration_ms` 就是调用开始时刻。每个 launch 有记录上限，超出时
  只写一条 `agent_runtime:tool_log_truncated`。
- provider 进程写的 `code_agent.*` 记录从自己的启动环境读 `agent_id` 与 `launch_id`
  （`packages/anvil/src/jsonl-process.ts`），所以它们能和上面两类按同一个 launch 关联。
