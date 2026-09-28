# 想象分支的置信度是可证伪预测的先验，须经预测-实际对比校准后才可用作排序权重

设计者要求想象路径携带 LLM 自评置信度、并对比预测与实际未来轨迹。但 Q7 已拒绝无校准自评，且路径级精确匹配不可行（工具参数、命名、绕路必然不同）。决定：每条想象分支生成时冻结 forecast_contract（预期结果类别、关键中间状态谓词、动作类型序列/允许替代集合、失败模式、比较窗口、判定 rubric 版本）——置信度锚定的是"同簇可比情境中该分支是否与实际轨迹在语义检查点上相符"这一可证伪事件。对比判定输出 match/partial_match/divergence/insufficient_evidence，context 不同先判 incomparable_context_shift；三类未来轨迹来源固定质量系数：真实交互 1.00、guided continuation 0.60、guided replay 0.35。按 {cluster × model_version × policy_version} 分桶累积对比记录，攒满 30 条真实交互可比结果后才产生可用于排序的校准置信度（continuation/replay 不得凑数）。

一次对比同时产出五类信号：簇条件校准表、想象分支的验证通道一（同簇真实吻合；通道二是配对 replay 改善——两条通道把 Q6 悬空的"经验证才持久化"具体化）、surprise event（高质量可比 divergence 自动生成浅层 fork 候选草稿）、guidance 效用证据、簇级模型预测能力表（指导 imaginer 路由）。高价值候选可跑有界双样本集成想象，分歧记 disagreement 降权，共识不冒充真实分支。
