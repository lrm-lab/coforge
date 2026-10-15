# Round 5（griller: kiro / gpt-5.6-sol，经中间人转达）——转向后的收口轮

## 转向后的决策总账

| 既有决策 / 协议 | 转向后的状态 | 最终含义 |
|---|---|---|
| commit 时从归档消息抽取关键步骤并生成 trajectory node | 作废 | commit 只建立全覆盖、廉价的 action-observation（AO）台账；不再从 .overview.md 或归档批次直接生成节点。 |
| Q3 的"关键步骤资格判定 B" | 降级为诊断 agent 的选点指南 | "目标、假设、计划、外部世界、代码/配置状态或诊断结论改变"不再是 commit extractor 的入选规则；成为诊断 agent 从台账中识别值得构造 fork node 的决策状态点的启发式。 |
| Q9/Q17 的每 archive 节点硬上限、优先级、合并、预算外去向 | 作废 | fork node 的稀疏性来自诊断时按需构造，不来自 commit 时的数量预算；AO 台账始终完整保留，fork node 不设每 archive 数量上限。 |
| "trajectory node"命名 | 由 fork node 取代 | fork node 表示诊断 agent 回看 AO 台账后选定的、可归因、可比较未来路径的决策状态点。 |
| Working Memory 七段 .overview.md 及"丢弃普通中间步骤"语义 | 保留且更明确 | WM 不承担 fork node 抽取职责；ov_wm_v2 语义无需改变。 |
| AO 台账全覆盖 | 保留并成为事实底座 | 每个 action-observation pair 默认记录；observation 走确定性 synopsis，大结果保留外置引用。fork node、归因、回放与原文下钻均以台账为来源。 |
| Q1/Q18：节点与 executable skill 分离，节点为不可变证据资产，Evolution 维护稳定 executable skill URI | 保留，名称改写 | fork node 是独立、不可变的因果证据；可执行 skill 仍由 Agent Evolution 发布和更新。 |
| Q18：used_skills[] 按调用顺序记录 {skill_uri, revision_hash, invocation_id?} | 保留，但来源改写 | fork node 在诊断期从所引用 AO 台账区间回填 skill 调用；台账必须记录每次实际 skill invocation 及其 revision hash。 |
| Q2/Q19：归档证据与可索引投影分层；causal-experiences 独立于 /skills | 保留原则，修订落点 | fork node 不可写回已 .done 的 archive。viking://~/causal-experiences/ 承载其权威记录或权威写入流；archive 保持 AO 台账与会话证据的不可变来源。 |
| Q19：.done 代表"归档证据已提交"，不代表 projection 已可检索 | 保留，"归档证据"改为 AO 台账证据 | .done 不再承诺 fork node 已存在或已投影；fork node 可在任意后续诊断期构造。 |
| Q19：异步 outbox、幂等发布、轻量检索投影、检索 ACL + 原文二次 ACL | 保留，须适配新写入者 | 仍不可让诊断 agent 任意双写索引；outbox 的源将包括 fork-node 写入服务。 |
| Q16：检索入口仅为 node 与 future branch，guidance 是 branch 字段 | 保留，名称改写 | 检索入口变为 fork node 与其 future branch；guidance 不能脱离父状态、动作与结果独立建库。 |
| Q6/Q24：想象分支在诊断期生成，带 synthetic 标记的完整 AO 序列；真实分支默认排序更高 | 保留 | 想象 action 与想象 observation 均显式标记 synthetic；未验证想象分支不得与真实分支同权，持久化须遵守验证门槛。 |
| Q7：全局共现、utility 由单独 aggregator 聚合 | 保留，但依赖稳定 fork 身份 | 统计不得写入 archive；同一决策点的重复诊断如何复用 fork node，直接决定共现、效用与 skill 合并统计是否可解释。 |
| Q12/Q20：proposal 独立存储，evaluator 唯一审批且不得自评自批 | 保留 | 诊断 agent 可构造 fork node、生成候选 proposal；但不获得发布 executable skill 的权限。 |
| Q14：不可 replay 时写入结构化 guidance event，三个 extractor 默认过滤，只有 adoption event 计 utility | 保留 | fork node 的构造不改变 guidance 的会话消息语义与过滤规则。 |
| Q15：memory.skill_trajectory_mode = legacy \| causal，session 创建时固化 | 保留，内部语义更新 | causal 模式现在 gate AO 台账、fork-node/branch 构造与消费、proposal/replay/guidance/统计；不再 gate commit 时 trajectory-node extractor。 |
| Q21：daemon 七步 replay eligibility 判定、隔离 worker、配对无-guidance 基线与预算 | 待确认 | Round 4 已给出完整协议，设计者尚未明确确认。 |
| Q23：诊断时回溯选择 causal context，可包含后续 AO pair | 保留选择，但必须改写字段语义 | 包含未来 AO 的材料只能叫 hindsight attribution / retrospective evidence，不能伪装为"当时决策依据"。当时依据与事后归因必须双字段、双标签保存。 |

❓ **Q25** - **fork node 的权威存储与同一分叉点的稳定身份如何同时确定？**
确认以下模型：①fork node 权威记录写入独立 viking://~/causal-experiences/（fork_node_id、来源 workspace/session/archive、anchor_ao_id、所选 AO 证据、七段状态、branch、provenance）；archive 只保留原始消息、AO 台账及完成态。②同一"分叉点"以不可变 {workspace_id, source_session_id, anchor_ao_id} 为稳定锚点，对应稳定 fork_node_id，不因重复诊断而新建。③后续诊断命中同一锚点时复用该 fork node，追加不可变的诊断 revision / attribution revision 或 branch，不覆写原结论；共现、utility、skill 合并以稳定 fork_node_id 聚合，结论以 revision 区分。④若相邻多个 AO 共同构成一个决策点，仍必须选唯一 anchor_ao_id，其余进 selected_evidence_ao_ids[]，保证分叉点有可去重主键。

➡️ 推荐答案：确认全部。不改 .done 契约；causal-experiences 为 fork node 权威命名空间；以唯一 anchor AO 复用稳定 fork node，新诊断只追加不可变 revision/branch。

---

❓ **Q26** - **诊断 agent 作为 fork-node 写入者，走什么受控路径与幂等键？**
确认：①agent 仅拥有 workspace 范围 causal-experience:propose 能力，必须先有来源 session/AO 读取权限，只能引用同 workspace 可读的 AO。②agent 向受控 fork-node write API / durable command outbox 提交 ForkNodeUpsert，服务端验证 AO 存在性、ACL、schema、synthetic 标记、配额与引用完整性后，原子持久化权威 fork node/revision，再写 projection outbox。③agent 不可直写向量投影、全局统计、已 .done archive，不可发布 executable skill。④每次提交带 diagnosis_run_id、稳定 anchor、schema/version 与内容 hash；幂等键 = diagnosis_run_id + anchor_ao_id + content_hash；同一 anchor 的新内容作为同一 fork node 的新 revision，不是新根节点。

➡️ 推荐答案：确认。诊断 agent 只能"提议写入"，服务端经 durable command/outbox 验证、落权威记录并异步投影。

---

❓ **Q27** - **AO 台账的 skill 调用记录是否成为强制、不可推断的事实字段？**
确认每个 AO 条目必须有：

```json
{ "ao_id": "immutable-id",
  "sequence": 42,
  "action": { "...": "..." },
  "observation": { "...": "..." },
  "skill_invocations": [
    { "skill_uri": "viking://~/skills/git-rescue",
      "revision_hash": "sha256:...",
      "invocation_id": "runtime-call-id" } ] }
```

①skill_invocations 必有字段；未使用 skill 显式写 []，不能省略、不能事后 LLM 推断补齐。②每次 invocation 必须同时有 skill_uri 与 revision_hash；invocation_id 运行时存在则必记。③数组按实际调用顺序；fork node 的 used_skills[] 只能从 selected_evidence_ao_ids[] 覆盖的台账条目机械回填并标对应 AO ID，不能补造"可能用过"的 skill。

➡️ 推荐答案：确认全部。这是 AO 台账的强制运行时采集契约，不是诊断期推测字段。

---

❓ **Q28** - **诊断 agent 分页读台账、按需下钻原文的最小 API 契约是什么？**
确认两层只读接口：①list_ao_ledger(session_id, cursor, limit, snapshot_watermark, filters?)：按不可变 sequence 升序返回页，响应含 next_cursor、固定 snapshot_watermark、每条 AO 的 ao_id/时间/action 摘要/observation synopsis/skill_invocations/artifact 引用/可下钻标识；后续分页在同一 watermark 下稳定，不因新增记录跳项重项。②get_ao_evidence(ao_id, include=message_spans|raw_messages|tool_artifact_refs)：只在来源 session/workspace ACL 二次验证通过后返回原文片段或外置工具结果引用；默认不返回整份 archive，不因持有 fork node ID 绕过来源 ACL。limit 由服务端设上限；agent 只见与自己权限相交的 AO，所有读取写入诊断审计。

➡️ 推荐答案：确认。分页接口服务定位筛选，下钻接口服务证据核验，均以来源 session ACL 为权威。

---

❓ **Q29** - **Q23=B 的 hindsight 归因如何与"当时决策依据"硬隔离？**
确认每个 fork-node revision 至少分开保存：①contemporaneous_basis_ao_ids[]：仅允许严格早于 anchor_ao_id 的 AO（当时可获得、可能支撑该决策的信息）。②hindsight_attribution_ao_ids[]：可包含 anchor 后的 AO（事后用结果、纠错、后续轨迹作的归因证据，绝不显示为当时知识）。③anchor_ao_id：被分析的决策/动作锚点，不得同时进两组。④attribution_method、诊断模型/版本、diagnosed_at 与每条证据的时间关系；UI、检索结果和 prompt 都必须显式展示"当时依据"或"事后归因"。未来 AO 可辅助构造想象分支与失败解释，但不得进入 replay 初始状态，不得作为"该 action 当时已知"的证据。

➡️ 推荐答案：确认。保留 Q23=B 的诊断价值，但改名为 hindsight attribution；"当时依据"始终严格早于 anchor，两集合在 schema、展示与模型输入中都不可混淆。

---

❓ **Q30** - **Q21 的 daemon 七步 replay 判定协议是否正式定案？**
确认 Round 4 协议：daemon 按来源权限与完整性、初始状态可重建、历史工具版本可执行、逐工具副作用隔离覆盖、临时/最小权限凭据、非确定性控制、资源与 sandbox 策略七步检查；任一项失败即创建持久 ineligible replay job、记录 blocking_checks[] 与缺失项、不启动 worker，转入结构化 guidance event 路径。满足全部条件的 job 才进入一次性隔离 worker，沿用 3 个 skill revision、每 revision 一条 guidance + 一条配对 no-guidance 基线、16k token / 25 工具调用 / 10 分钟预算。

➡️ 推荐答案：确认，按 Round 4 原文定案。

---

**Q25–Q30 确认后，设计树无剩余 frontier，拷问终结。**
