# Round 6（griller: kiro / gpt-5.6-sol，经中间人转达）——跨 commit 与群聊多 agent 的收口

设计树状态：AO 台账、按需构造的 fork node、双轨 hindsight 归因、受控写入与 replay/guidance 路径均已定；现在仅收口跨 commit 的读视图与群聊多 agent 的因果边界。

❓ **Q31** - **AO 身份作用域，以及跨 archive 与活会话的稳定分页快照是什么？**
ao_id 若仅在 archive 内唯一，跨 commit 的 causal context、guidance 与 fork node 无法可靠引用；若分页只以"最新 archive 编号"为 watermark，分页期间发生 commit 时，原本 live 的 AO 会搬入 .done archive，导致重项或漏项。请确认五项契约：
1. ao_id 在**整个 deployment 内全局唯一且永久不变**；session_id + sequence 只负责会话内排序，不能替代主键。
2. AO 在运行时写入 append-only live ledger 时即获得 ao_id 与 sequence；commit 只改变其 archive 归属，绝不重新编号或换 ID。
3. list_ao_ledger 的 snapshot_watermark 是服务端签发的不可伪造读视图，至少冻结：session_id、台账 schema/version、已完成 archive 集合及其 manifest/version、已完成 AO 的最大 sequence、live ledger 的最大 sequence。
4. 首页未传 watermark 时服务端建立读视图；后续 cursor 携带同一 watermark。期间新增 live AO 或完成新 archive 不进入这次分页；已冻结 live AO 即使随后被归档，仍可通过该快照读取。
5. 默认接口只读已提交 AO；诊断"当前状态"时显式传 include_live=true，响应标明哪些 AO 尚未归档。

➡️ 推荐答案：确认五项。以**全局不可变 ao_id + session 内单调 sequence + 跨 archive/live 的 opaque snapshot watermark**为唯一协议；调用方不得自行拼 archive 编号、水位或 live 边界。

---

❓ **Q32** - **跨 commit 引用 AO 时，causal context、guidance 与想象分支必须携带哪些 provenance？**
"引用 ao_id"不足以复现诊断时看到的状态：同一个 AO 可能当时仍在 live ledger，后来才被 archive。每条跨 commit 的 AO 证据引用至少包含：

```json
{ "ao_id": "global-immutable-id",
  "source_session_id": "…",
  "source_archive_id": "archive_012 | null-if-live",
  "archive_commit_watermark": "archive manifest/version | null-if-live",
  "source_sequence": 184,
  "source_read_snapshot_watermark": "opaque-ledger-snapshot-id",
  "evidence_role": "contemporaneous_basis | hindsight_attribution | branch_basis | guidance_basis",
  "evidence_content_hash": "sha256:…",
  "captured_state": "committed | live" }
```

fork-node revision、guidance event、imagined branch 都记录自己的 diagnosis_run_id、生成模型/版本、生成时间，并保存 selected_evidence_refs[]；不能只在 branch 文本中隐含提及"之前的 commit"。

➡️ 推荐答案：确认。ao_id 负责永久定位，archive/commit 水位与读快照负责"当时看见的版本"，content hash 负责审计证据漂移；live AO 归档后只**追加归属解析记录**，不覆写已产生的 fork revision、guidance 或 branch 的原始 provenance。

---

❓ **Q33** - **"当前状态 fork node"在不可 replay 场景中的锚点、固化与 guidance 衔接是什么？**
当前状态不是历史 ao_id：它可能涵盖已提交 archive、未提交 live AO、以及尚未进台账的会话状态。请确认：
1. 增加判别式锚点，而非伪造历史 AO：

```json
{ "anchor_kind": "session_state",
  "session_id": "…",
  "ledger_snapshot_watermark": "…",
  "live_ao_upper_bound": 184,
  "anchored_at": "…" }
```

2. 当前状态 fork node 的每个 revision 创建时**冻结**该 read snapshot；会话新增 AO 不改变该 revision。重新诊断当前状态 = 同一 logical subject 的新 revision（带 supersedes_revision_id），不静默更新旧结论。
3. live AO 产生时即有永久 ao_id；commit 后服务端追加 ao_id → archive_id/commit_watermark 的归属解析，回填可查询的 provenance projection；不改写已冻结的引用。
4. 不可 replay 时，structured guidance event 在该锚点快照之后 append 到 session 尾部，携带 guidance_id、fork_node_id、fork_revision_id、snapshot watermark 与 evidence refs；仍按 Q14 从三个 extractor 过滤，显式 adoption 才计 utility。

➡️ 推荐答案：采用"**当前状态 = 有效期固定的 session-state snapshot anchor**"，不是自动追随会话的活节点。guidance 明确回答"在这个状态下下一步应做什么"；会话变化后须重新诊断，而非让旧 guidance 伪装仍适用。

---

❓ **Q34** - **群聊 segment 的权威定义、AO 记录方式与去重键是什么？**
同一群聊消息不是单一 agent 的本地动作：发送者经历"发送"，每个接收者经历"接收"。请确认：
1. 群聊服务先产生权威、不可变的 interaction_event_id/message_id，带 channel、发送者、server-assigned channel sequence、内容 hash、发送时间与投递目标。
2. segment 是某个 participant 在本地会话中的 AO 区间，由 interaction event 截断；同一消息至少产生一个 sender-side boundary，且每个实际接收者产生一个 receiver-side boundary。共享 interaction_event_id，但不是同一个 segment。
3. 发送方在自己的 AO 台账记录 channel.send action；接收方将 channel.receive 作为明确的 observation 事实，引用同一 canonical message event。接收不由 LLM 事后推断，也不复制整段消息正文到每个 agent 的私有 AO。
4. segment_id 由服务端创建且不可变；逻辑去重键 = {channel_id, interaction_event_id, participant_agent_id, direction}。网络重投递以 receipt ID 记审计，不生成第二个逻辑 receive segment；内容重发必须是新 message ID。

➡️ 推荐答案：确认。**消息是共享 interaction event；segment 是 agent 视角的本地、不可变区间。**发送与接收同时保留、明确关联，但不合并为一个共享 AO 或共享 segment。

---

❓ **Q35** - **interaction DAG 的节点/边、实时构造位置与跨 agent ACL 如何统一？**
请确认模型：
- **节点**两类：participant-scoped segment 节点、canonical interaction_event 节点。
- **边**三类：local_continuation（同一 agent 前一 segment → 后一 segment）、emit（sender segment → interaction event）、deliver（interaction event → recipient segment）。每条边带 immutable ID、channel sequence、时间、收发 receipt 与 ACL provenance。
- DAG 由群聊通道服务在消息接受/投递时**实时增量、append-only 物化**；durable outbox 将各 agent AO/segment 关联写入群聊 interaction store。诊断侧只读版本化快照，最多按需构造投影视图，不自行拼接或重写权威边。
- 权威 DAG 存群聊通道的 interaction/session storage；`viking://~/causal-experiences/` 只存 fork node 对 DAG node/edge 的引用、诊断 revision 与 branch，不存通信事实的第二份权威副本。
- 有效访问权限 = **群聊级 capability（允许遍历该 channel）∩ 来源 session ACL（每个 segment/AO/原文能否展开）**。无权内容只返回最小化、不可泄密的断裂/redacted 标记；群聊成员身份不能自动越过某 agent 的 session ACL。

➡️ 推荐答案：确认。若希望群成员诊断时共读某段 session 证据，必须显式授予对应群聊 principal 读取权，不能靠 DAG 边隐式提权。

---

❓ **Q36** - **是否提供 DAG 遍历 API，以及 fork node 怎样锚定跨 agent 协同决策点？**
新增只读接口：

```
traverse_interaction_dag(channel_id, start_ref, direction=backward|forward|both,
  max_depth, cursor, snapshot_watermark, include=segment_summaries|edge_metadata)
```

要求：固定 channel/DAG watermark、逐节点逐边做 channel capability 与来源 session ACL 检查、支持分页与 redacted 断点、所有访问进诊断审计；原始 AO 与消息内容仍只能经 get_ao_evidence 或等价二次 ACL 接口取得。

同时扩展 fork anchor 为判别式 union：

```json
{ "anchor_kind": "ao", "ao_id": "…" }
{ "anchor_kind": "session_state", "session_id": "…", "ledger_snapshot_watermark": "…" }
{ "anchor_kind": "interaction_edge", "channel_id": "…", "interaction_event_id": "…",
  "from_segment_id": "…", "to_segment_id": "…", "dag_snapshot_watermark": "…" }
```

跨 agent fork node 稳定身份以 {workspace_id, anchor_kind, canonical_anchor_key} 派生；selected_evidence_refs[] 可指向双方 segment/AO，但每条证据保留来源 ACL 与 provenance。创建、读取 branch 或展开证据时，对每条引用重新执行来源 ACL；不因获得 fork node ID 就能读任一参与 agent 的私有历史。

➡️ 推荐答案：需要 traverse_interaction_dag，且允许 fork node 以**具体、有向的 interaction edge**为锚点——"某消息使另一个 agent 的决策改变"可表示为协同决策点，同时避免把整个群聊或模糊时间段当不可去重的锚点。

---

## 总账增量

| 既有决策 | 两个特殊情况后的修订 |
|---|---|
| AO 台账以 session 内 sequence 分页 | ao_id 升格为全局永久 ID；分页 watermark 同时冻结 .done archive 集合与 live ledger 上界。 |
| fork node 必须锚定唯一历史 anchor_ao_id | 增加 session_state snapshot anchor 与 interaction_edge anchor；均须版本化、可去重且冻结。 |
| archive 归属是 AO provenance 的默认背景 | 跨 commit 引用必须显式保存 archive/commit 水位、读快照、内容 hash 与 committed/live 状态；归档后只追加解析记录。 |
| AO 台账主要描述单 agent action-observation | 群聊发送/接收成为运行时采集的 canonical interaction event 与本地 AO/segment 边界；接收是明确 observation。 |
| 诊断 agent 只读来源 session 的分页台账 | 新增受控 DAG 遍历；群聊 capability 仅缩小可遍历范围，来源 session ACL 仍是证据展开的最终权威。 |
| causal-experiences 承载 fork node 权威记录 | interaction DAG 的权威事实存群聊 interaction/session storage；causal-experiences 仅保存对 segment/DAG edge 的 fork 与诊断引用。 |

**若 Q31–Q36 按推荐确认，frontier 清空。**
