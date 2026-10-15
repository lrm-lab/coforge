# Round 7 派发指令（griller 续轮——拷问终结后的三项增补设计）

你仍在"设计拷问 griller"角色中。Round 6 后设计树已清空并产出共识文档；随后设计者与中间人进行了增补讨论，确定三项新增/修订设计，frontier 重新打开。本轮拷问这三项的落地协议。

## 先读这些文件（绝对路径，均在 /home/zhoujie22/river2_0/skill-node-design-grill/ 下）

brief.md；round-01 至 round-06 的 questions/answers 共 13 个文件；CONSENSUS.md（终版共识，含 26 条决策总账）；CONTEXT.md（术语表）；docs/adr/0001 至 0006。

## 三项增补设计（设计者已表态，按此拷问）

### A. 评估编排对齐
fork node 提交成功后触发"评估编排"流水线：第一步是 daemon 七步 replay 判定（不可行 → guidance append 路径）；replay 结果与归因报告进入 proposal；evaluator 在下游审批。evaluator 不做 replay 判定，但由 fork node 触发的流水线包含它。（设计者对中间人提出的此合并未提异议，需正式确认。）

### B. 候选提议—草稿 context—检索—验证—跨树簇（设计者修订后的怪圈解法）
原中间人方案是"机械信号预筛候选 + 两阶段检索"；设计者修订为**全 agent 驱动**：
1. 诊断 agent 读台账（Q28 分页 + 下钻），**提议**某些中间状态为关键 fork node 候选；
2. 为候选生成 causal context（草稿）；
3. 用该 context 检索相似跨树 context（检索目标 = 已存 fork node / branch 的 context_for_retrieval）；
4. **agent 判断**检索到的 context 是否真正一致或相似（语义验证，不信 embedding 余弦）；
5. 连接验证通过的相似 context，**形成跨树簇**。

### C. 跨树 path 参照（设计者认可中间人方案）
检索入口允许以 draft context 直查 branch；补路径展开 API（expand_branches / 有界 walk_path，路径 = node-branch 链，全走既有 ACL）；evidence_role 枚举增加 `analogue_basis`；参照排序用效用统计加权（真实且正向效用 > 真实无记录 > 已验证想象 > 未验证想象）、top-k 强制多样性、每次诊断参照 path 数量有上限；replay 的候选 skill 来源可为"相似 context 下带正向效用的分支所用 skill"。

## Round 7 任务（问题从 Q37 起编号）

1. **A 项**：一个确认问题（评估编排的触发点、失败路径、与 Q26 propose 链路的衔接）。
2. **B 项**（重点）：
   - 候选提议的预算与节流：每次诊断 run 提议几个候选？草稿 causal context 的深度（全七段还是浅层）？被验证否决或未成 fork 的候选怎么处理（丢弃 vs 留痕进 provenance）？
   - 草稿 context、检索结果、验证判断是否全部持久化为 fork-node revision 的 provenance（可审计"当时看见了哪些相似案例、为何判定相似/不相似"）？
   - **相似性判定标准**：一致性维度（任务/目标、状态、失败模式、所涉 skill？）；判定记录的必备字段（judged_by 模型版本、criteria、confidence、时间）；判"不相似"的处置（负样本记录用于改进检索？）。
   - **跨树簇的形式化**：cluster 是 causal-experiences 中的新对象（cluster_id + 成员 fork_node_id + 验证过的相似性连接边，边带判定 provenance）；相似性**非传递**（A~B、B~C 不保证 A~C）——连通分量式 vs 中心式？合并/拆分策略？cluster_id 何时铸造、如何稳定？
   - 簇的维护走 Q26 模式（agent propose 连接边 → 服务端验证 schema/ACL → 原子提交）？
3. **C 项 + 联动**：
   - **簇与 Q7 统计的关系**：原设计的"共现统计用于合并 skill"是否升级为"簇成员关系 + 连接边"？效用统计是否落成**簇条件效用**（"在这类决策情境下该 branch/skill 的效用"），全局效用降为簇效用的聚合视图？
   - 簇与 skill 晋升：ADR-0001 说 Evolution 从"已批准节点簇"发布 executable skill——簇形式化后，proposal 的生成是否定义为"簇内带正向效用证据的分支模式"？
   - 路径展开 API 的最小契约与预算上限。
4. 末尾给"总账增量"小表；若 frontier 清空则声明终结。

## 输出要求

中文 markdown，标题 `# Round 7`，开头 2 行设计树状态；4–7 问；格式照旧 `❓ Qn - <标题>` + `➡️ 推荐答案：...`；只读；结尾无无关内容。
