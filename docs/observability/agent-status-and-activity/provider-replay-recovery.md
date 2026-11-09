# Provider 拒绝 replay（provider_replay_rejected）

已存的 Codex thread 带着加密的 reasoning；换了 backend 或 key（`~/.codex/config.toml` 的自定义
`model_provider`、Agent 环境变量里换了 API key、网关）后，下一个 turn 会被 API 以
`invalid_encrypted_content` 拒绝（openai/codex#17541），此后每个 turn 都一样失败。云端看不到这些，
所以不预判，只在真失败时恢复。

- **判定**：Codex 适配器在失败 turn 的 `error` 事件上写 `sessionRecovery:
  "provider_replay_rejected"`。Codex 的 `TurnError` 是 `{ message, codexErrorInfo,
  additionalDetails, misalignment }`，没有 `code` 字段（app-server schema，0.167.0）；API 的原文在
  `message` 或 `additionalDetails`。条件只有：这两处之一含 `invalid_encrypted_content`，或同一段
  文本同时含 `encrypted content` 与 `could not be decrypted or parsed`（不分大小写），或（若某个
  版本带了）`code` 等于 `invalid_encrypted_content`。单独的 `could not be decrypted or parsed`
  不算（网关会对别的头部报同样的话）。更高层不解析 provider 文本。
- **触发**（`daemon-runtime/provider-replay-recovery.ts`）：仅当本次 launch 恢复了一个已存
  session（create、recycle、被 provider 替换过、上报的 session id 与请求的不同的都不算；Memory
  Agent 不适用），并在该失败 turn 结束后；每个 launch 成功恢复至多一次，新 session 即使同样失败也
  不会再触发。恢复没有进行（runner hold、迁移、仍有后台任务、runtime 不退出、已有 Stop 或更新的
  launch 接管）时不消耗，也不动 runtime，下一个被拒的 turn 仍会触发；runtime 不退出时保留该
  launch 的卡住判定。失败 turn 照常发自己的
  `runtime_error` Activity。
- **恢复**：Daemon 结束该 runtime（不发 stopped/crashed），发 `agent:session:invalidate`（reason
  `provider_replay_rejected`），再以 `sessionMode: "create"`、无 session id 冷启动，走与
  [恢复后秒崩](runtime-lifecycle.md#恢复后秒崩resumed-early-crash)相同的通道。Activity 沿用
  `runtime_unavailable` 文案：“Stored <Runtime> session <id> replay rejected; cold-starting a new
  session…”。
- **消息不丢**：消息通知被 ACK 后，daemon 唯一的痕迹是内存里的待读计数（Agent 用 `check`/`read`
  读过才清）。结束 runtime 前按 `check` 的待读计数取 `unreadSummary`，作为新 launch 的恢复内容，
  与 server Start 的汇总式恢复同一条通道：新 session 被告知哪些会话有未读，并自己 `read --unread`。
  runtime 退出期间到达的消息由 `RuntimeRelease` 暂存，随后取出并计入同一个 `unreadSummary`
  （恢复型 launch 会丢弃排队的投递，所以必须由汇总覆盖）。没有待读时走普通启动输入。
- **启动输入**：被拒的 launch 启动时带的东西（server Start 的 `unreadSummary`/`resumeMessages`/
  `wakeMessage`、`resumePrompt`、`introductionPrompt`）随冷启动一起带给新 session；Start 的汇总式
  target 与上面的未读计数相加成同一份 `unreadSummary`。
- **退避**：失败本身按错误分类可能给投递加退避（带 HTTP 状态的属 provider API 类，turn 结束不会解除）；
  该退避属于已结束的进程，新 session 启动前随之清除（同 take-offline）。
- **已知重复**：turn 内被告知的 tracked @mention 在 turn 结束时已被 drain，server 不会重发；它仍在
  待读计数里，因此新 session 会被告知一次。无法在不新增状态的前提下排除（待读记录分不清已 drain
  与未结算），宁可重复告知。
- **失败**：runtime 在时限内不退出时保留原 session，记 `agent.runtime.replay_rejected_restart_failed`
  （error），不发 invalidate。
- **已知缺口**：session 已被 invalidate 之后冷启动 launch 本身失败（双重故障）时，上面这份汇总随
  失败的 launch 丢失；消息在云端仍是未读，下一次 Start 或唤醒会通过 server 的恢复内容再告知。
  App Inbox 条目若只告知过已结束的进程，新 session 不会重新告知（`#notifiedAppItems` 没有按 Agent
  清除的现成入口，其他重启路径同样如此）。
