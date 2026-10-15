# Round 4 答复（设计者原话，中间人整理）

- **Q22（设计者口中的 q17）：架构转向——按需构造，取消数量上限**（原话）："台账（流水账）默认建立，但 trajectory node 由诊断 agent 看台账（分页查看，必要时可让 agent 自己选择是否看原文），然后定位有问题的或者可进一步改进的决策状态点，在这些状态点构造 trajectory node（**或者叫 fork node 会更好些**），所以我理解 fork node 本身就是稀疏的，不需要限制数量。"
  要点：
  1. 台账随 commit 默认建立（不变）；
  2. **fork node 由诊断 agent 在诊断时按需构造**：分页读台账，必要时下钻原文，定位"有问题的或可进一步改进的决策状态点"，在该点构造节点（含七段快照）；
  3. 稀疏性来自按需构造，**不设数量上限**；
  4. 命名改为 **fork node**（取代 trajectory node）。
- **Q23: B** —— causal context 诊断时回溯选定，可包含节点之后发生的 AO pair（hindsight 归因）。
- **Q24: A** —— 想象分支生成完整 AO 序列（含合成 observation，逐条标"想象"，检索排序低于真实分支）。
- **Q21 daemon 判定协议：设计者未明确确认**（问了机制后未回复确认/异议）——Round 5 需一句确认。

## 此转向强制引发的联动问题（Round 5 必须收口）

1. **被取代的决策**：commit 时抽取关键步骤（原设计、Q3 资格判定、Q17 合并示例）全部作废或降级为诊断 agent 的选点指南；WM 抽取不再产出节点（.overview.md 语义回到原样，反而简化）。
2. **存储位置冲突**：Q19 已决"archive 证据不可变、.done = 证据已提交"——诊断期构造的 fork node 不能再写进已 .done 的 archive；只能进 causal-experiences 命名空间（带指回台账 AO ID 的指针），或修订 .done 契约。
3. **节点身份与去重**：同一台账分叉点被多次诊断命中时，是复用同一 fork node（追加分支/统计）还是新建？共现统计与 skill 合并依赖稳定的节点身份。
4. **新写入者**：诊断 agent 现在是写者（构造 fork node、分支、可能还有 proposal）——它的写权限、写路径（直写投影命名空间还是走 outbox）、幂等键需要定。
5. **台账必须记录 skill 调用**：fork node 的 used_skills[]（skill_uri + revision_hash）只能在诊断期从台账回填——台账条目必须带 skill 调用信息，否则 Q18 的引用格式落空。
6. **台账读取 API**：分页查看 + 按需下钻 messages.jsonl 原文，是诊断 agent 的新接口需求。
