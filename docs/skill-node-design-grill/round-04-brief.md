# Round 4 派发指令（griller 续轮）

你仍在"设计拷问 griller"角色中。设计者已确认大部分 Round 3 问题；frontier 已很小，本轮可能是最后一轮。

## 先读这七个文件（绝对路径）

1. `/home/zhoujie22/river2_0/skill-node-design-grill/brief.md`
2. `/home/zhoujie22/river2_0/skill-node-design-grill/round-01-questions.md`
3. `/home/zhoujie22/river2_0/skill-node-design-grill/round-01-answers.md`
4. `/home/zhoujie22/river2_0/skill-node-design-grill/round-02-questions.md`
5. `/home/zhoujie22/river2_0/skill-node-design-grill/round-02-answers.md`
6. `/home/zhoujie22/river2_0/skill-node-design-grill/round-03-questions.md`
7. `/home/zhoujie22/river2_0/skill-node-design-grill/round-03-answers.md` —— 最新决策：AO 台账 (a) 已决、Q16/18/19/20 已确认、Q17 待第三次重问、Q21 有反问、两个子问题未答。

## Round 4 任务（按优先级）

1. **正面回答设计者的反问**："daemon 创建 replay job 时如何判定可否 replay"。不能再说"daemon 判定"一句话——要给出具体判定过程：daemon 在创建 job 时拿哪些输入（AO 台账里记录的工具调用清单、工具注册表的副作用分类、workspace 快照可用性、mock/白名单覆盖情况、凭据需求……），按什么顺序检查什么条件，哪条不满足即判不可 replay，判定结果与缺失项写到哪（replay job 元数据）。这是回答不是提问；回答完可以用一个确认问句收尾。
2. **Q17 第三次重问，剥到最简**：先声明"(a) 已决，台账不设上限"，然后只剩一个决定：一个 archive 最多允许几个带七段快照的节点（一个数字），以及超额时是否按"不可逆变更 > 失败纠正 > 诊断/计划转折 > 其他"的顺序保留。用大白话 + 直接选择题，禁止再出现 message_span、审计等词。
3. **问两个未答子问题**：
   - causal context 的选定者与时机（commit 时 extractor 选定后不可变 vs 诊断时回溯选定），以及是否强制只引用严格更早的 AO pair。
   - 想象分支是否包含想象出的 observation（完整 AO 序列含合成观测 vs 仅动作序列），并说明这对 branch 检索文本与成本的影响。
4. 若你认为 frontier 还剩别的，可以最多再补一问；若没了，在结尾明确声明"设计树已走完，无剩余 frontier"。

## 输出要求

1. 中文 markdown，标题 `# Round 4`，开头 2 行以内：设计树状态。
2. 问题编号从 **Q22** 起接续；对 Q21 反问的"回答"放在问题之前、标题为 `## 回答：daemon 如何判定可否 replay`。
3. 总问题数 3–5 问；格式照旧 `❓ Qn - <标题>` + `➡️ 推荐答案：...`。
4. 只读，禁止修改文件；结尾无无关内容。
