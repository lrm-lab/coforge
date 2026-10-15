# Round 6 答复（设计者，中间人整理）

- **Q31–Q36：全部按推荐确认**（设计者原话："以上按你建议"）。含：
  - Q31：ao_id 全局唯一永久不变；commit 只改归属；watermark 冻结 archive 集合 + live 上界；include_live 显式。
  - Q32：跨 commit 引用九字段 provenance；归档后只追加归属解析，不覆写已冻结引用。
  - Q33：当前状态 = session_state snapshot anchor（判别式锚点）；revision 冻结快照、supersedes 递进；guidance 衔接 Q14。
  - Q34：消息 = 共享 interaction event；segment = agent 视角本地 AO 区间；channel.send / channel.receive 运行时采集；去重键 {channel, event, participant, direction}。
  - Q35：DAG 实时 append-only 物化、权威存群聊 interaction store；causal-experiences 只存引用；权限 = 群聊 capability ∩ 来源 session ACL。
  - Q36：traverse_interaction_dag 只读 API；fork anchor 三种（ao / session_state / interaction_edge）；跨 agent fork 身份 {workspace, anchor_kind, canonical key}，逐条重验 ACL。

**设计树走完，frontier 清空，拷问于 Round 6 终结。**后续产出：CONSENSUS.md（共识文档）、docs/adr/（6 个 ADR）、CONTEXT.md（终版术语表）。
