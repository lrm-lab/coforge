# Round 2 派发指令（griller 续轮）

你仍在"设计拷问 griller"角色中。本轮是 Round 2：设计者已答复 Round 1 的全部 8 问，并新增了 4 条需求和 1 个行为开关要求。

## 先读这三个文件（绝对路径）

1. `/home/zhoujie22/river2_0/skill-node-design-grill/brief.md` —— 你的角色定义、工作方式、被拷问设计全文、OpenViking 已核实事实、可读代码清单。
2. `/home/zhoujie22/river2_0/skill-node-design-grill/round-01-questions.md` —— Round 1 的 8 个问题原文。
3. `/home/zhoujie22/river2_0/skill-node-design-grill/round-01-answers.md` —— 设计者的逐条答复、新增需求、以及 feat/ov-cm-implementation 集成分支的现状事实（中间人代查，你上轮无法运行 git）。

## Round 2 必须覆盖（重算 frontier 后组织，不要求逐条对应一个问题）

- **Q3 残留**：设计者只答了资格判定（B），每 archive 数量上限与超额降级策略仍开放。
- **Q4/Q6 新张力**：设计者让 proposal 可被检索、被其他 context 采用时记效用——但"谁批准 proposal"从未被回答。采用事件是事实信号还是批准门槛？未批准 proposal 能否影响归因、guidance 生成、自动执行？proposal 候选区写到哪（注意集成分支已有 `apps/web/src/server/openviking/catalog/route-family-memory-skill.ts`）？
- **Q1=C 的落地代价**：扩展 skill schema 具体加哪些字段？现有消费者（`OpenViking/openviking/session/skill/dedup.py`、`session_skill_context_provider.py`、skill_operation_updater.py）如何不被破坏？节点记录"使用的 skill"时 skill 标识用什么（viking://~/skills URI？UUID？）、一个节点用多个 skill 怎么办？
- **新增需求：replay 与 guidance**。可 replay / 不可 replay 的判定标准是什么？replay 的执行者是谁（coforge daemon 侧？）、预算多少？guidance 由谁生成、输入输出是什么形态？无 guidance 对照分支的目的是什么（效用 A/B 归因？），结果怎么进 utility 统计？
- **新增需求：不可 replay 任务的 guidance append 语义**。何时 append（诊断后立即？turn 结束？）？在消息流里是什么角色的一条记录？会不会污染下一次 commit 的 Working Memory 抽取和轨迹节点抽取（对照 brief.md 里 ov_wm_v2 的行为）？append 的 guidance 本身可否被"采用"并记效用？
- **行为开关**：切换"原始 OpenViking 行为 / 修改后行为"的开关叫什么、粒度（全局 / 每 session / 每 workspace）？它 gate 哪些环节（仅抽取？投影与索引？检索消费？guidance 生成）？切换后已产生的投影/统计数据保留还是清理？与现有 `memory.session_skill_extraction_enabled` 是什么关系（叠加、互斥、包含）？

## 输出要求

1. 中文 markdown，标题 `# Round 2`，开头不超过 4 行：一句话更新设计树状态（哪些已定、本轮 frontier 是什么）。
2. 问题编号**接续 Round 1，从 Q9 开始**。格式 `❓ Qn - <标题>` + 正文（可给选项）+ `➡️ 推荐答案：...`。
3. 6–10 个问题，按依赖顺序；凡依赖本轮其他问题答案的，留给后续轮。
4. 鼓励引用 brief.md 与 round-01-answers.md 中的代码/集成分支事实作为依据；可以再读代码核实。
5. 只读，禁止修改任何文件；结尾不要无关内容。
