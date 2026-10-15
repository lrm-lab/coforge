
[?25l> 我先核对前四轮的原始决议与 Round 4 的转向内容，再整理为可收口的 Round 5 问题。
[?25lBatch fs_read operation with 9 operations (using tool: read)
Purpose: 读取设计拷问前四轮的简报、问题与回答，核对转向后的既有决议。

↱ Operation 1: Reading file: /home/zhoujie22/river2_0/skill-node-design-grill/brief.md, all lines
↱ Operation 2: Reading file: /home/zhoujie22/river2_0/skill-node-design-grill/round-01-questions.md, all lines
↱ Operation 3: Reading file: /home/zhoujie22/river2_0/skill-node-design-grill/round-01-answers.md, all lines
↱ Operation 4: Reading file: /home/zhoujie22/river2_0/skill-node-design-grill/round-02-questions.md, all lines
↱ Operation 5: Reading file: /home/zhoujie22/river2_0/skill-node-design-grill/round-02-answers.md, all lines
↱ Operation 6: Reading file: /home/zhoujie22/river2_0/skill-node-design-grill/round-03-questions.md, all lines
↱ Operation 7: Reading file: /home/zhoujie22/river2_0/skill-node-design-grill/round-03-answers.md, all lines
↱ Operation 8: Reading file: /home/zhoujie22/river2_0/skill-node-design-grill/round-04-questions.md, all lines
↱ Operation 9: Reading file: /home/zhoujie22/river2_0/skill-node-design-grill/round-04-answers.md, all lines
 ✓ Successfully read 8277 bytes from /home/zhoujie22/river2_0/skill-node-design-grill/brief.md

 ✓ Successfully read 8985 bytes from /home/zhoujie22/river2_0/skill-node-design-grill/round-01-questions.md

 ✓ Successfully read 2861 bytes from /home/zhoujie22/river2_0/skill-node-design-grill/round-01-answers.md

 ✓ Successfully read 13303 bytes from /home/zhoujie22/river2_0/skill-node-design-grill/round-02-questions.md

 ✓ Successfully read 5720 bytes from /home/zhoujie22/river2_0/skill-node-design-grill/round-02-answers.md

 ✓ Successfully read 9551 bytes from /home/zhoujie22/river2_0/skill-node-design-grill/round-03-questions.md

 ✓ Successfully read 3302 bytes from /home/zhoujie22/river2_0/skill-node-design-grill/round-03-answers.md

 ✓ Successfully read 6070 bytes from /home/zhoujie22/river2_0/skill-node-design-grill/round-04-questions.md

 ✓ Successfully read 2667 bytes from /home/zhoujie22/river2_0/skill-node-design-grill/round-04-answers.md

 ⋮

- Summary: 9 operations processed, 9 successful, 0 failed
 - Completed in 0.2s

[?25l> # Round 5

## 转向后的决策总账

| 既有决策 / 协议 | 转向后的状态 | 最终含义 |
|---|---|---|
| commit 时从归档消息抽取关键步骤并生成 trajectory node | 作废 | commit 只建立全覆盖、廉价的 action-observation（AO）台账；不再从 .overview.md 或归档批次直接生成节点。 |
| Q3 的“关键步骤资格判定 B” | 降级为诊断 agent 的选点指南 | “目标、假设、计划、外部世界、代码/配置状态或诊断结论改变”不再是 commit extractor 的入选规则；它成为诊断 agent 从台账中识别值得构造 fork node 的决策状态点的启发式。 |
| Q9/Q17 的每 archive 节点硬上限、优先级、相邻步骤合并、预算外步骤去向 | 作废 | fork node 的稀疏性来自诊断时按需构造，不来自 commit 时的数量预算；AO 台账始终完整保留，fork node 不设每 archive 数量上限。 |
| 原有“trajectory node”命名 | 由 fork node 取代 | fork node 表示诊断 agent 回看 AO 台账后选定的、可归因、可比较未来路径的决策状态点。 |
| Working Memory 的七段 .overview.md 与“丢弃普通中间步骤”语义 | 保留且更明确 | WM 不承担 fork node 抽取职责；现有 ov_wm_v2 语义无需为该设计改变。 |
| AO 台账全覆盖 | 保留并成为事实底座 | 每个 action-observation pair 默认记录；observation 可继续采用确定性 synopsis，大结果保留外置引用。fork node、归因、回放与原文下钻均以台账为来源。 |
| Q1/Q18：节点与 executable skill 分离，节点为不可变证据资产，Evolution 维护稳定 executable skill URI | 保留，名称改写 | fork node 是独立、不可变的因果证据；可执行 skill 仍由 Agent Evolution 发布和更新，二者不可混为同一可变 SKILL.md。 |
| Q18：used_skills[] 按实际调用顺序记录 {skill_uri, revision_hash, invocation_id?} | 保留，但来源改写 | fork node 在诊断期从所引用 AO 台账区间回填 skill 调用；因此台账必须不可省略地记录每次实际 skill invocation 及其 revision hash。 |
| Q2/Q19：归档证据与可索引投影分层；causal-experiences 独立于 /skills | 保留原则，修订落点 | fork node 不可写回已 .done 的 archive。viking://~/causal-experiences/ 必须承载其权威记录或其权威写入流；archive 保持 AO 台账与会话证据的不可变来源。 |
| Q19：.done 代表“归档证据已提交”，不代表 projection 已可检索 | 保留，但“归档证据”改为 AO 台账证据 | .done 不再承诺 fork node 已存在或已投影；fork node 可在任意后续诊断期构造，不能改变 archive 完成态。 |
| Q19：异步 outbox、幂等发布、轻量检索投影、检索 ACL + 原文二次 ACL | 保留，须适配新写入者 | 仍不可让诊断 agent 任意双写索引；但 outbox 的源将不再只是 commit archive extractor，而包括 fork-node 写入服务。 |
| Q16：检索入口仅为 node 与 future branch，guidance 是 branch 字段 | 保留，名称改写 | 检索入口变为 fork node 与其 future branch；guidance 不能脱离父状态、动作与结果独立建库。 |
| Q6/Q24：想象分支在诊断期生成，采用带 synthetic 标记的完整 AO 序列；真实分支默认排序更高 | 保留 | 想象 action 与想象 observation 均必须显式标记 synthetic；未验证想象分支不得与真实分支同权，持久化仍须遵守验证门槛。 |
| Q7：全局共现、utility 由单独 aggregator 聚合 | 保留，但依赖稳定 fork 身份 | 统计不得写入 archive；同一决策点的重复诊断如何复用 fork node，直接决定共现、效用与 skill 合并统计是否可解释。 |
| Q12/Q20：proposal 独立存储，evaluator 是唯一审批者且不得自评自批 | 保留 | 诊断 agent 可构造 fork node、生成候选 proposal；但不获得发布 executable skill 的权限，批准仍由版本化 evaluator 完成。 |
| Q14：不可 replay 时写入结构化 guidance event，三个 extractor 默认过滤，只有 adoption event 计 utility | 保留 | fork node 的构造不改变 guidance 的会话消息语义与过滤规则。 |
| Q15：memory.skill_trajectory_mode = legacy \| causal，session 创建时固化 | 保留，内部语义更新 | causal 模式现在 gate AO 台账、fork-node/branch 构造与消费、proposal/replay/guidance/统计；不再 gate commit 时 trajectory-node extractor。 |
| Q21：daemon 七步 replay eligibility 判定、隔离 worker、配对无-guidance 基线与预算 | 待确认 | Round 4 已给出完整协议，但设计者尚未明确确认或提出修改；本轮只需最后确认。 |
| Q23：诊断时回溯选择 causal context，可包含后续 AO pair | 保留选择，但必须改写字段语义 | 包含未来 AO 的材料只能叫 hindsight attribution / retrospective evidence，不能伪装为“当时决策依据”。当时依据与事后归因必须双字段、双标签保存。 |

❓ Q25 - fork node 的权威存储与同一分叉点的稳定身份如何同时确定？
已 .done 的 archive 不能被诊断期写回，因此不应为 fork node 修订 archive 完成契约。请确认以下模型：

1. fork node 的权威记录写入独立的 viking://~/causal-experiences/；它保存 fork_node_id、来源 workspace/session/archive、anchor_ao_id、所选 AO 证据、七段状态、branch 与 provenance。archive 只保留原始消息、AO 台账及其完成态。
2. 同一个“分叉点”以不可变的 {workspace_id, source_session_id, anchor_ao_id} 为稳定锚点；该锚点对应一个稳定 fork_node_id，而不是每次诊断都创建新的节点。
3. 后续诊断命中同一锚点时，复用该 fork node，并追加不可变的诊断 revision / attribution revision 或 branch；不得覆写原有诊断结论。共现、utility 与 skill 合并以稳定 fork_node_id 聚合，具体结论以 revision 区分。
4. 若诊断 agent 认为相邻多个 AO 才共同构成一个决策点，仍必须选出唯一 anchor_ao_id，并把其余 AO 放入 selected_evidence_ao_ids[]，避免“同一分叉点”没有可去重的主键。

➡️ 推荐答案：**确认以上模型。**不修改 .done 契约；causal-experiences 成为 fork node 的权威命名空间；以唯一 anchor AO 复用稳定 fork node，新增诊断只追加不可变 revision/branch。

❓ Q26 - 诊断 agent 作为 fork-node 写入者，走什么受控路径与幂等键？
诊断 agent 现在不仅读取台账，也会构造 fork node、想象分支及候选 proposal。若它可直接写 projection 或索引，archive、权威记录、outbox 和 ACL 会重新失去单一边界。

请确认：
- agent 仅拥有 workspace 范围内的 causal-experience:propose 能力：它必须先拥有来源 session/AO 原文的读取权限，且只能引用同 workspace 可读的 AO。
- agent 向一个受控的 fork-node write API / durable command outbox 提交 ForkNodeUpsert，由服务端验证 AO 存在性、ACL、schema、synthetic 标记、配额与引用完整性后，原子持久化权威 fork node/revision，并再写 projection outbox。
- agent 不可直接写向量投影、全局统计、已 .done archive，也不可发布 executable skill。
- 每次提交带 diagnosis_run_id、稳定 anchor、schema/version 与内容 hash；幂等键为 diagnosis_run_id + anchor_ao_id + content_hash。相同诊断重试不重复写；同一 anchor 的新内容作为同一 fork node 的新 revision，而不是新根节点。

➡️ 推荐答案：**确认。**诊断 agent 只能“提议写入”，由服务端经 durable command/outbox 验证、落权威记录并异步投影；禁止 agent 直写索引、统计、archive 或 executable skill。

❓ Q27 - AO 台账的 skill 调用记录是否成为强制、不可推断的事实字段？
Q18 的 used_skills[] 现在只能从 AO 台账回填。若台账只留工具名、参数和 synopsis，事后无法知道某个 action 是否实际使用了某份特定 revision 的 skill，也无法可靠 replay。

请确认每个 action AO 条目必须有以下字段：
json
{
  "ao_id": "immutable-id",
  "sequence": 42,
  "action": { "...": "..." },
  "observation": { "...": "..." },
  "skill_invocations": [
    {
      "skill_uri": "viking://~/skills/git-rescue",
      "revision_hash": "sha256:...",
      "invocation_id": "runtime-call-id"
    }
  ]
}


其中：
- skill_invocations 是必有字段；未使用 skill 时显式写 []，不能省略、不能以事后 LLM 推断补齐。
- 每次 invocation 必须同时有 skill_uri 与 revision_hash；invocation_id 在运行时存在时必须记录。
- 数组按实际调用顺序排列；fork node 的 used_skills[] 仅能从其 selected_evidence_ao_ids[] 覆盖的台账条目机械回填，并标明对应 AO ID，不能补造“可能使用过”的 skill。

➡️ 推荐答案：**确认全部。**这是一项 AO 台账的强制运行时采集契约，而不是诊断期的推测字段。

❓ Q28 - 诊断 agent 分页读台账、按需下钻原文的最小 API 契约是什么？
fork node 按需构造的前提是 agent 能稳定、受 ACL 约束地浏览长轨迹，而不能一次拉取整份 messages.jsonl。请确认最小只读接口为两层：

1. list_ao_ledger(session_id, cursor, limit, snapshot_watermark, filters?)：按不可变 sequence 升序返回页；响应含 next_cursor、固定 snapshot_watermark、每条 AO 的 ao_id、时间/sequence、action 摘要、observation synopsis、skill_invocations、artifact/message 引用和可下钻标识。后续分页必须在同一 watermark 下稳定，不因新增记录导致跳项或重项。
2. get_ao_evidence(ao_id, include=message_spans|raw_messages|tool_artifact_refs)：只在来源 session/workspace ACL 二次验证通过后返回所需原文片段或外置工具结果引用；默认不返回整份 archive，也不因拥有 fork node ID 而绕过来源 ACL。

limit 应由服务端设置最大值；诊断 agent 只获得与自己权限相交的 AO，所有读取写入诊断审计。

➡️ 推荐答案：**确认以上两层契约。**分页接口服务定位与筛选；下钻接口服务证据核验；二者均以来源 session 的 ACL 为权威。

❓ Q29 - Q23=B 的 hindsight 归因如何与“当时决策依据”硬隔离？
既然诊断可引用节点之后的 AO pair，字段名 causal_context_ao_ids 已不再能诚实表达“当时为何这样决定”。否则未来失败结果会被伪装成当时可得的信息，污染 replay、归因解释与训练。

请确认每个 fork-node revision 至少分开保存：
- contemporaneous_basis_ao_ids[]：仅允许严格早于 anchor_ao_id 的 AO；表示诊断者认为当时可获得、可能支撑该决策的信息。
- hindsight_attribution_ao_ids[]：可包含 anchor 后的 AO；表示事后用结果、纠错和后续轨迹作出的归因证据，绝不能显示为当时知识。
- anchor_ao_id：被分析的决策/动作锚点；不得同时被写入以上两组。
- attribution_method、诊断模型/版本、diagnosed_at 与每条证据的时间关系；UI、检索结果和 prompt 都必须显式展示“当时依据”或“事后归因”。

未来 AO 可辅助构造想象分支与失败解释，但不得进入 replay 的初始状态，也不得作为“该 action 当时已知”的证据。

➡️ 推荐答案：**确认。**保留 Q23=B 的诊断价值，但将其改名为 hindsight attribution；“当时依据”始终严格早于 anchor，两个集合在 schema、展示与模型输入中都不可混淆。

❓ Q30 - Q21 的 daemon 七步 replay 判定协议是否正式定案？
请确认 Round 4 给出的协议：daemon 按来源权限与完整性、初始状态可重建、历史工具版本可执行、逐工具副作用隔离覆盖、临时/最小权限凭据、非确定性控制、资源与 sandbox 策略七步检查；任一项失败即创建持久 ineligible replay job、记录 blocking_checks[] 与缺失项、不启动 worker，并转入结构化 guidance event 路径。只有满足全部条件的 job 才进入一次性隔离 worker，并严格沿用既定的 3 个 skill revision、每 revision 一条 guidance 与一条配对 no-guidance 基线、16k token / 25 工具调用 / 10 分钟等预算。

➡️ 推荐答案：**确认，按 Round 4 原文定案。**

Q25–Q30 得到明确确认后，当前设计树将无剩余 frontier，设计拷问终结。

 ▸ Credits: 2.38 • Time: 1m 2s

[?25h
