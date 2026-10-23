# 忙碌心跳与 liveness sweep

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
