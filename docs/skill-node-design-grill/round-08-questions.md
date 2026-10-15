# Round 8（griller: kiro / gpt-5.6-sol，经中间人转达）——预测对比、并行诊断与想象分支生命周期

设计树状态：Q37–Q43 已确认（评估编排、可审计相似性、中心式可重叠簇、簇条件效用、有界路径参照）。本轮根问题：如何让跨树想象成为**可校准、可证伪、可失效并可恢复再诊断的假设层**，而不是自我强化的"预测记忆"。

❓ **Q44** - **并行子诊断 = 不可变简报 + ACL 隔离 map-reduce + 严格共享既有路径预算？**
确认：①先冻结不可变 diagnosis_brief（diagnosis_run_id、anchor、snapshot watermark、草稿 context、selected_evidence_refs、检索快照 index/embedding/cluster_edge revisions、policy_version、budget），不共享活会话；②主 agent 按已验证 cluster 或候选轨迹分片，派发 ≤3 个一次性 sub-diagnosis worker，各分析互不重叠分片；③worker 有效权限 = 主诊断 principal ∩ 被分配来源的 session/DAG ACL，不因拿到简报获得额外访问权，不留会话；④worker 只返回结构化产物（assessed_refs、相似性 verdict、关键异同、可迁移机制、反例、证据 refs、模型与 policy 版本、置信度）；⑤reduce 不按多数投票——逐条检查证据强度、约束冲突、ACL 可展开性，保留少数异议；⑥总预算不因并行扩张：仍 ≤12 轻量 branch 候选、≤3 条参照 path，禁止 worker 额度相加。

➡️ 推荐答案：确认全部。

---

❓ **Q45** - **想象分支的"自评置信度" = 可校准预测先验 + 簇条件模型选择与分歧标记？**
每条 imagined branch 的置信度必须明确预测的事件：**在可比较的同簇情境中，该分支是否会与后续实际轨迹在语义检查点上相符**。最小 schema：imagined_branch_id、fork/revision ids、evidence_basis_manifest_hash、cluster_refs（带 membership/edge revision）、forecast_contract_id、confidence_raw、confidence_calibrated（null 起步）、calibration_status（uncalibrated|calibrated|stale）、imaginer（model_version、prompt_policy_version、temperature、seed）、ensemble_manifest。
校准表按 {cluster_id, model_version, prompt_policy_version} 分桶，保存原始预测、可比性判定、三源结果、Brier、可靠性曲线、样本量、校准器版本。**该桶累计 ≥30 条真实交互的可比较结果后**，confidence_calibrated 才可用于排序；continuation/replay 只作辅助监测，不得填补 30 条真实门槛。未达门槛时 confidence_raw 仅用于展示、多样化采样和后续学习，**不得作为跨树检索、replay 投资或 proposal 晋升的排序权重**。
集成想象（有界双样本）：高价值/高不确定候选跑两个独立 imaginer（优先不同模型版本，退而不同 seed/temperature/prompt variant），分支分别保留不混合；语义检查点不一致写 disagreement 降权；一致也只是更强假设。

➡️ 推荐答案：确认。自评是"预测可比较未来语义结果"的原始先验，不是证据；校准后才成排序概率。采纳有界双样本集成与分歧标记。

---

❓ **Q46** - **预测—实际对比 = 版本化语义检查点判定 + 验证/惊讶/校准/效用/路由五类信号？**
每个 imagined branch 生成时冻结 forecast_contract：预期结果类别、关键中间状态谓词、动作类型序列/允许替代集合、失败模式、比较窗口、context 条件、rubric 与判定者版本。后续轨迹到达时先判可比性——跨树不匹配且 context 不同标 incomparable_context_shift，不计想象失败；可比时输出 match|partial_match|divergence|insufficient_evidence，带完整 provenance。三源质量系数：**真实交互 1.00 / guided continuation 0.60 / guided replay 0.35**，逐条保留原始来源。信号落点：①写簇条件校准表；②同簇真实 match = 想象分支验证通道一；③配对 replay 改善 = 通道二；④高质量可比 divergence 触发 surprise event → 自动生成受 ACL 保护、不可检索的浅层 fork 候选草稿（仍须 Q26 propose 才成 revision）；⑤guidance_utility_evidence；⑥cluster × model × policy 预测能力表供 imaginer 路由。惊讶阈值基于校准概率与结果严重度，不是"任何不一致都新建 fork"。

➡️ 推荐答案：确认。

---

❓ **Q47** - **假想分支变质由证据基础失效驱动（非时钟），以有效置信度与 supersede revision 表达？**
每条 imagined branch 保存 evidence_basis_manifest（所用 AO/DAG refs、cluster membership/edge revisions、检索与诊断快照、模型/policy、预测契约、已知验证结果）。触发变质评估的事件：新同簇真实轨迹 commit、相关 cluster 成员/边增删或替代、可比预测误差越过 surprise 阈值、证据被 redaction/tombstone/ACL 变更。普通时钟只可排队"复核"，不直接降可信度。状态与有效置信度：

```
fresh                 freshness = 1.0
needs_revalidation    freshness = 0.5
invalidated           freshness = 0.0
effective_confidence = calibrated_confidence × freshness_factor
```

任何调整创建不可变新 revision（supersedes_revision_id、invalidation_event_refs、新旧 manifest diff、判定版本）；旧分支保留为历史证据，禁止静默删除或改写。仅 fresh 且有校准置信度的分支可作稳定排序信号。

➡️ 推荐答案：确认。

---

❓ **Q48** - **以可恢复 diagnosis dossier（而非持久化 agent）承载增量再诊断、漂移审计与防自证回声？**
dossier（ACL 保护）至少含：anchor、最终 context、diagnosis_brief、检索候选与实际读取集、相似性判断、cluster/edge refs、每条想象分支及 evidence-basis refs、forecast contracts、校准快照、未决问题、当前 revision、supersedes 链、等待的新证据条件、已消耗预算、模型/policy 版本。增量再诊断四类触发：新同簇真实轨迹提交、相关 edge/membership 变更、预测误差超阈、证据 ACL 变化致 manifest 不完整。触发后服务端以旧 dossier + 事件 delta 重建一次性新 run，**重新获取来源 ACL**（不沿用旧授权）。增量预算：≤4 轻量候选、≤1 参照 path、模型/token ≤首诊 50%；delta 过大则显式排新完整诊断。新 run 优先换模型版本或 prompt/policy；只能同版本时必须标 same-model-continuation。判定翻转必须记旧/新模型与 policy 差异、delta、rubric、理由，形成新 revision。evaluator 独立性不变。

➡️ 推荐答案：确认。

---

❓ **Q49** - **"稳定的 imagination 才值得 replay" = 可审计稳定性资格与投资排序，不让想象直接成为 replay skill 来源？**
imagination 获得 replay_investment_eligible 须**同时**满足六门槛：①calibration_status = calibrated 且 effective_confidence ≥ 0.70；②freshness = 1.0 无待处理失效事件；③所在簇 ≥3 条来自 ≥2 个独立 session 的真实可比证据；④最近 3 次相关证据变化事件均未造成语义结论翻转；⑤通过独立 imaginer 双样本检查（或带 disagreement 降权标记）；⑥来源与证据本次仍过 ACL、Q30 七步 eligibility、Q43 路径限制。资格分数 = 有效校准置信度 × 稳定性 × 同簇真实证据量 × 预期 replay 信息价值，用于决定已批准预算投向哪些**既有合规 skill revision**。不改变 Q43：replay 候选 skill 仍只能来自真实正向效用 branch 所用 revision；想象只影响"优先验证哪个候选"。验证双通道：同簇真实吻合 **或** 配对 replay 改善 → validated；都无则仍是 hypothesis；任一通道都不等于 skill 晋升，晋升权仍属 evaluator。

➡️ 推荐答案：确认。

---

## 总账增量（34–39，全部待确认）

| # | 决策 | 落点 |
|---:|---|---|
| 34 | 并行子诊断 | 不可变 brief、ACL 分片、一次性 map-reduce、总预算不扩张。 |
| 35 | 想象置信度与集成 | 簇条件可校准先验；30 条真实结果后才可排序；有界双样本集成。 |
| 36 | 预测—实际对比 | forecast contract、三源系数 1.00/0.60/0.35、五类信号落点。 |
| 37 | 想象变质 | 证据基础失效而非 TTL；effective_confidence；supersede。 |
| 38 | 可恢复再诊断 | dossier 取代活 agent；四类触发、增量预算、漂移审计、防自证。 |
| 39 | 稳定性与 replay 投资 | 六门槛资格、双验证通道、只影响投资排序。 |
