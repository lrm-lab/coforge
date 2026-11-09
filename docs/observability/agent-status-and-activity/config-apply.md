# Agent 配置推送

云端保存 Agent 的 runtime 配置后推送 `AgentConfigSync`（每个 Agent 单调递增的 `revision`；capability `agent-config:v1`），Daemon 在该 Agent 下一次空闲时应用，不打断正在进行的 turn（`daemon-runtime/agent-config-apply.ts`）。

- **排序**：Daemon 记住每个 Agent 已持有的最高 revision（推送过的，或 Start 启动时携带的 `agentConfigRevision`）。不大于它的推送丢弃（`outcome=stale`）。Daemon 在 ready 请求的 `appliedAgentConfigs` 里按 Agent 上报这个 revision（只报运行中的），服务端只对已存储 revision 更高（缺项按 0）的 Agent 重新推送。接受的更新推送一律在空闲时重启，哪怕字段与运行中的相同：环境变量和 runtime 凭据只在 launch 时重新读取。Start 真正启动进程（只是加入进行中的 launch 不算）且其 revision 不小于待应用的推送时取消待应用；Stop 也取消。
- **provider**：推送的 provider 与 Agent 的 restart config 或存活 runtime 的 provider 不同时丢弃，不做任何进程操作（`provider_mismatch`，不占用 revision）。换 provider 仍是 Stop 再 Start，因为控制 scope 绑定 provider。
- **无存活 runtime**：直接替换 restart config 的 runtime 字段，不动进程（`applied`）；连 restart config 也没有则无可更新（`no_restart_config`），服务端下一次 Start 自带配置。
- **有存活 runtime**：立即更新 restart config 并记为待应用（`pending`）；Agent 按冷空闲回收的同一组守卫（去掉“静默超过冷却间隔”和“上下文超过阈值”两个冷条件）判定空闲后，经 `RuntimeRelease.stopForConfigApply` 结束进程（`idle_stop`），Agent 保持 `active`，下一条消息走已退出 Agent 的唤醒路径，用新配置恢复同一 session。
- **触发**：接受推送时、turn 结束使 Agent 空闲时，以及只在有待应用时才存在的 5 秒重试计时器（后台 task 结束没有 turn 结束）。没有待应用就没有计时器。
- 尚未上报 session 的 Agent 不会被停止（停止后无法恢复）。Memory Agent 永远不会被这条路径停止：更新 restart config、记下 revision、记 `memory_agent`，不留待应用也不起计时器，经任何途径到达的推送（含 ready 补发）都一样。
- 停止前再写一次 restart config：等待期间完成的 launch 会用它自己的旧配置覆盖 restart config。待应用记着接受时遇到的 launch（进行中或存活）；`settle` 发现另一个在接受之后才开始的 launch（例如 Daemon 自己的唤醒，它读的是已更新的 restart config）时，以 `applied` 结束待应用而不再停止。接受时已在进行的 launch 用的是旧配置，仍要重启。
- 空闲停止失败时释放该 Agent 的已持有 revision，下一次 ready 不再把它报为已应用，服务端会重新推送。

- **凭据是例外**：runtime 凭据的保存或删除仍然立即 Stop、写入、Start，不走本推送，因为被泄露或轮换的密钥不能在 Agent 一直忙时继续被使用。删除时未存储密钥则什么都没有变，不重启，结果 `not-required`。
- 待应用记着接受时遇到的 launch；Start 以更低 revision 或不带 revision 启动进程时，那次 launch 用的是旧字段，待应用保持挂起（不再被“接受之后才开始的 launch”结束）。
日志事件：

- `agent.runtime.config_push`（info）：一次推送的结局，`outcome` 为 `applied`、`stale`、`pending`、`idle_stop`、`no_restart_config`、`provider_mismatch`、`memory_agent`、`cancelled`（带 `reason`：`start` 或 `stop`）或 `stop_failed`；带 `agent_id`、`config_revision`，从不含模型、provider 配置、环境变量或凭据。
- `agent_runtime:config_push_failed`（warn）：处理推送时抛错。
- `agent.runtime.config_apply_stop_failed`（error）：进程不肯退出，带 `still_running`；`agent.runtime.config_apply_wake_failed`（error）：停止期间有消息到达，随后的唤醒失败。
