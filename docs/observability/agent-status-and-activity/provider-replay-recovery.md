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
  （恢复型 launch 会丢弃排队的投递，所以必须由汇总覆盖）。读 `check` 时已经在排队的投递已在待读计数里，
  不再按暂存重复计数；被交还 server 的也不计。没有待读时走普通启动输入。
- **tracked @mention 不重复告知**：结束 runtime 时 `RuntimeRelease` 把未结算的 tracked @mention
  交还 server（`IDENTITY_UNKNOWN`），server 会为新 session 重发。这些 mention 不计入 `unreadSummary`，
  否则新 session 会被告知两次；已 drain 的（turn 内被告知、turn 结束时已 ACK）server 不会重发，照常计入。
  判断由 tracker 给出：交还的投递 id（交还的 `IDENTITY_UNKNOWN` 报告确实发出了的）即“server 会重发”
  的集合；报告没发出的、待读窗口里看不出是 tracked 的、tracker 已忘记的、窗口之外的，一律计入，
  宁可重复告知也不丢。
- **启动输入**：被拒的 launch 启动时带的东西（server Start 的 `unreadSummary`/`resumeMessages`/
  `wakeMessage`、`resumePrompt`、`introductionPrompt`）随冷启动一起带给新 session；Start 的汇总式
  target 从不在 `check` 里（只有恢复出来的消息在），与上面的未读计数不重叠，相加成同一份 `unreadSummary`。
- **退避**：失败本身按错误分类可能给投递加退避（带 HTTP 状态的属 provider API 类，turn 结束不会解除）；
  该退避属于已结束的进程，新 session 启动前随之清除（同 take-offline）。
- **失败**：runtime 在时限内不退出时保留原 session，记 `agent.runtime.replay_rejected_restart_failed`
  （error），不发 invalidate。
- **欠着，直到告知成功**：冷启动要交给新 session 的内容（上面的 `unreadSummary`、被拒 launch 的
  Start 输入）记在该 Agent 名下（`OwedRecovery`，内存），而不只随冷启动那一次 launch 走。Agent 的
  下一次 launch（唤醒、重试或 Start）在会起进程的路径上（`agent-start-coordinator.ts`）把它并进自己的
  恢复内容，并在该 launch 的输入送达之后才销账；冷启动 launch 本身失败、进程没起来、恢复通知被
  拒，内容都仍然欠着。并入规则：launch 自己的字段优先；`resumeMessages` 是 launch 自己的加上欠着的里
  `deliveryId` 不重复的；`unreadSummary` 同一 target 取较大的计数，
  不相加（server Start 的汇总与这份可能描述同一批未读）；冷启动之后才到、留给下次 launch 的排队投递
  另计入（恢复型 launch 会丢弃它们）。只有三件事会丢掉它：AgentControl 接受的人的 Stop（过了各项围栏、结束进程之前；
  过期或被拒的 Stop 不算；无 epoch 的非托管 Stop 在停完之后）、Agent 被删除、整个 runtime 停止
  （`AgentLaunchCoordinator.clearOwedRecovery`）；失败 launch 之后 AgentControl 做的清理性 stop 不算。Daemon 重启后欠账随内存消失，
  未读消息由云端的已读边界在下一次 Start 或唤醒时再告知。
- **App Inbox**：session 因此被替换时，该 Agent 已告知过的 App Inbox 条目一并忘记
  （`AgentInboxCoordinator.forgetAnnouncedAppItems`），新 launch 的 `drainAppInboxNotices` 重新告知。
  普通重启和其他 session 变化不清这份记录。
