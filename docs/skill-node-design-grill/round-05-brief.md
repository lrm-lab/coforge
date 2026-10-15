# Round 5 派发指令（griller 续轮——转向后的收口轮）

你仍在"设计拷问 griller"角色中。设计者在 Round 4 做出一个重要架构转向：**fork node 由诊断 agent 按需构造，不在 commit 时抽取，不设数量上限**。这个转向让部分已决协议需要修订，frontier 重新打开。本轮目标：收口转向引发的全部联动问题，然后真正终结设计树。

## 先读这九个文件（绝对路径）

1. `/home/zhoujie22/river2_0/skill-node-design-grill/brief.md`
2. `round-01-questions.md`、3. `round-01-answers.md`
4. `round-02-questions.md`、5. `round-02-answers.md`
6. `round-03-questions.md`、7. `round-03-answers.md`
8. `round-04-questions.md`、9. `round-04-answers.md`（在 `/home/zhoujie22/river2_0/skill-node-design-grill/` 下）——最新转向、Q23=B、Q24=A、六个联动问题清单都在第 9 个文件。

## Round 5 任务

1. **先输出一张"转向后的决策总账"**（不是问题，是陈述）：逐条列出被取代/降级/保留的既有决策（如：commit 时关键步骤抽取→作废，Q3 资格判定→降级为诊断 agent 选点指南，Q17 合并示例→作废，Q18/Q19/Q16 哪些字段与契约在新模型下依然成立、哪些需改写）。这张总账是最终共识文档的骨架，必须准确。
2. **就六个联动问题逐一提问**（可合并为 4–6 问）：
   - fork node 存哪里（不能写已 .done 的 archive → causal-experiences 命名空间 + 指回台账 AO ID？还是修订 .done 契约）；
   - 同一分叉点被多次诊断命中的身份与去重（复用追加 vs 新建；共现统计依赖稳定身份）；
   - 诊断 agent 作为新写入者的权限与路径（直写投影 or 走 outbox；幂等键）；
   - 台账条目必须记录 skill 调用（skill_uri + revision_hash）才能回填 used_skills[]——确认这一强制要求并定字段；
   - 台账读取 API（分页 + 下钻原文）的最小契约；
   - Q23=B 之下"hindsight 归因"与"当时决策依据"的区分标注（防解读混淆）。
3. **收一句确认**：Q21 的 daemon 七步判定协议是否就此定案（设计者上轮未回复确认）。
4. 结尾若 frontier 真的清空，明确声明终结。

## 输出要求

1. 中文 markdown，标题 `# Round 5`：先"决策总账"（表格或分条），后问题。
2. 问题编号从 **Q25** 起接续；3–6 问；格式照旧 `❓ Qn - <标题>` + `➡️ 推荐答案：...`。
3. 只读，禁止修改文件；结尾无无关内容。
