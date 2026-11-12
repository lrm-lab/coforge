# 凭据失效 hold

对齐 Raft 1.0.67 的 `credentialInvalidHold`：Agent 的 provider 凭据已知不可用时，Daemon 保留进程、
不让 Agent 下线，只扣住要告诉它的内容，等凭据被人处理之后再呈现。

## 触发与范围

- 信号：回合中（含启动输入）runtime 的 `error` 事件，经 `runtime-error-classification.ts` 分类后
  `credentialInvalidReason`（`agent-runtime/credential-invalid.ts`）非空，即 `requiredAction` 为
  `user_reauth`/`user_model_access`，或 `BillingError`（余额耗尽，无已知恢复时间）。进程退出时的 stderr
  文案没有单独的信号：同样的文案出现时早已作为 `error` 事件记录，退出只是让 hold 进入下面的一小时关闭期。
- 动作（`runtime-event-observation.ts`）：`CredentialInvalidHolds.record` 记入账本并给 Agent 加
  `credential_invalid` 投递 hold，发布与下线路径相同的 `runtime_error` Activity。不发
  `agent:status(inactive)`，不结束进程，不计入 fingerprint fence。谁被 hold 以 `AgentDeliveryGate` 的
  显式 hold 为准（`credentialHeld`/`heldFor`），不另存一份；Agent 已被 fingerprint fence 持有时 fence 的 hold
  保留，该 Agent 不算被凭据 hold。
- 范围（`daemon-runtime/credential-invalid-ledger.ts`）：账本键为 `shared:<runtime>`（Agent 用 Computer 自己的
  登录：runtime 有登录流程、无自定义 provider、环境里没有重定向登录目录或密钥）或 `agent:<id>`。共享键上同一
  Workspace Daemon 里其余运行中的同键 Agent 一并被 hold，并在空闲时看到一条 `idle` 提示（带“Reported by
  another agent on the same sign-in.”）；缺 plan 的记录只对该模型生效。账本只在内存里，Daemon 重启后重新发现；
  不同 Workspace 的 Daemon 子进程各有各的账本。
- 启动时 `createAgentSession` 直接抛出的凭据类失败同样是 hold，不是下线（Raft 只在有进程时记凭据失效，
  且不把凭据文案当 sticky 终态失败）：`reportLaunchFailure` 记入账本、发同样的 Activity、上报 `inactive`，
  保留唤醒 config，并经 `AgentLifecycle.processClosed` 起一小时关闭期。关闭期到点的探测 launch 再次抛出，
  就再 hold 一小时，被保留的投递和 @mention 不丢。
- 不在此列：sticky 的 model not supported、没有重置时间的配额耗尽、fingerprint/404 fence 仍下线
  （[需要人处理的运行时错误](../activity-delivery-and-errors.md#需要人处理的运行时错误agent-下线)）。

## hold 期间

- 未跟踪投递：进 `AgentDeliveryGate` 并立即 ACK（与退避相同），不写 notice；busy 的 turn 结束时也不放行。
- tracked @mention：`MentionCarry` 保留给下一次 launch（`daemon_received`，不回 ACK、不回终态错误），
  重复投递沿用最新 envelope 并回 `coalesced`；判断先于 busy 与退避检查，所以活 turn 中到达的也被保留。
- 后续的可重试错误、输出、turn 结束都不放行 hold，也不叠加退避。
- 不再把它当作“工作中”：activity probe 不因积压的未读报告 working，stalled 判定不重启进程。
- 空闲判定（配置推送的空闲重启、冷空闲回收）不把它扣住的投递和被保留的 tracked @mention 算作未空闲。
  这两种停止之后不唤醒 Agent（`hasParkedWork` 不算它扣住的东西）。
- hold 在进程结束后继续。进程关闭时（崩溃、冷空闲、配置推送重启）`closed` 起一小时的计时：期间发给已关闭
  Agent 的投递只入队 ACK、tracked @mention 只保留，都不唤醒；到点后 hold 对该 Agent 解除、Daemon 为被保留的
  东西唤醒它，这次 launch 就是对凭据的一次探测（Raft 的关闭期到期同样“从待处理 inbox 启动”）。

## 释放

账本记录结束的原因（`CredentialReleaseCause`）就是释放原因，结束后每个仍被它 hold 的 Agent 恢复：运行中的
由 `flushSurvivingDeliveries` 把扣住的投递和 tracked @mention 在同一个 notice 里告诉一次，已关闭的被唤醒。

- `explicit_stop`：人或操作员的 Stop，以及 Agent 被删除（`AgentStopCoordinator.stopAgent` 发
  `AgentLifecycle.stopped`，进程还在时按它的 config 找键），Agent 自己的键和它所在的共享键都结束，其余同键
  Agent 随之恢复。Daemon 自己拆掉一次 launch（启动失败、启动输入失败，`releaseAgentRuntime`）不是 Stop，
  不释放任何记录。Agent 下线、被删除或换新 Session 时（`RuntimeErrorDeliveryHold.forget`）只丢掉它自己键的
  记录，不发 restored，共享键的记录不动。
- `model_output`：Agent 在记录之后才开始的 turn 里产生了模型输出（text/thinking/tool 开始；失败那个 turn 自己的
  输出不算，用 `ProviderProgress.turnStartedAtMs` 判断）。
- `model_changed`：配置推送换了模型（`AgentConfigApply` 更新 restart config 时）。Agent 自己的键上缺 plan 的
  记录结束；共享键上只让这个 Agent 不再被它 hold，记录留给其他 Agent。
- `credentials_changed`：Anvil 登录完成（`RuntimeAuthController.onSignedIn`），或凭据文件变化。
  `credential-disk-watch.ts` 只在有键已知失效时每 30 秒看一次：Claude Code（macOS 的 Keychain 项只读属性、
  不读密钥；`.credentials.json`）、Codex 和 Grok 的 `auth.json`（位置表与账本共用
  `provider-credentials.ts`）；环境里的密钥、自定义 provider、其余 runtime 不监视。文件 stat 没变就不读，
  Keychain 文件没变就不起 `security`，同一凭据同时只看一次；首次读数是基线，凭据存在且与基线不同才释放，
  登出（文件消失）不释放。

每个释放按被记录的 Agent 发一次 `agent:v1:credential:restored`（`reason`、`releaseCause`、有 launch 时的
`launchId`、`restoredAtMs`），包括记录的上报者、看到提示的 Agent 和被 Stop 的 Agent；发送失败只记日志，
不影响恢复。Web 收到后，只有该 Agent 最新的一条 Activity 正是这次失败的 `runtime_error`
（`runtimeError.errorReason` 对得上 `reason`：`CREDENTIAL_FAILURE_ERROR_REASONS`）才为它写一条自己 launch
的 `idle` 行，使 Activity 离开错误状态；Agent 已经有了新的 Activity、或最新的是别的错误，就什么也不写。
这一行的 `observedAtMs` 取 `restoredAtMs`（daemon 时钟，和 Agent 自己的 Activity 同一个时钟），且不早于它
所结束的那条错误，所以 Agent 随后的工作一定排在它后面
（`apps/web/src/server/agents/credential-restored-activity.server.ts`，写入与发布同 Computer 生命周期行共用
`self-launch-activity.server.ts`）。

云端显示（`apps/web/src/server/agents/agent-display-lua.ts`，task #90）：hold 期间进程活着，所以失败的
`runtime_error` 帧（`requiredAction` 有值，或 `errorClass` 为 `BillingError`，SDK 的 `credentialHoldReason`）记下
`stopHeld`，快照在 Agent 在线时也带上它的 `stopReason`，页面据此显示“需要人处理”的红字和警示图标，资料页
横幅提供 Retry（就是普通的 Start，不先 Stop）。同一进程的租约续期、结束失败那一轮的 `idle` /
`subagent_activity` 行和无内容的进度帧都不清除它；清除它的只有：新的进程（`active` 状态来自未在线的进程或别的
daemon 实例）、之后一轮的模型输出（working/thinking），以及 `agent:v1:credential:restored`
（`END_HELD_STOP`，只结束这次失败对应的 reason，并把错误行从显示上撤掉）。

## 模块（`packages/daemon/src/daemon-runtime/`）

- `credential-invalid-ledger.ts`：哪些键已知失效、各 Agent 看到过什么；释放时通知订阅者。
- `credential-invalid-holds.ts`：账本之上的 hold 策略（上面的触发、范围、释放）；`assemble-credential-holds.ts`
  把它接到 runtime 的协作者，并拥有 `credential-disk-watch.ts`。
- `provider-credentials.ts`：各 runtime 登录放在哪里、什么环境变量会让它离开 Computer 的登录。
- `agent-lifecycle.ts`：Agent 生命周期里多个模块关心的事件（`stopped`、`processClosed`），发出的模块
  不需要知道谁在听。
