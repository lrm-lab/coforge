# 卡住 turn 的可见 notice：两条窗口、只认工作量

一个 busy 的 turn 长时间没有任何进展时，Daemon 发布一条 error 级 Activity，页面上就是「Agent 似乎
卡住了 / 停止本轮」。判定在 `packages/daemon/src/daemon-runtime/stalled-turn-indicator.ts`，轨迹见
[runtime-lifecycle](./runtime-lifecycle.md)。

## 两条窗口

- **tool**（默认 10 分钟，`COFORGE_STALLED_TURN_SILENCE_MS`）：turn 里还有工具调用没结束，例如一条
  跑着的 `sleep 900` 或构建。这条线要短，因为工具在跑本来就该有输出。
- **model**（默认 20 分钟，`COFORGE_STALLED_TURN_MODEL_SILENCE_MS`）：没有工具打开，等的是模型自己
  的下一段输出。这条线要长，因为它跟健康的 turn 在页面上长得一样，而大上下文推理本来就慢。

任一变量配成 `0` 就关掉那条窗口；两条都关掉时每个 turn 会写一行 `turn_stalled_disabled`，否则
「没在看」和「看着没到点」在日志里没法区分。

## 只认工作量

计时起点是**最近一次工作量事件**与**最早未结束工具的开始时刻**中较新的那个。工作量事件指 turn 真
的做了什么：模型输出、工具开始/输出/结束、子代理进度、阶段边界。turn 的记账不算：

- `session`（session 身份，包括 `hasLiveTurn` 为 false 的那几帧）
- `usage`、`context-usage`（计划用量与上下文读数）
- `service-tier`（Fast 状态）

这几类事件既不重置窗口，也不结束 turn。原因是实测到的 Codex 行为（task #41，s144 0.1.30-dev.2）：
一条 `sleep 900` 跑到一半时 provider 照发 `context-usage`，并在 turn 已接受之后仍可能发一帧
`hasLiveTurn` 为 false 的 `session`。把前者当进展，窗口被无限顺延；把后者当结束，正在跑的命令再没人
看着——两种情况都在真实机器上让 10 分钟窗口一次都没响。

## 诊断行

都在 `coforge.daemon.runtime` logger、`agent_runtime:` 前缀下（字段约定见
[local-logging](../../local-logging.md)）：

- `turn_stalled_armed`（info）：本 turn 的计时第一次起算。带 `stalled_window`、`threshold_ms`、
  `silence_started_at`（毫秒时间戳）、`fires_in_ms`。
- `turn_stalled_rearmed`（debug）：起点被后一个工作量事件顺延，带 `previous_started_at`。
- `turn_stalled_finished`（info）：计时被取消，带 `reason`：`event:<type>`、
  `turn_idle_reconciled`、`turn_interrupted`、`new_turn`、`disposed`。
- `turn_stalled`（warning）：判定成立。带 `stalled_window`、`threshold_ms`、`silent_for_ms`、
  `last_event_at`，有工具时另加 `open_tool` 与 `open_tool_for_ms`。
- `turn_stalled_dropped`（info）：到期了但 launch 已不是当前或正在停止。
- `turn_stalled_publish_failed`（error）：判定行已写、Activity 发布失败。

判定行先于 Activity 发布：页面没更新不该成为日志沉默的理由。
