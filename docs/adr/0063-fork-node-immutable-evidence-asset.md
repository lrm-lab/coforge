# Fork node 是不可变因果证据资产，executable skill 由 Agent Evolution 独占发布

设计者最初要求"扩展 skill schema 使每个 skill 兼作轨迹节点"。经拷问确定双层结构：fork node（诊断 agent 按需构造的决策分叉点证据：七段快照 + causal context + 分支 + used_skills）是**独立、不可变**的资产，身份由稳定锚点派生、以 revision 追加演进；而可执行 skill 保持**稳定 URI、可演化**，仅由 Agent Evolution 从已批准的节点簇/评估结果发布与更新。诊断 agent 只能经 propose 路径提交，不获发布权。

## Considered Options

- 每个节点是一份不可变 skill asset、Evolution 另管 executable skill（**选定**）。
- 一个 skill 资产内挂 trajectory_nodes[] 版本数组（否决：现有 SkillOperationUpdater/dedup 按 SKILL.md 全文 merge 与去重，嵌套版本会被 merge 链路破坏并误去重）。
- 完全不改 schema、节点只存 archive（否决：sessions 树不进检索索引，节点将不可发现）。
