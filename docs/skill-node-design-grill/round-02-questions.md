# Round 2（griller: kiro / gpt-5.6-sol，经中间人转达）

已定：新机制直接扩展现有 skill schema（Q1=C），节点证据归档、跨会话投影可索引，Agent Evolution 仍是 executable skill 的发布者，统计由异步聚合器维护。本轮 frontier：把“一个 skill 同时是轨迹节点”的数据契约、proposal 的治理与效用语义、replay/guidance 的执行闭环，以及新旧行为开关的边界钉死。

❓ **Q9** - **关键步骤的硬上限与超额降级顺序是什么？**
资格条件 B 仍不能限制一次复杂归档中连续多次改计划、修复、验证的节点爆炸；每个节点还要带七段 context 快照。请一次确定：
- 每个 archive_NNN 的最大节点数：0–3、0–5，还是其他确定数值？
- 超额时是否按固定优先级保留：不可逆外部/代码配置变更 > 失败及纠正 > 改变计划或诊断结论 > 其他合格步骤？
- 同一因果链上相邻且同类型的合格步骤，是否合并为一个节点；合并后的 message_span / action span 如何记录？
- 达到预算后，其余合格步骤是仅留在 messages.jsonl，还是生成一个“不投影、不可检索”的汇总节点？

ov_wm_v2 本来要求丢弃常规中间过程，因此这一预算必须是 key-step extractor 的独立约束，不能借修改 .overview.md 的语义绕过成本控制。

➡️ 推荐答案：**每 archive 0–3 个；按“不可逆变更、失败纠正、诊断/计划转折、其他”排序；同一因果链的相邻步骤合并；超额候选只留原始消息与 extractor 审计，不生成节点。**

---

❓ **Q10** - **一个“skill 兼作轨迹节点”究竟是一份不可变 skill 版本，还是会被更新的同一 skill？**
Q1=C 与 Q5=A 之间有对象生命周期冲突：节点必须有 Q8 约定的永久 UUID、前驱边和可审计历史；而现有 session skill 是可 merge、可更新的 SKILL.md 资产——skill_operation_updater.py 读取既有 skill、合并字段后整体覆盖写回，dedup.py 按完整正文去重。若同一可执行 skill 在五条轨迹中被使用或演化，不能把五个历史节点压成一次 SKILL.md 更新。

表示模型选型：A. 每个 trajectory node 都是独立、不可变的 skill asset；可执行 skill 另有稳定 URI，由 Evolution 从已批准节点簇发布或更新。B. 一个可执行 skill asset 内追加多个不可变 trajectory_nodes[] 版本。C. 仍按现有可变 SKILL.md 更新，节点历史仅存 archive 证据文件。

并指定新 schema 最小字段，至少回答是否包含：node_id、source_session_id、source_archive_id、message/action span、context_7_sections、predecessor_node_ids、outgoing_edge_ids、observed_at、content_hash、evidence_status（真实/想象）、used_skills[]、projection URI。

“节点记录使用的 skill”的精确引用规则：
- used_skills[] 主键是 skill root URI（viking://~/skills/<name>）、.../SKILL.md URI、不可变 skill UUID，还是组合？
- 一个节点用多个 skill：有序列表（调用顺序）还是无序集合？
- 是否记录当时的 skill 内容 hash / revision？否则技能随后被 Evolution 更新后，replay 无法知道节点实际使用的版本。

代码依据：session_skill_context_provider.py 的 parse_skill_extract_file() 只保留 name/description/content/allowed_tools/tags；SkillOperationUpdater._merge_skill() 只初始化并序列化这些字段——“只改 extractor schema”会让元数据在读取、merge 或 SkillLoader.to_skill_md() 链路中丢失。dedup.py 的正文去重会误合并证据不同、正文相同的节点。

➡️ 推荐答案：**A；每个节点拥有永久 node_id 与不可变版本化 skill URI，used_skills 为按实际调用顺序排列的 {skill_uri, revision_hash, invocation_id?} 列表。扩展 SkillLoader 允许前置元数据、provider 解析与 updater merge/写入；dedup 签名必须纳入 node ID 或证据 hash。稳定 executable skill 继续由 Evolution 另行发布。**

---

❓ **Q11** - **archive 证据与可索引 projection 的发布协议、访问边界是什么？**
Q2 选了“archive 内不可变证据 + 可索引投影”，但写入顺序、失败恢复和权限面未定义：
- archive 提取完成后，先原子写 archive 证据再异步发布 projection，还是同一事务双写？
- projection 失败时 archive 是否仍可 .done；谁扫描未投影 node 并重试；如何保证同一 node_id 的重放幂等？
- projection 只含检索所需摘要/context embedding + archive URI，还是复制完整七段状态与边？完整证据由哪个受权限控制的 URI 读取？
- 投影命名空间是 viking://~/skills/... 的一部分，还是独立 viking://~/causal-experiences/...？Q1=C 不自动等于“全部节点都应作为可执行 skills 被 /skills 端点返回”。
- 检索调用方是否只拿摘要和 node ID，随后按原会话/工作区 ACL 二次授权读证据？跨 workspace、跨用户的相似检索是否明确禁止？

代码依据：集成分支 apps/web/src/server/openviking/catalog/route-family-memory-skill.ts 目前只注册通用 /api/v1/skills、/sessions、/agent-evolution 等路由族，没有 causal-node/projection 的独立路由与 capability——不能默认 coforge daemon 已有读写该投影的权限。

➡️ 推荐答案：**archive 证据先落盘并作为唯一事实源；异步、幂等 projection worker 用 node_id + content_hash 发布和修复投影。投影置于独立 causal-experiences 命名空间，只含检索摘要、embedding、来源指针和筛选元数据；证据正文二次 ACL 校验。为 projection worker 和 daemon 增加显式读写 capability，不复用广义 /skills 写权限。**

---

❓ **Q12** - **proposal 的状态机、批准者和“采用”效用的因果语义是什么？**
“可检索”不等于“可批准”，“agent 在 prompt 中看见 proposal”也不等于“它导致了成功”。请给出不可省略的状态机（例如 draft → evaluated → approved | rejected | expired）并回答：
- 谁使 proposal 从 draft 进入 approved：人工 workspace owner、Agent Evolution evaluator、确定性 benchmark gate，还是组合？每个 gate 的输入、阈值和审计输出？
- draft/evaluated/approved 各自可否被检索？若可，能否用于：归因报告、生成 guidance、自动执行、更新 executable skill？分别回答。
- proposal 候选区写到哪：独立 proposals/ 命名空间、skill asset 内状态字段、还是 coforge 数据库？须支持 proposal UUID、来源 node IDs、版本、审批审计、TTL、拒绝原因。
- “采用”事件由谁写入？有效采用至少携带：proposal_id、consumer session/context、是否真的注入 guidance 或调用 skill、实验 arm、最终 outcome、时间戳？
- utility 聚合中，曝光、显式选择、实际执行、任务成功、后续纠错各是什么事件；只有哪种可作正向效用？如何防止 agent 自己生成 proposal 再声称采用（自证循环）？

代码依据：集成分支 route family 只有 /api/v1/skills 的读写与 validate，没有候选 proposal 的资源模型；若 proposal 与批准 skill 共用同一写接口，draft 很容易被普通 skill consumer 误当可执行资产。

➡️ 推荐答案：**候选 proposal 存独立、带 ACL 的 proposal 命名空间；只有 evaluator + workspace owner 明确批准才能发布 executable skill。draft 可用于带“未验证”标签的归因和人工/诊断 guidance，不可自动执行、不可更新 skill；采用只在实际注入或调用并有可关联 outcome 时写审计事件，正向 utility 至少要求“实际采用 + 可观测成功或无后续纠错”，曝光绝不计分。**

---

❓ **Q13** - **replay 的可执行性判定、执行者、预算和无-guidance 对照如何固定？**
“不同 skill 产生不同 guidance”需要把 replay 从概念变为可复现试验：
- 哪些任务可 replay：输入消息、工具调用定义、工具结果、工作目录/代码版本、凭据、外部依赖均可重建？具备哪些条件即判不可 replay？
- 判定由 OpenViking extractor、coforge daemon，还是调用方声明？判定结果和缺失条件写 node 还是 replay job？
- replay executor 是否明确是 coforge daemon 的隔离 worker？sandbox、网络策略、密钥策略、workspace/commit snapshot；失败时禁止对生产资源副作用？
- 每次诊断的硬预算：最大候选 skill 数、每 skill 最大 replay 次数、最大总分支数、每分支 token/工具调用/墙钟时限、全局并发上限。
- guidance 的生产函数：输入 {目标 node、失败轨迹、候选 skill revision、检索证据}，输出结构化 {guidance_id, instructions, cited_node_ids, cited_skill_revisions, confidence, limitations} 还是无结构文本？
- 无-guidance 对照与每个 candidate skill 配对，还是只跑一个基线？随机化/固定 seed、相同初始状态、相同预算如何保证？
- replay 成功、失败、超时、被 sandbox 阻止、guidance 与无-guidance 无差异，分别如何进入 utility 聚合？

➡️ 推荐答案：**仅当输入、代码/环境快照、工具契约和外部副作用可隔离或模拟时才 replay；由 coforge daemon 隔离 worker 执行。每次诊断至多 3 个 skill × 每个 1 个 guidance 分支 + 1 个无-guidance 基线；固定输入快照、seed 和预算。guidance 为带证据引用的结构化产物；仅在同初始状态、同预算下相对基线的成功改善可形成受置信区间约束的正向 utility。**

---

❓ **Q14** - **不可 replay 时 append guidance 的消息语义如何避免污染 Working Memory 和节点抽取？**
append 到 session 尾部会直接进入后续 commit 的原始消息流；下一轮 ov_wm_v2_update 会读已完成 archive 的 overview 并处理新消息。若 append 是普通 assistant/user 消息，可能被抽成当前事实、下一节点，甚至影响后续 proposal 的“采用”统计。请明确：
- append 时机：诊断结束立刻、当前 turn 正常回复之后、还是下一次用户输入之前？归属原 session、诊断专用 child session，还是独立 artifact stream？
- 消息角色与 schema：普通 assistant、tool、system，还是新增不可见 guidance event？至少含 guidance_id、proposal/node 引用、生成原因、可见性、TTL、是否已采用？
- WM extractor、key-step extractor、session skill extractor 是否默认过滤此类 event？若不过滤，什么规则保证“建议未来怎么做”不被写成“已经发生的状态事实”？
- 显式采纳后，采纳事实写原消息流、replay/proposal usage event，还是两者？纯 guidance 文本能否被再次检索、被其他 context“采用”并计 utility？
- guidance 过期、被拒绝或与后续真实行为冲突时，如何避免其作为陈旧 session 尾部内容持续注入？

➡️ 推荐答案：**append 为诊断结束后写入原 session 的专用、结构化 guidance event，不伪装成 assistant 对话；默认对 WM、key-step 和 skill extraction 全部过滤。只有显式 adoption event 才把 guidance 与后续行为/outcome 关联并计 utility；guidance 本身可作为带状态和 TTL 的诊断检索候选，但不能自动变成 skill 或事实。**

---

❓ **Q15** - **“原始 OpenViking / 修改后行为”开关的名称、作用域与数据迁移语义是什么？**
现有 memory.session_skill_extraction_enabled 已控制 session skill 抽取。若新开关只是另一个 boolean，会出现“旧 skill 抽取开、新轨迹节点关”“节点开、proposal/replay 消费关”等难解释组合；关闭后既有 projection 与 utility 也不能静默消失或继续影响检索。请确定：
- 开关名称和枚举值：如 memory.skill_trajectory_mode = legacy | causal，还是多个独立 booleans？
- 作用域优先级：全局默认、workspace 覆盖、session 固化快照，是否都需要？session 中途切换时，已有 archive 与新 archive 的行为如何标注？
- gate 哪些阶段：key-step/node 抽取、archive 证据写入、projection/index、检索召回、proposal 检索与审批、replay、guidance 生成、utility 聚合——全部同步切换还是可独立配置？
- 切回 legacy 后，已有 causal projection、proposal、usage、utility：保留但不消费、停止聚合、后台清理、还是立即删除？删除需单独保留策略与审计？
- 与 memory.session_skill_extraction_enabled 的关系：A. 新模式包含并强制开启它；B. 正交开关；C. 新模式替代它；D. legacy 用旧开关、causal 由新模式接管。

➡️ 推荐答案：**版本化枚举 memory.skill_trajectory_mode=legacy|causal，全局默认 → workspace 覆盖 → session 创建时固化；causal 模式统一 gate 节点抽取、投影、检索消费、proposal/replay/guidance 和统计，避免半启用的隐式组合。切回 legacy 保留历史数据和审计但停止新写入、索引消费与聚合；session_skill_extraction_enabled 在 legacy 下保持旧语义，在 causal 下由该模式接管并映射为受控的 Evolution 发布路径。**
