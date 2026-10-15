# Round 3 派发指令（griller 续轮）

你仍在"设计拷问 griller"角色中。设计者答复了 Round 2 的一部分，另有四问因概念不清未答，并对 Q14 提出两个反问。

## 先读这五个文件（绝对路径）

1. `/home/zhoujie22/river2_0/skill-node-design-grill/brief.md` —— 角色定义、设计全文、OpenViking 已核实事实。
2. `/home/zhoujie22/river2_0/skill-node-design-grill/round-01-questions.md`
3. `/home/zhoujie22/river2_0/skill-node-design-grill/round-01-answers.md`
4. `/home/zhoujie22/river2_0/skill-node-design-grill/round-02-questions.md`
5. `/home/zhoujie22/river2_0/skill-node-design-grill/round-02-answers.md` —— 设计者本轮答复、未决项清单、以及**中间人已向设计者解释过的四个概念**（Q9 例子、Q10 稳定 URI、Q11 投影协议、Q13 隔离 worker）。

## Round 3 任务

**最高优先级：正面回答设计者对 Q14 的两个反问。这是设计走向的分水岭，不是普通追问：**

1. 检索入口到底是哪些对象：trajectory node 的 context（七段状态）进检索，未来分支（含想象分支）也进检索吗？分别用什么文本做 embedding？
2. 设计者认为 guidance 应该是未来分支的一个组成部分，质疑"guidance 独立进检索"的意义。你要么给出具体、可操作的用例证明 guidance 独立可检索的价值（什么场景下会单独搜 guidance 而不是搜分支/节点），要么承认设计者的结构更对（guidance 只是分支的字段，检索入口只有节点与分支），并相应修正你 Round 2 Q14 的推荐。不许和稀泥。

**其余 frontier：**

- **Q9 重问**：基于 round-02-answers.md 里那个 8 步例子重问，让设计者直接对着例子拍板：上限数字、砍留优先级、第 1/4 步是否合并、砍掉的步骤去向。
- **Q10 重问**：设计者已理解"稳定 URI vs 不可变节点"。重问表示模型 A/B/C + used_skills[] 引用规则（主键形式、有序性、是否记 revision hash）。
- **Q11 重问**：基于①证据②投影的流水线讲法重问：.done 与投影失败的契约、幂等键、投影内容范围、独立命名空间还是混入 skills、二次 ACL。
- **Q13 重问**：设计者已理解隔离 worker。重问：可 replay 的判定条件与判定者、sandbox 边界、每次诊断预算数字、guidance 生产函数的输入输出结构、无 guidance 基线的配对方式。
- **Q12 已决**（evaluator 单独批准）：可以有一个不超过一小段的追问空间（如 evaluator 误批的纠偏、evaluator 自身由什么构成），但不要重新审理已决结论。
- **Q15 已决**：不要再问。

## 输出要求

1. 中文 markdown，标题 `# Round 3`，开头 3 行以内：设计树状态一句话 + 本轮 frontier 概述。
2. 问题编号从 **Q16** 起接续。格式 `❓ Qn - <标题>` + 正文 + `➡️ 推荐答案：...`。
3. **第一个问题必须是 Q14 的两个反问**（可拆成一或两问），你的回答要给出明确立场再问设计者确认。
4. 重问 Q9/Q10/Q11/Q13 时直接引用例子、给选项，不要复述 Round 2 原文的术语堆砌。
5. 总数 6–9 问；依赖本轮其他问题答案的不许出现。
6. 只读，禁止修改文件；结尾无无关内容。
