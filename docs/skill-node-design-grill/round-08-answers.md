# Round 8 答复（设计者，中间人整理）

- **Q44–Q49：全部按推荐确认**（设计者原话："以上按你建议"）。含：
  - Q44：并行子诊断 = 不可变 diagnosis_brief + ≤3 一次性 worker + 权限交集 + 证据归并（非投票）+ 总预算不扩张（≤12 候选 / ≤3 path）。
  - Q45：置信度 = forecast_contract 锚定的可证伪预测先验；簇×模型×策略桶 ≥30 条真实可比结果后校准才可排序；有界双样本集成 + disagreement 降权。
  - Q46：预测-实际对比按语义检查点；三源系数 1.00 / 0.60 / 0.35；incomparable_context_shift 先判；五类信号落点（校准、双验证通道、惊讶→浅层 fork 候选、guidance 效用、簇级模型路由）。
  - Q47：变质由证据基础失效驱动（新同簇轨迹 / 簇变更 / 预测反证 / ACL 变化）；fresh 1.0 / needs_revalidation 0.5 / invalidated 0.0；effective = calibrated × freshness；supersede 不删。
  - Q48：可恢复 diagnosis dossier 取代活 agent；四类事件触发增量 run、重新过 ACL；增量预算 ≤4 候选 / 1 path / ≤首诊 50%；优先异模型续诊；判定翻转变新 revision；evaluator 独立性不变。
  - Q49：replay 投资六门槛（校准且有效置信度 ≥0.70、fresh、簇内 ≥3 真实证据来自 ≥2 session、近 3 次证据事件未翻转结论、双样本通过或降权、本次过 ACL/七步/路径）；想象只影响既有合规候选的投资排序；验证双通道（同簇真实吻合 或 配对 replay 改善）；晋升权仍属 evaluator。

**Round 8 后 frontier 再次清空。**产出更新：CONSENSUS.md 并入总账 27–39 与新架构节；新增 ADR-0007/0008/0009；CONTEXT.md 补假设层术语。
