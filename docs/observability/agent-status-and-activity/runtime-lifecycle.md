# Runtime 生命周期 detailKind 与冷空闲回收

以下 `detailKind` 描述 Agent runtime 进程的接收、退出、重启和 session 替换；权威定义同样在
`AGENT_ACTIVITY_DETAIL_KIND`。Provider 信号类的值见 [detail-kinds.md](detail-kinds.md)。

| detailKind | 上报条件 | 展示 |
| --- | --- | --- |
| `message_received` | 消息投递/唤醒后既有的“Message received”上报，改用这个 kind 而不是通用的 `model_request_started` | 可见，写入历史 |
| `runtime_crashed` | 四个 provider 一致：进程在非主动停止下意外退出，且退出前最近一次 `error` 事实还没有被 `completed` 事件解决（`errorClass`/`errorReason`/`fingerprint` 由 Daemon 核心统一分类，见[「错误与重连的单一转换点」](../activity-delivery-and-errors.md)）；否则报 `idle` | 可见，写入历史，视为错误 |
| `runtime_interrupted` | 主动 stop/restart 打断了一个正在忙碌（working/thinking）的 turn | 可见，写入历史，视为在线 |
| `stalled_recovery` | 新消息到达时，Agent 的 turn 仍忙碌，但 provider 已连续 15 分钟没有任何事件；且没有未结束的工具调用、会话已上报可恢复的 native session。Daemon 不把消息塞进卡住的 turn，而是留给下一次 launch，结束 provider 进程（不报 stopped/crashed），用同一个 launchId 唤醒并恢复同一 session（`daemon-runtime/stalled-recovery.ts` 判定，`daemon-runtime/runtime-release.ts` 执行，与冷空闲回收共用）；这次唤醒同样经过[冷空闲回收](#冷空闲回收)的判断，沉默超过冷却间隔且上下文超过阈值时改开新 session。沉默时长从最近一个 provider 事件或开启新 turn 的通知起算（与参考客户端一致）；进程结束后、新 launch 上报 session 之前，旧 turn 里未结清的 tracked @mention 以 `IDENTITY_UNKNOWN` 交还云端；重启期间到达的消息等下一次 launch，tracked @mention 同样以 `IDENTITY_UNKNOWN` 拒绝，都由云端在新 session 上报后重发；进程 10 秒内不退出或拒绝退出时报一条 error 级 `runtime_error`（“Restarting the stalled <Runtime> runtime failed”），重新启动失败沿用启动失败的错误，同一 launch 不再重试。阈值和文案与参考客户端一致 | 可见，写入历史，info 级，文案“Restarting stalled <Runtime> runtime for queued message” |
| `runtime_unavailable` | Daemon 检测到已存的 native Session 无法恢复——缺失（kiro/pi 的 `session_missing`，或 Claude/Codex 驱动内部静默替换）或被 provider 拒绝 replay（`provider_replay_rejected`）；上报一次 `agent:session:invalidate` 后，以同一 `launchId` 冷启动新 session。冷空闲回收决定不恢复旧 session 时也以 info 级上报本 kind（不发 invalidate），文案“Starting a fresh <Runtime> session (idle Nm, ~Xk context) with a briefing”，见[冷空闲回收](#冷空闲回收) | 可见，写入历史，视为 working |

## 冷空闲回收

与参考客户端 1.0.51 的 `wakeSessionRecycle` 一致，默认开启。空闲超过冷却间隔（默认 60 分钟，
超过 prompt cache 的寿命）且最近一次上下文超过阈值（默认 128k token）的 native session 不再
恢复：恢复会按全价重读整个上下文。只有实现了 `code-agent/contract.ts` 中可选 seam
`readSessionResumeFacts` 的 provider（目前是 Claude Code）会被回收；seam 给不出的任何事实都按
恢复处理。Memory Agent 不参与。

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
  因此 launch 失败时下次仍用旧 id。launch 的第一条输入是简报：`MEMORY.md` 开头（预算内，不跟随
  符号链接）加 provider 从旧 transcript 整理出的近况；简报建不出来时仍以空白新 session 启动。带
  `resumePrompt` 或以 `create` 方式启动的 launch 不回收。

| 日志事件 | 级别 | 含义 |
| --- | --- | --- |
| `agent.runtime.cold_idle_sweep` | info | 一次 sweep 的汇总：`agents`、`stops`，以及按原因计数的 `skipped_<reason>` |
| `agent.runtime.cold_idle_sweep_failed` | warn | sweep 本身失败 |
| `agent.runtime.cold_idle_stop` | info | 停止一个冷空闲 runtime：`session_id`、`idle_ms`、`prior_context_tokens` |
| `agent.runtime.cold_idle_stop_failed` | warn/error | 停止失败；进程未退出时带 `still_running` |
| `agent.runtime.cold_idle_wake_failed` | error | 停止期间有消息到达，随后的唤醒失败 |
| `agent.runtime.wake_recycle` | info | 唤醒时的决定：`outcome=resume`（带 `reason`）或 `outcome=recycle`（带 `prior_session_id`、`idle_ms`、`prior_context_tokens`、是否有简报） |
| `agent.runtime.wake_recycle_failed` | warn | 决定过程出错，按恢复处理 |
| `agent.runtime.wake_briefing_failed` | warn | provider 简报建不出来，以不带它的新 session 启动 |

| 环境变量 | 默认 | 含义 |
| --- | --- | --- |
| `COFORGE_WAKE_RECYCLE` | 开 | `0`、`false`、`off` 关闭回收；空值视为未设置 |
| `COFORGE_WAKE_RECYCLE_MIN_CONTEXT_TOKENS` | `128000` | 上下文阈值 |
| `COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS` | `3600000` | 冷却间隔 |
| `COFORGE_WAKE_RECYCLE_SWEEP_MS` | `600000` | sweep 周期；只读 Daemon 自身环境 |
| `COFORGE_WAKE_RECYCLE_PANEL_TOKENS` | `8000` | provider 简报的 token 预算 |
| `COFORGE_WAKE_RECYCLE_MEMORY_TOKENS` | `4000` | `MEMORY.md` 段的 token 预算 |

除 sweep 周期外，Agent 自己的 runtime 环境变量覆盖 Daemon 的环境；空值在两级都视为未设置，无法解析的值回落为默认。
