# Round 3 答复（设计者原话，中间人整理）

- **底层模型（原 Q9/Q17 议题）：已决 (a) 台账全覆盖 + 节点稀疏**——每个 action-observation pair 进密集台账（廉价摘要，observation 可走确定性 synopsis），仅关键 action（Q3=B 资格）成为稀疏 trajectory node（带七段快照 + causal context 引用 + 未来分支）。设计者原话见下一条记录。
- **Q16: 确认** —— 检索入口固定为 trajectory node 与 future branch 两类；guidance 永远是 branch 的字段，不独立建索引对象；node 检索文本用规范化七段 context，branch 检索文本用"父状态摘要 + 动作 + 结果 + guidance 摘要"；真实与已验证想象 branch 可检索且按 evidence_status 可区分。
- **Q17: 未决（设计者仍表示没太懂）** —— 需要第三次重问：剥离一切术语，只剩"每 archive 节点数上限（一个数字）+ 超额砍留顺序认不认"。注意 (a) 已决后台账不设上限，需要定的只有稀疏节点数。
- **Q18: 确定** —— 选 A：trajectory node 是独立、不可变证据 asset（node_id + content_hash 主键）；Evolution 维护可更新 executable skill 的稳定 URI；used_skills[] 为按实际调用顺序排列的 {skill_uri, revision_hash, invocation_id?}。
- **Q19: 确定** —— 四项全确认：.done 只代表证据落盘；投影由 outbox/ledger 驱动、node_id+content_hash 幂等；投影在独立 viking://~/causal-experiences/ 保持轻量；检索先 ACL 过滤、读 archive 全文二次授权。
- **Q20: 确定** —— evaluator 为版本化、独立于 proposal 生成模型的评估组件，保存 evaluator_version、输入 node/branch IDs、测试样本版本、对照结果、阈值、理由、时间戳；生成方不得自评自批；第一版 = 确定性 schema/安全校验 + 固定 replay/benchmark 阈值。
- **Q21: 部分接受 + 反问** —— 设计者问：**daemon 创建 replay job 时如何判定可否 replay**（要求给出具体判定机制，而非"daemon 判定"一句话）。griller 需正面回答判定过程：daemon 拿什么输入、按什么清单检查、什么条件判死、结果写到哪。

## 仍未回答的两个子问题（Round 4 必须问）

1. causal context 的选定者与时机：commit 时 extractor 一次选定（不可变），还是诊断时回溯选定？是否强制只引用严格更早的 AO pair（防因果倒置）？
2. 想象分支是否包含想象出的 observation（imagination 生成完整 AO 序列含合成观测，还是只生成动作序列）？这决定 branch 检索文本和成本。

## 设计者历史原话（AO 模型）

"先总结每个 action observation pair，之后的每一个 action（trajectory node）基于之前的某些 action observation pair 序列（causal context）和未来由当前 context 情况下未来的不同 action observation pair 序列。"

## 中间人补充事实

`OpenViking/openviking/session/tool_result_synopsis.py` 是**确定性、无 LLM** 的工具结果摘要器（对 json/csv/yaml/xml/code/text 生成 kind/title/summary/structure/notable_items/sample），配合 `tool_result_store.py`（外置大工具输出）。含义：AO 台账的 observation 半边已有现成廉价机制，不必逐对过 LLM。
