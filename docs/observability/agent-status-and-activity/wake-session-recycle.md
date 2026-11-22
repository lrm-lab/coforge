# 冷空闲回收

与参考客户端的 `wakeSessionRecycle` 一致，默认开启。空闲超过该运行时的 prompt cache 寿命，且最近一次上下文超过阈值（默认 128k token）的 native session 不再恢复：恢复会按全价重读整个上下文。冷却间隔由 provider 声明：Claude Code 60 分钟，Codex 30 分钟（OpenAI 默认缓存至少 30 分钟；CoForge 直接读取 Codex rollout），未声明的 provider 仍是 60 分钟。当 Claude transcript 报出 `5m` prompt-cache 档位时，冷却间隔缩短为 12 分钟；已知缓存档位（`5m` / `1h`）且空闲超过完整冷却间隔（60 分钟）时，上下文阈值进一步降至 64k token。支持 `readSessionResumeFacts` 或 `supportsSessionSummaryRecycle`（Claude Code、Codex、Pi、CoForge、Grok、OpenCode、Antigravity；后者读取 Daemon 持久化的 `sessionSummary`，Codex 在 rollout 缺失时亦回退）的 provider 会被回收；缺失任一事实时一律恢复。

- **停止**：`daemon-runtime/cold-idle-sweep.ts` 每个 sweep 周期（默认 10 分钟）检查一次运行中的 Agent。Daemon 自身状态的每个空闲条件都成立（没有 live turn、排队投递或输入、未结算 mention、未结束的工具调用、后台 task、launch、stop、卡住重启、runner hold 或迁移），且 runtime 最近事件和 session 自身记录都早于冷却间隔时，结束进程，不报 stopped/crashed，Agent 保持 `active`。停止前上报一条 info 级 `idle`：“Stopped idle <Runtime> runtime (idle Nm, ~Xk context) to free memory; it restarts on the next message”。停止期间到达的消息和 app-item 通知留给随后的 launch；进程不肯退出时报 error 级 `runtime_error`（“Stopping the idle <Runtime> runtime failed”），留下的消息交还给仍在运行的进程。
- **唤醒**：下一条消息照常走已退出 Agent 的唤醒路径。launch 注册之后才读取 session 事实并决定是否恢复（`daemon-runtime/wake-recycle.ts`）。回收时不带 session id 启动，session 上报以 `replacedSessionId` 携带旧 id（不发 `agent:session:invalidate`），新 session 上报前保留旧引用，因此 launch 失败时下次仍用旧 id。launch 的第一条输入是简报：`MEMORY.md` 与 `notes/active-context.md` 的开头（各自份额内，不跟随符号链接）加 provider 从旧 transcript 整理出的近况；简报建不出来时仍以空白新 session 启动。带 `resumePrompt` 或以 `create` 方式启动的 launch 不回收。

| 日志事件                               | 级别       | 含义                                                                                                                                                       |
| -------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.runtime.cold_idle_sweep`        | info       | 一次 sweep 的汇总：`agents`、`stops`，以及按原因计数的 `skipped_<reason>`                                                                                  |
| `agent.runtime.cold_idle_sweep_failed` | warn       | sweep 本身失败                                                                                                                                             |
| `agent.runtime.cold_idle_stop`         | info       | 停止一个冷空闲 runtime：`session_id`、`idle_ms`、`prior_context_tokens`                                                                                    |
| `agent.runtime.cold_idle_stop_failed`  | warn/error | 停止失败；进程未退出时带 `still_running`                                                                                                                   |
| `agent.runtime.cold_idle_wake_failed`  | error      | 停止期间有消息到达，随后的唤醒失败                                                                                                                         |
| `agent.runtime.wake_recycle`           | info       | 唤醒时的决定：`outcome=resume`（带 `reason`）或 `outcome=recycle`（带 `prior_session_id`、`idle_ms`、`prior_context_tokens`、可选 `cache_tier`、是否有简报） |
| `agent.runtime.wake_recycle_failed`    | warn       | 决定过程出错，按恢复处理                                                                                                                                   |
| `agent.runtime.wake_briefing_failed`   | warn       | provider 简报建不出来，以不带它的新 session 启动                                                                                                           |
| `agent.runtime.session_memory`         | info       | 一个 fresh session 的首条输入带上了 `MEMORY.md`/`active-context` 段（`has_memory_block`）                                                                  |

| 环境变量                                            | 默认                          | 含义                                                                                    |
| --------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| `COFORGE_WAKE_RECYCLE`                              | 开                            | `0`、`false`、`off` 关闭回收；空值视为未设置                                            |
| `COFORGE_WAKE_RECYCLE_MIN_CONTEXT_TOKENS`           | `128000`                      | 上下文阈值                                                                              |
| `COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS`              | provider 声明，否则 `3600000` | 冷却间隔。覆盖 provider 的声明。Codex 声明 `1800000`，Claude Code 声明 `3600000`        |
| `COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_5M_TIER_MS`      | `720000`（12 分钟）           | Claude transcript 报出 `5m` prompt-cache 档位时使用的冷却间隔（取与主冷却间隔的较小值） |
| `COFORGE_WAKE_RECYCLE_MIN_CONTEXT_TOKENS_PAST_TIER` | `64000`                       | 已知缓存档位的会话空闲超过完整冷却间隔后降低的上下文阈值（取与主上下文阈值的较小值）    |
| `COFORGE_WAKE_RECYCLE_SWEEP_MS`                     | `600000`                      | sweep 周期；只读 Daemon 自身环境                                                        |
| `COFORGE_WAKE_RECYCLE_PANEL_TOKENS`                 | `8000`                        | provider 简报的 token 预算                                                              |

这两段的 token 预算不属于回收：每个 fresh session（首次启动、provider 丢失 session 后的重建、`create`）和每次上下文压缩完成后都按同样的份额注入——`MEMORY.md` 3000 token（`STARTUP_MEMORY_BUDGET_TOKENS`）、`notes/active-context.md` 1000 token（`STARTUP_ACTIVE_CONTEXT_BUDGET_TOKENS`），两份份额不互相借。

除 sweep 周期外，Agent 自己的 runtime 环境变量覆盖 Daemon 的环境，两者都覆盖 provider 声明的冷却间隔；空值在两级都视为未设置，无法解析的值回落为默认。
