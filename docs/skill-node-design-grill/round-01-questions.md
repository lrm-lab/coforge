# Round 1（griller: kiro / gpt-5.6-sol，经中间人转达）

设计树根节点：先确定“skill node”究竟是不是一个可检索、可演化的**跨会话因果经验图**，以及它与 OpenViking 既有可执行 skill 的边界。当前提案同时涉及归档写入、检索、因果推断、统计聚合和 skill proposal；这些不能靠在 archive_NNN/ 下多写几个文件自然成立。本轮只锁定不依赖其他答案的根决策；具体 schema、回填协议、保留策略和 prompt 留到后续轮次。

❓ **Q1** - **新物种还是既有 skill 的一种表示？**
OpenViking 已有 session skill：启用 memory.session_skill_extraction_enabled 后，会从归档原始消息提取可执行技能并写入 viking://~/skills；Agent Evolution 的链路又会产出 session skill（OpenViking/openviking/session/skill/）。而你定义的节点主要是“步骤状态 + 因果前驱 + 分支结果 + 统计”，它不是天然可执行的 skill。若继续叫 skill node，谁来保证调用者不会把“失败诊断中的状态节点”误当作可执行 SOP？

请选择一个明确边界：A. 改名为 trajectory_node / causal_experience_node，与 skill 完全分层；B. 定义为既有 skill 的底层证据节点，只有经过提案与审批的节点簇才提升为 skill；C. 直接扩展现有 skill schema，使每个 skill 都兼作轨迹节点。

➡️ 推荐答案：**B**。保留 skill 作为面向执行的产物；新增节点是可追溯证据，提案通过后才物化或更新 viking://~/skills 中的可执行 skill。

---

❓ **Q2** - **相似 context 检索的权威存储与索引面是什么？**
提案要求“检索相似 context 下的其他 skill node”，但 sessions/ 当前不进入向量索引：OpenViking/openviking/storage/queuefs/semantic_executor.py 对 session URI 有跳过路径；现有语义检索层面向 memories、resources、skills。把节点写进 sessions/{id}/history/archive_NNN/ 本身不会使它可发现。

请选择：A. 归档内只保存不可变证据，另在 viking://~/causal-experiences/ 建可索引的投影；B. 修改索引器，使整个 sessions/ 树可索引；C. 归档内保存节点，同时新建只索引 node 文件的 session 子树白名单；D. 不做持久向量索引，每次诊断扫描历史 session。

➡️ 推荐答案：**A**。归档保留审计事实；跨会话 node 投影进入独立、可索引命名空间。不要为一种派生对象打破“session 不索引”的现有边界，更不要在诊断时全量扫描历史。

---

❓ **Q3** - **关键步骤的最小资格条件和单归档预算是什么？**
现行 WM 模板 OpenViking/openviking/prompts/templates/compression/ov_wm_v2.yaml 明确要求丢弃不改变当前状态的中间过程；而你的设计要提取关键步骤，并为每步生成一份七段状态。没有硬判定标准，模型会把“运行命令、读文件、修一个拼写”都升格为节点，单归档成本可超过 Working Memory 本体。

请同时定下：
- 资格：A. 任意工具/action；B. 仅发生**目标、假设、计划、外部世界状态、代码/配置状态或诊断结论**改变的步骤；C. 仅用户显式认可的里程碑。
- 数量上限：每 archive 最多多少个节点（例如 0–3、0–5 或无上限）？
- 超额时的降级：合并相邻步骤、仅保留失败/转折点，还是直接不产出？

Session.commit_async 位于 OpenViking/openviking/session/session.py，其归档阶段已经生成该批次的 .overview.md；请明确 key-step extractor 是独立产物，而不是悄悄改变 WM “丢弃中间步骤”的语义。

➡️ 推荐答案：**B、每 archive 0–3 个、超额时按因果转折合并且优先保留失败修正与不可逆外部变更**。WM 模板保持不变，新增受严格 JSON schema 约束的 key-step 提取任务。

---

❓ **Q4** - **节点要服务的首个闭环是什么，谁拥有最终写入权？**
“抽取 skill、trace_cause、诊断轨迹”目前混在一起，但三者的输入、成功标准和风险不同。trajectory_analyzer.py 中已有 TrajectoryRolloutAnalyzer（OpenViking/openviking/session/train/components/trajectory_analyzer.py），因此不能只说“用于诊断”而不说明新链路是否替代、喂给、还是旁路它。

请选择首个必须交付的闭环：A. 失败轨迹 → 检索证据节点 → 因果归因报告；B. 失败轨迹 → 归因报告 → 候选 skill proposal；C. 成功轨迹 → 候选 skill proposal；D. 同时支持全部三者。并回答：proposal 的写入位置是什么、谁批准、未批准 proposal 是否能影响后续检索或自动执行？

➡️ 推荐答案：**A 先落地，B 仅生成隔离的候选 proposal**。归因输出应是带证据 node ID 的报告；proposal 写入独立候选区，必须经人或明确的 evaluator gate 批准，未批准内容不得进入可执行 skill 或改变自动策略。

---

❓ **Q5** - **与 Agent Evolution 的关系是输入、替代还是并行双写？**
当前链路在 Agent Evolution 开启时是 case → trajectory training → experience → session skill；且没有 case 时不会产出 skill。新机制若对所有 commit 产出节点，就会形成另一套经验提取系统。两套系统对同一成功/失败案例得出冲突结论时，哪个是权威？谁负责去重？是否允许任一方直接更新 viking://~/skills？

请选择：A. 新节点是 Agent Evolution 的前置证据层，仅 Evolution 负责产出/更新 executable skill；B. 新机制取代 trajectory analyzer；C. 两套独立并行，各自写 skill；D. 仅在有 case 的 session 中生成节点。

➡️ 推荐答案：**A**。节点覆盖普通 session 与 case session，但它们只发布标准化证据；既有 Evolution 链路继续承担训练、评估与 skill 发布，避免双写和无评价门槛的 skill 膨胀。

---

❓ **Q6** - **反事实分支是“证据”还是“假设”，何时才允许持久化？**
真实后续轨迹可以由后续交互观察到；反事实轨迹则是 LLM 生成的假设。两者若以同等边权、同等检索权重进入图，模型会把自己想象的成功经验当作真实经验。更严重的是，若每个节点都在 commit 时生成多个未来分支，成本与图规模会指数膨胀。

请选择：A. 仅在诊断请求时临时生成反事实，不持久化；B. 诊断时生成，只有经过 evaluator 或真实后续验证后才持久化；C. 每次 commit 主动生成并持久化固定数量；D. 不支持反事实。并规定真实/想象边必须携带哪些最小字段：origin、生成模型/版本、证据 node ID、置信度、验证状态、失效时间。

➡️ 推荐答案：**B**。默认只把反事实作为有来源、有置信度的候选假设；未验证假设不可与真实轨迹同权召回，且必须有 TTL 与每节点数量上限。

---

❓ **Q7** - **跨会话统计的单一写入者与语义是什么？**
“共现统计”和“context utility”是跨会话、随时间变化的聚合量；archive_NNN/ 则是某次 commit 的历史快照。若将计数直接写回归档，会破坏审计性；若各节点各自更新，又会面对并发、去重和重放问题。归档目录已有 .meta.json、memory_diff.json、.done 等完成态工件（OpenViking/openviking/session/session.py 的 commit 流程），不应把它们变成可变统计数据库。

请定下：A. 不做统计，先只保留原子证据；B. 以可索引 node projection 为源，由单独异步 aggregator 维护全局物化统计；C. 每次 session commit 同步更新全局统计；D. 将统计写回各 archive。并定义 utility 的反馈标签来源：用户显式评价、任务成功/失败、后续纠错、还是模型自评？

➡️ 推荐答案：**B**，且第一版 utility 只接受可审计的任务结果与后续纠错，不接受无校准模型自评作为正向效用。归档只记录其产生时的不可变观察与 node ID。

---

❓ **Q8** - **节点身份、前驱边与历史保留的不可变契约是什么？**
提案要求前驱引用和时间序，但未定义跨 archive、跨 session、归档清理、重跑提取后的语义。若 ID 使用 archive_NNN + step_index，重压缩、删除、迁移或补抽就会导致引用漂移；若删除原始消息，后续又如何审计一条“真实轨迹边”的证据？

请选择 ID 策略：A. 路径式 ID；B. 基于不可变 session_id/archive_id/step_id 的 UUID，节点内容另存 content hash；C. 仅内容 hash。并明确保留政策：原始 messages.jsonl、节点证据摘要、以及已删除证据的 tombstone 分别至少保留多久？

➡️ 推荐答案：**B**。前驱/分支边只能指向永久 node UUID；归档路径只是定位信息。清理原文时保留最小证据摘要、内容 hash、删除原因和 tombstone，不能静默让因果边悬空。
