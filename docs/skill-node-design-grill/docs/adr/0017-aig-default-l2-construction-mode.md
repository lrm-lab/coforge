# Interaction DAG 保持 L1 权威事实，AIG 作为默认 L2 Influence View 构建模式

采用分层融合而非替换或三图独立并行：L0 AO/raw evidence 与 L1 Segment/Interaction DAG 继续记录运行时权威事实；论文 IG 和 AIG 均作为 L2 Influence View 的构建模式，共用 InfluenceBlock/InfluenceClaim、冻结、grounding 与检索投影契约；L3 Fork/Branch/Guidance 的长期因果记忆职责不变。

默认 `construction_mode=adaptive_agentic_aig`。每条 causal/evaluation 轨迹 commit 后均异步构建 post-run AIG，覆盖成功与失败；失败诊断再派生或独立构建 query-specific AIG/DIV。队列优先级为 evaluation > 失败轨迹 > 成功轨迹，构图失败不影响 L0/L1 轨迹归档。AIG Builder 在固定 watermark 的同一 L0/L1 证据快照上从空图开始，不先构建或读取 IG，以避免固定节点边界与单遍影响边造成锚定偏差。IG 保留为可显式选择的 `fixed_partition_single_pass_ig` 非默认模式，用于低成本构建、评测基线和 AIG 消融；AIG 失败时不自动改跑 IG。服务端确定性生成的最小 `fallback` 是第三种模式，不得标记为论文 IG。AIG/IG 产生的影响边均为待核验解释，不得改写 Interaction DAG 或自动晋升为全局 EvidenceBridge/Fork 事实。
