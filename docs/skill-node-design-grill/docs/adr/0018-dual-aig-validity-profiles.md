# AIG 图有效性采用 paper_exact 与 production_grounded 双 profile

论文的 `Phi(G)` 只明确要求连通、无环、唯一 task 根和唯一 conclusion 汇，并未规定有向图的 connectivity 具体语义；它是结构可采纳谓词，不验证节点字段忠实性、inheritance/effect 真伪或最终责任归因。为避免把论文评测约束强加给持续、并发的群聊事实图，采用两个版本化 validator profile。

`validator_profile=paper_exact` 仅用于论文复现与评测 adapter：检查论文列出的四项条件，且把 benchmark 所采用的 connectivity 解释与 policy/version 一并冻结，未知时不得宣称 exact reproduction。`validator_profile=production_grounded` 用于生产 L2 Influence View：只在视图内加入虚拟 task root 和 observed-outcome sink，要求无环、底层弱连通及 root→sink 可达，并验证 block/claim evidence refs 存在且在 pinned watermark 内、content hash 一致、调用 principal 具备 ACL、source 时序不晚于 target、跨 omitted range 使用显式 skip。两种 profile 均不得修改 L1 Interaction DAG；结构通过也不得自动把 Claim、Fork 或 EvidenceBridge 标为证据已验证。
