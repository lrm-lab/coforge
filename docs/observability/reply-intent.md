# 即将发言信号（reply intent）

Agent 即将在某个会话里发言时，输入框上方显示“某某正在输入…”，发在线程里时频道消息流的根消息下还显示“某某正在回复”（界面文案是“正在输入”，代码里叫 reply intent / replying）。这个信号是 best-effort 观察：Daemon 不等待、不重试、不落盘，丢一帧只会让提示晚出现或到期自行消失。设计参考了参考产品的行为，实现和命名是 CoForge 自己的。

信号的去向取决于目标：

- 频道：服务端将 `start`、`end` 都定向发布到 `chat:<conversation_id>`；仅当前打开该会话且通过读取授权的浏览器订阅接收。线程复用所属会话的订阅；
- 私信（目标是人，`@user[:thread]`）：**不进任何 Agent Activity 通道**。共享通道上每个 Workspace 成员都收得到，会泄露这场私信的存在、会话 id 和时间。服务端改为只发布到该私信对方本人的 `chat:user:<user_id>`，并丢弃 Daemon 的原发布。

## 线上格式（additive，`protocol_major` 仍为 1）

`AgentActivity.reply_intent`（字段 24，`ReplyIntent`）：

| 字段 | 语义 |
| --- | --- |
| `phase` | `start` 或 `end` |
| `call_id` | 触发它的工具调用 id；`start` 会重复，`end` 指向它 |
| `target` | 仅 Daemon→服务端：Agent 传给 `coforge message send --target` 的原始目标（`#channel`、`@user`、`#channel:thread`）；`end` 重复它，服务端据此把 `end` 送到 `start` 去的地方 |
| `early` | 目标在工具参数流式输出完成前就已知（仅 `start`，Daemon 置位；见下方“提前信号”）。参考产品有同名字段，且便于诊断“提前”命中率，所以保留 |
| `conversation_id`、`thread_root_id` | 仅服务端→浏览器：服务端解析出的会话与线程根（顶层发言为空） |

带 `reply_intent` 的帧**不是** Activity 观察：不带 `launch_id` 与 `client_seq`，所以不认识它的旧读取方会按无效 Activity 拒绝它。编解码在 `packages/coforge-sdk/src/internal/reply-intent.ts`：`encodeAgentReplyIntent`；`decodeAgentActivityFrame` 把一帧只解析一次，返回 `{ replyIntent }` 或 `{ activity }`（服务端与浏览器都用它）；`isReplyIntentTarget` 是 `target` 的唯一限制（非空、至多 200 个码点）；`call_id` 用 `isActivityCallId`。

## Daemon

`daemon-runtime/reply-intent-tracker.ts` 按 launch 观察 provider 无关的运行时事件，`reply-intent-publisher.ts`（在 `runtime.ts` 里构造）负责发布。`code-agent/send-command-target.ts` 的 `sendMessageTarget` 判断一次工具调用是否是 Agent 自己运行的 `coforge message send`，并从调用本身的参数里取出原始 `--target`（不是展示行里被截断、被折叠空白的那份）；子 Agent 的调用、`--help`/`-h`、没有目标或目标超限的调用都不算。`tool-activity.ts` 只负责展示。

- 提前信号或 `tool-start`（先到者）立即发 `start`，之后每 8 秒（`REPLY_INTENT_REFRESH_MS`）重发；每个 tracker 只有一个定时器，仅在有调用存活时运行；
- 工具调用结束、本回合 `completed`、launch 退出或已持续 2 分钟（`REPLY_INTENT_MAX_MS`）时发 `end`，`end` 重复该调用的 `target`；
- 每个 Agent 同时最多 4 个（`REPLY_INTENT_MAX_LIVE_PER_AGENT`）；
- 以真实的 `tool-start` 为准：提前命中的调用在 `tool-start` 时若没有目标（如 `--help`）则结束，若目标不同（如后面又出现一个 `--target`）则结束并以真实目标重新开始；
- 模型放弃了提前命中的调用（Claude `message_start`、Pi `turn_start` 时仍未完成参数）：adapter 发 `reply-intent-retracted`，tracker 结束其中还没有 `tool-start` 的调用；
- 断线时直接丢弃，不缓冲；`start` 需要运行中的 runtime、Agent 当前 launch 且 launch 不在停止中，`end` 只做收尾，永远发出。

### 提前信号

模型要写完整个工具调用（含很长的消息正文）后才会有 `tool-start`，提示只会闪现一秒。所以在 provider 仍在流式输出工具参数时，adapter 就把 shell 工具调用的参数片段（调用 id、JSON 片段）交给 provider 无关的 `code-agent/reply-intent-scanner.ts`：

- adapter 只把 shell 类工具（`isShellToolName`）的调用交给它；最多同时跟踪 16 个调用（淘汰最旧的）；
- 累计参数文本超过 8 KiB 即放弃该调用（唯一的上限）；增量解析 `command` 的字符串值（`streamed-json-string-field.ts`，处理转义，包括被拆在两个片段之间的 `\uXXXX`），只读顶层字段；
- 命令文本里还没有 `coforge` 时不解析；之后每出现 shell token 边界（空白、引号、`| ; & < > ( )`）或字符串写完时，用 `sendCommandTarget(command, "partial")` 判断：已闭合的 token 里是否是 Agent 自己的 `coforge message send --target …`（`shellSegments` 的 partial 模式丢弃末尾可能还在增长的 token：`--target @bo`、未闭合或刚闭合的引号）。命令里出现换行或 heredoc 而其前没有 `coforge`，或字符串写完仍没有命中，则放弃该调用；
- 第一次命中就产出一个 `reply-intent` 事件（`id`、`target`），之后不再扫描该调用。Tracker 以 `early=true` 立即开始。没有提前命中的调用，仍由 `tool-start` 以 `early=false` 开始；
- 回合开始、`tool_use`/`toolcall` 结束时释放对应状态；回合开始时仍未完成的已命中调用被撤回（`reset()` 返回它们）。

哪些 adapter 有流式参数：

| adapter | 是否流式参数 | 接入 |
| --- | --- | --- |
| Claude Code | 是（`--include-partial-messages` 已开启：`stream_event` 的 `content_block_start`（tool_use 的 id 与名称）+ `input_json_delta`，按 block index 对应） | `claude-code/stream-events.ts` 的 `ClaudeStreamEvents` |
| Pi（含内置 CoForge Agent） | 是（`toolcall_delta`，调用 id 与名称在 `partial.content[contentIndex]`） | `pi/reply-intents.ts` 的 `PiReplyIntents` |
| Codex、Cursor、OpenCode、Grok、Kiro、Antigravity | 否：adapter 与其夹具里没有参数片段，只在调用开始或完成时给出完整参数 | 只有 `tool-start` 路径 |

## 服务端

发布代理（`agent-activity-publish.server.ts`）把每帧只解码一次；带 `reply_intent` 的交给 `reply-intent-publish.server.ts`。两者共用 `agent-activity-relay.server.ts` 的范围校验（Workspace、Computer、Agent 归属）；reply intent 另行定向发布，不再走 Activity 中继。

- 目标由 `PrismaDirectConversationRepository.resolveAgentReplyTarget` 解析：发送路径同一套语法（`#channel[:thread]`、`@user[:thread]`）和检查（App 事件会话只读、Workspace assistant 的私信不解析、私信对方须在 Workspace 内），但只读：Agent 与该用户尚无私信时不解析，也不创建私信。解析不出的帧被拒绝（Centrifugo 只丢这一次发布）。结果按 Workspace、Agent、调用、目标缓存（`reply-target-cache.server.ts`，最多 512 条）：每次命中刷新 30 秒空闲期限，8 秒一次的重发让长调用的 `end` 仍能命中；不是持久映射；
- 频道的 `start` 与 `end` 都解析同一目标，只向 `chat:<conversation_id>` 发布一次，并丢弃原 Activity 发布。`skip_history` 禁止保存、恢复重放；解析不到的 `end` 丢弃并记录不含原始目标的调试事件；
- 私信的 `start` 与 `end` 都解析目标，只发布到对方本人的 `chat:user:<user_id>`（`skip_history`，重订阅恢复不重放），再答复发布代理丢弃原发布；永远不进 Activity 通道；
- 转发的 `start` 只带 `phase`、`call_id`、`early`、`conversation_id`、`thread_root_id`；转发的 `end` 只有 `phase` 与 `call_id`，Daemon 发来的其余字段一律不转发；不入库，不改变 Agent display。

## 浏览器

`features/agents/reply-intents.ts` 的 store 以 `(agent, call)` 为键：`start` 设 20 秒截止（重发刷新），`end` 或该 Agent 在同一位置的消息到达则移除，并记住已结束的调用 1 分钟，防止迟到的 `start` 复活。Activity 读取方忽略 reply intent。会话窗格的 `ReplyingAgentsLine` 通过 `useConversationReplyIntents` 从 `chat:<conversation_id>` 喂入；消息读取与提示共用 `browser-realtime.tsx` 的引用计数订阅池，同一连接同一频道只有一个真实订阅。关闭最后一个提示读取方清空该会话的存活条目，不影响别的会话；带订阅会话范围的 `end` 只能清除本会话调用。私信的帧由 `useUserChannelReplyIntents`（`reply-intents-realtime.ts`）从本人的 `chat:user:<id>` 订阅（与其他功能共用同一个订阅）喂入；会话恢复订阅时清空该会话提示，下一次 `start` 最迟约 8 秒后恢复；提示不重放。切换 Workspace 时清空全部。

Agent 消息到达时的清除：会话的消息进入缓存的地方（`useConversationQuery` 的 `mergeUpdates`，realtime 和之后的补读都经过这里）对每条 Agent 消息调用 store 的 `agentPosted`（`agent-post-clearing.ts`），不管这个位置有没有界面在显示。每条新消息只清除该 Agent 在该位置最早的一个条目，并记住已结束的调用；同一条消息再到一次、或者 1 分钟前的旧消息被补读进来，都不再清除。消息比 start 先到时，它占住该 Agent 在该位置一个刷新周期（8 秒）内的下一个新 start：那是发出这条消息的调用迟到的 start，不显示，之后的重发也不显示。主窗格只显示顶层（`thread_root_id` 为空）的条目，线程窗格按根显示，消息流里每条根消息下显示它线程的条目。设置里的“实时 Agent 动态”关掉后，这些提示和聊天列表顶栏的忙碌 Agent 都不显示。


## 授权与开销

会话订阅沿用 `getConversationRealtimeToken` → `authorizeConversationRealtime`：普通频道对本 Workspace 成员可读，退出频道不撤销读取；非参与者私信、隐藏会话、其他 Workspace 不授权。订阅 JWT 绑定用户与频道，5 分钟有效，续期时重新检查权限。当前版本不保证活跃订阅即时撤销，最长续期窗口仍存在；跨聊天流的主动撤销属于独立任务 #183。

只有实际挂载的会话窗格订阅提示，不订阅侧栏所有频道，不增加 WebSocket。设提示频率为 F，原分发约为 F × Workspace 订阅者，新分发约为 F × 该会话已打开订阅者；这只是提示分发模型，不是总流量测量。公开 Agent 的频道提示新增一次服务端 Publish HTTP 请求（沿用 5 秒请求上限），不增加按成员查询、逐人 fanout 或队列。关闭设备的“实时 Agent 动态”会清空并停止读取提示；消息订阅继续工作。
