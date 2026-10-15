# Round 5 答复（设计者原话，中间人整理）

- **Q25: 基本同意推荐模型**（causal-experiences 权威存储、稳定锚点身份、revision 追加不覆写、唯一 anchor + selected_evidence_ao_ids[]），**但提出两个特殊情况**：
  1. **跨 commit 的 causal context**：诊断 agent 能跨 commit 看台账（必要时看原文），因此 fork node 的 causal context 可能引用跨 commit 的 AO pair；随后生成的 guidance 和相应想象分支，guidance 也引用这些跨 commit 的 AO pair。**不可 replay 情况下，fork node 为当前 session 的当前状态**（即锚点是"现在"，而非某个历史 AO）。
  2. **群聊多 agent 的 interaction DAG**：多 agent 通过群聊进行信息交换；每次 agent 发送或接收群聊消息生成一个 **segment 截断**；segment 截断可用于生成多 agent 的 **interaction DAG**；诊断 agent 能沿着 DAG 的边查看多 agent 的全局交互历史。
- **Q26–Q30: 其他都按推荐确认**：
  - Q26：诊断 agent 仅 propose；服务端验证（AO 存在、ACL、schema、synthetic 标记、配额）原子落库再投影；幂等键 diagnosis_run_id + anchor_ao_id + content_hash。
  - Q27：台账强制 skill_invocations（skill_uri + revision_hash 必有，未用显式 []，禁止事后推断；used_skills[] 仅机械回填）。
  - Q28：两层只读 API：list_ao_ledger 分页（watermark 固定）+ get_ao_evidence 下钻（二次 ACL、写入诊断审计）。
  - Q29：双字段硬隔离——contemporaneous_basis_ao_ids[]（严格早于 anchor）与 hindsight_attribution_ao_ids[]（可含 anchor 后）；UI/检索/prompt 显式标注。
  - Q30：daemon 七步 replay 判定协议定案（按 Round 4 原文）。

## 两个特殊情况引发的开放问题（Round 6 必须收口）

1. **ao_id 作用域与跨 commit 读取**：ao_id 必须 session 级、跨 archive 稳定；list_ao_ledger 的 watermark/分页语义要覆盖多 archive（甚至活会话）；causal context 与 guidance 的跨 commit 引用需带 archive 归属的 provenance。
2. **"当前状态 fork node"**：锚点如何定义（session_id + 当前消息水位？）；它引用的 AO 证据可能来自未提交的活会话（.done 之外）——commit 后如何固化/回填；随会话推进它是否过期（锚定即冻结还是 revision 跟随）。
3. **segment 与 interaction DAG**：segment 边界的权威定义（一条消息既是一方的发送又是另一方的接收——双视角同一事件？）；群聊消息是否进各 agent 的 AO 台账；DAG 的节点/边定义（节点=segment？边=消息因果？）；DAG 存哪、何时构造；诊断 agent 沿边看其他 agent 历史的 ACL 作用域（群聊级 vs session 级）；是否需要 DAG 遍历 API；fork node 能否锚定跨 agent 的 DAG 边。
