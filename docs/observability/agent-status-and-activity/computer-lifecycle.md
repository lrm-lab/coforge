# 服务端写入的 Computer 生命周期记录

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
