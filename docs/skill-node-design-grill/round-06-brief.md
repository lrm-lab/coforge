# Round 6 派发指令（griller 续轮——两个特殊情况的收口）

你仍在"设计拷问 griller"角色中。设计者确认了 Q26–Q30 全部推荐，Q25 基本同意但追加两个特殊情况：**跨 commit 的 causal context / 当前状态 fork node**，以及**群聊多 agent 的 segment / interaction DAG**。frontier 因此重新打开，本轮收口它们。

## 先读这些文件（绝对路径，均在 /home/zhoujie22/river2_0/skill-node-design-grill/ 下）

brief.md、round-01 至 round-05 的 questions/answers 共 11 个文件。最新决策与两个特殊情况引发的开放问题清单在 `round-05-answers.md`。

## Round 6 任务

就以下议题提问（可合并为 4–7 问），每问给推荐答案：

1. **ao_id 作用域与跨 commit 台账读取**：ao_id 的唯一性作用域（session 级？）；list_ao_ledger 跨多 archive 的 watermark/分页语义（已 .done 的 archive 集合 + 活会话边界如何联合成稳定快照）；causal context、guidance、想象分支引用跨 commit AO 时的 provenance 必备字段（archive 归属、commit 水位）。
2. **"当前状态 fork node"**（不可 replay 场景）：锚点定义（不能是历史 ao_id 时用什么）；对未提交活会话 AO 证据的引用如何处理（commit 后 id 固化/回填）；随会话推进的时效（锚定即冻结 vs revision 跟随当前水位）；它与已定的"guidance append 到 session 尾部"路径如何衔接。
3. **segment 的权威定义**：agent 发送与接收是否各自产生边界（同一消息双视角）；segment 与 AO 台账的关系（群聊消息是否作为 AO pair 记入各 agent 台账；接收是否构成 observation）；segment id 与去重。
4. **interaction DAG 的构造与存储**：节点与边的精确定义；何时构造（实时增量 vs 诊断时推导）；存储位置（causal-experiences？群聊通道的会话存储？）；与 AO 台账/id 体系的关系。
5. **跨 agent 可见性的 ACL**：诊断 agent 沿 DAG 边查看其他 agent 历史的权限作用域（群聊级授权 vs 逐 session 授权）；与 Q28 已定的"来源 session ACL 为权威"如何统一。
6. **DAG 遍历 API 与 fork node 锚定**：是否需要 traverse_interaction_dag 类接口；fork node 能否锚定跨 agent 的 DAG 边/segment（多 agent 协同决策点），若能，anchor 键怎么定义。

## 输出要求

1. 中文 markdown，标题 `# Round 6`，开头 2 行设计树状态。
2. 问题编号从 **Q31** 起接续；4–7 问；格式照旧 `❓ Qn - <标题>` + `➡️ 推荐答案：...`。
3. 末尾给一小节"总账增量"：把两个特殊情况导致的既有决策修订列成 3–6 行的表。
4. 若收口后 frontier 清空，明确声明。
5. 只读，禁止修改文件；结尾无无关内容。
