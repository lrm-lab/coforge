# 群聊记忆

coforge 群聊写进 OpenViking 时用的说法。工具调用和频道正文在同一条长期会话里，不按安静窗口另开会话。

## Language

**Tool part**:
助手一轮里的一次工具调用记录，带调用身份、工具名、输入、输出和状态，挂在该轮助手消息上。
_Avoid_: 轨迹, Influence Block, AO 记录, Memory fence tool

**Memory fence tool**:
Memory Agent 围栏上的 `ov_find`、`ov_search_context`、`ov_read`、`memory_offer`。它们不是 tool part。Memory Offer 的频道消息仍以切开后的结论进入 Conversation session。
_Avoid_: shell, tool part

**Channel tool**:
读或发送频道消息的动作。包括 `message_check`、`message_read`、`send_channel_message`，以及 shell 里的 `coforge message check`、`read`、`search`、`send`。它们不是 tool part。
_Avoid_: kubectl, 不读不发频道消息的 shell

**Message target**:
PublicChannel 里的一个写入目的地：主时间线，或挂在某条顶层消息上的 Thread。
_Avoid_: PublicChannel, Workspace, Agent session

**Conversation session**:
一个 Message target 在 OpenViking 里持续追加的会话。PublicChannel 的主时间线是一条；每个 Thread 另是一条。同一条里有这个 target 的用户消息，以及在这里发言的 Agent 的助手消息（含 tool part）。DirectConversation 不进 Conversation session。
_Avoid_: Admitted Segment, 安静窗口会话, 每个 Agent 一条 session, 整个 PublicChannel 一条, 整个 Workspace 一条

**Turn report**:
一次唤醒结束时 daemon 交给 web 的载荷，含频道消息 id 和对应的 tool part。写入之前它在这个 Agent workspace 里：daemon 重启后继续交，Full Reset 则和 jsonl 一起删掉。它不是整份 jsonl。
_Avoid_: OpenViking resource, Agent session

**Turn**:
一次唤醒，从投递到这次运行结束。每一句进入 Conversation session 的正文是一条助手消息，只带上一句这种正文之后、这句之前的 tool part。私聊发送和系统消息不入库，也不把工具步骤截走。
_Avoid_: Conversation session, Agent session, Admitted Segment

**Session order**:
一条 Conversation session 的活列表按频道时间排。更早的 Turn report 尚未写入时，更晚的消息先不进入这条活列表。
_Avoid_: 到达顺序

**Written message**:
一条已经进入 Conversation session 的 Message。再次写入不会增加第二份，也不会往已有的那份上补 tool part。
_Avoid_: 重试再追加

**Agent peer**:
Conversation session 里一个 Agent 的发言身份，写成 `coforge__` 加上该 Agent 的 handle。多个 Agent 可以在同一条 Conversation session 里。
_Avoid_: 每个 Agent 一条 session, Task session, Memory session, Human peer

**Human peer**:
Conversation session 里一个 User 的发言身份，写成 `coforge__user__` 加上该 User 不可改的 username。
_Avoid_: Agent peer, 不带 peer 的 user 消息

**System message**:
频道里不归属 User、也不归属 Agent 的通知，例如任务认领、指派和提醒。它不进入 Conversation session。
_Avoid_: User 消息, Agent 消息, tool part

**Shared recall**:
查找范围是这个 Workspace 所绑定的那一个 OpenViking user 下的公共记忆和全部 peer。另一个 Workspace 是另一份绑定。这个 Workspace 里的各个 Message target 互相可见。
_Avoid_: 只查当前发送者, 跨 Workspace

**Admitted Segment**:
不再写入 OpenViking 的旧收口。它曾把一个 PublicChannel 里的主时间线和 Thread 混成一段，在 Task 标成完成或频道安静满 15 分钟时收口。
_Avoid_: Conversation session, Thread, 工具轨迹

**Interaction link**:
从 PublicChannel 消息抽出的结构化协作事实：谁提到谁、谁回复哪条根消息、任务派给了谁。消息落进频道时就写，不等 Memory Episode。系统通知不进 Conversation session，但 `delegates_to` 仍写。
_Avoid_: Memory Episode, Session commit, 语义猜测

**Memory Insight**:
已有的规则，证据仍是过去的 Memory Episode。这条频道不再产生新的 Memory Insight，也不再以新频道内容提出新的 Skill Proposal。已有分数不因新的 Episode 加减。
_Avoid_: Session commit, Interaction link

**Memory Episode**:
产品词表里的一段已结束的 PublicChannel 协作，要么是 Task 讨论窗口，要么是频道安静窗口。这条频道不再产生新的 Memory Episode。已有的 Memory Insight 和 Provenance edge 仍指向过去的 Episode。
_Avoid_: Session commit, Conversation session

**Session commit**:
一条 Conversation session 自上次归档以来的活消息，被整份收进 OpenViking 的那一次归档。它不是 Memory Episode。
_Avoid_: Memory Episode, Admitted Segment, 安静窗口, Task 讨论窗口
