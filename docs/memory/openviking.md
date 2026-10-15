# OpenViking 频道记忆

写线把已关闭的公共频道分段交进 OpenViking typed session。读线仍是 Memory Agent fence（`ov_find` / `ov_read` / `ov_search_context` / `memory_offer`，预算 3 次读 + 1 次 offer）。本文件只描述写线。

## 两层 session 模型

两层 session 不是同一种东西。

- Memory Agent 的模型 session 按群聊隔离，同一群的线程沿用该群 session；所有群共享同一 Agent 身份和工作目录。Daemon 在工作目录外保存群聊与原生 session 的映射，重启继续恢复，重置 session 后使用新映射。不同群的模型回合依次执行，同群通知可继续当前回合。
- 群聊路由按 Workspace Memory 身份启用，与模型及工具 profile 分开；显式 Memory 工具 profile 的评测也使用同一路由。控制 session 不读取群聊消息，群聊 session 的消息检查默认绑定本群。
- 成员活动聚合该 Agent 在所有群的动态，并标明来源、提供群聊链接；已有无来源的历史活动不补猜。Agent session 不写入 OpenViking。
- OV session 是一条频道分段。分段在 quiet-window 或 completed-task 关闭之后，整段 `POST /messages/batch`，再 `POST /commit`（`keep_recent_count: 0`）触发抽取。一个分段一个 session，id 为 `coforge-<segmentId>`。

不按 agent 建 OV session。定向投递使 agent session 成为频道日志的有损子集：没投递给它的消息它看不到，Memory 模型 session 虽按群隔离，收到的仍只是定向投递的子集。按 agent 复制会得到 N 份拷贝，抽取窗口永远对不齐。

## 借鉴 hermes 的决策

对照的是 hermes 的 session sync，不是它的整条管线。commit 仍然只在分段关闭时发生。

| 项 | 本次 | 原因 |
| --- | --- | --- |
| B1 两阶段 | 借 | append 与 commit 分成可观测阶段：`append_submitted`、`append_settled`、`commit_submitted`、`commit_settled`。事件带 `segmentId`、`sessionId`、`messageCount`、`elapsedMs`，默认打一行 JSON（`workspace_memory_session.phase`）。 |
| B2 回显剔除 | 借 | Memory Offer 的引用块不再二次入库。正文在第一条含 `viking://` 的行处切开，前面留下，并标 `derived: true`。切完没有正文时写入 `[memory offer — 结论:无独立结论;引用内容不入库]`。原始人类消息仍按原文摄取。 |
| B3 崩溃补交 | 借 | `pending` 超过 10 分钟才重推。常量 `WORKSPACE_MEMORY_PENDING_REDRAIN_AFTER_MS`，可用同名 env 覆盖。年龄看 dispatch 行已有的 `updatedAt`。`retryable_failure` 仍立刻重推。`ingestOperationId` 与 `AdmissionReplayConflictError` 不变。 |
| B4 peer | 借 | agent turn 写成 `role: assistant`，并带 `peerId: coforge__<senderHandle>`（batch 字段 `peer_id`）。human turn 不带。 |
| B6 逐条降级 | 借 | batch POST 失败时改为逐条 `POST /messages`。逐条也失败才返回 `retryable_failure`。 |
| turn-slice | 不借 | 只保留被 @ 到的消息会丢掉同段里其余发言。分段仍是整段频道窗口。 |
| per-agent session | 不借 | 见上一节。定向投递是有损子集，不能替代完整频道分段。 |
| B5 trajectory | 不借，将来 | Daemon 以后收割 agent session transcript（含 tool calls），写入 OV trajectory。联邦场景（外部独立安装的 agent）另记，不在这条频道写线上做。 |

Append 幂等：batch 之前 `GET /sessions/{id}`，用已有消息的 `source_message_ids` 判断。目标消息都在，就跳过 batch，直接 commit。GET 失败则仍走 batch，避免探测故障挡住第一次写入。

## Capability 矩阵

点亮验证只填写已经存在、并且本次相关测试通过的用例。路径相对 `apps/web/`。

| 能力 | hermes | coforge 首版前 | 首版后 | 点亮验证 |
| --- | --- | --- | --- | --- |
| 会话摄取 | 有 | 有：batch 后 commit | 有，并带阶段事件与 peer | `src/server/openviking/typed-session-extract.server.test.ts`「typed session extract writes the session then commits then extracts with server-held credentials」；`src/server/workspace-memory/ov-sink.server.test.ts`「OV sink delivers through the typed channel and retries as retryable_failure」 |
| B1 两阶段 | 有 | 调用顺序在，阶段不可观测 | 四个 phase 按序发出，commit 一次 | `src/server/openviking/typed-session-extract.server.test.ts`「typed session extract reports append and commit phases in order around one commit」 |
| B2 回显剔除 | 有 | 无，offer 原文入库 | offer 去掉 `viking://` 之后的引用，标 `derived` | `src/server/workspace-memory/sweep.test.ts`「an offer message is written without its citation text and the human message stays verbatim」 |
| B3 崩溃补交 | 有 | 下一轮 sweep 会重推全部 pending 与 retryable_failure，不看年龄；append 不幂等；batch 失败即失败 | 超过 10 分钟的 pending 才重推；已 append 则只 commit；batch 失败逐条 POST | `src/server/workspace-memory/sweep.test.ts`「a pending dispatch older than ten minutes is redriven by the next sweep」；`src/server/openviking/typed-session-extract.server.test.ts`「a replay after the append lands and the commit crashes does not append those messages again」；同文件「a failed message batch falls back to one post per message and still commits」 |
| B4 peer 归属 | 有 | assistant 无身份 | `coforge__<handle>`，human 不带 | `src/server/workspace-memory/ov-sink.server.test.ts`「agent turns carry a coforge peer id and human turns do not」 |
| fence 读线 | 单闸门读，不是每 agent 一套写入 | 有，profile 级 fence | 不变 | `src/server/workspace-memory/memory-agent-fence.test.ts`「maps Workspace Memory Profile to the injected Memory Agent fence」；同文件「store lookup returns the fence without exposing profile selection to callers」 |
| 每 agent viking_* 工具 | 不在本次对照里单列 | N/A：读线单闸门 | N/A：读线单闸门 | 同上 fence 用例。没有 per-agent 工具面可点亮 |
| add_resource、forget | 未纳入本次借用 | ⬜ 后补 | ⬜ 后补 | 未点亮 |

## Open questions

- B5 trajectory 线：daemon 收割 agent session transcript（含 tool calls）写入 OV trajectory，以及联邦场景下外部独立安装的 agent。现在没有写线。
- `add_resource` 与 `forget` 仍是后补，写线和读线都不提供。

## 已退休的决策记录

仓库不再保留 ADR、单体架构文档与实现切片（`AGENTS.md` 的文档规则），这条记忆线原先的 ADR 已随目录一起退休。它们的去向：

- OpenViking-only、Causal Memory 移除、完整访问走策略网关（0061、0062）：规则本身就是代码与 `apps/web/AGENTS.md` 的模块分工，这里不再复述。
- 轨迹索引、跨 lane 桥分型、ForkRevision 生命周期、消费记账（0072–0075）：尚未实现的设计记录，正文留在 git 历史（`git log -- docs/adr/`）。其中轨迹索引对应上面 B5 这条 open question。
- Causal Memory 的三份（0058–0060）已被 0062 取代，不再有效。


## 显式四角色诊断

任务 Agent 在公开群聊发送 `@memory diagnose <问题和错误证据>`。Memory
读取该消息的 UUID，调用 `memory_diagnose({operationId, messageId})`。普通
`@memory retrieve` 继续走检索；模糊意图先澄清，不隐式启动诊断。

Web 按已保存的求助消息绑定原群与发送任务 Agent，重新检查双方群成员身份、
当前 workspace profile 与 OpenViking binding。模型不能指定任意 session、
接收者或原始轨迹。证据是截至求助消息的连续尾部：最多 64 条、64,000 字符；
不包含 task 的完整私有工具轨迹。Memory 重命名后的存储 mention token 也可识别。

服务端在任务 Agent 自己的命名空间创建独立 causal session，禁用自动 commit，
通过私有 typed control 调用 OpenViking 的 session diagnosis API。现有
Builder → Critic/Refiner → Reader 核心基于冻结 AO 快照运行；不依赖频道静默
归档，不 commit 仍在运行的原任务，也不自动执行 remediation 或发布 Skill。

请求以求助消息 UUID 去重，状态持久化为 running/completed/failed，最多运行
600 秒。进程中断后可读取已完成结果；未完成尝试到期返回失败，不自动重跑。
原生工具内部有界轮询，返回 running 时可继续用同一 messageId 查询。

仅完整 Reader 报告会登记为引用，并通过 Memory Offer 发给求助的任务 Agent，
携带 `hint_id`，由其调用 `memory_disposition` 判断接受、拒绝或暂缓。
失败/fallback 不发布成功 Offer。必须明确配置 `COFORGE_MEMORY_HINT_TTL_SECONDS`，
配置缺失时在启动模型前拒绝请求。CoForge Web、Daemon/Agent 和 OpenViking
必须一起更新；独立 IR Go harness 尚未接入此工具。
