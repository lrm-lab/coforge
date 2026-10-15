# Skill 安全隔离与普通负效用采用双通道治理

Q129-A 决定：skill revision 的在线资格硬门与效果排序不得压成单一总分。可信的严重安全事件、权限越界、provenance integrity 破坏、明确撤销或 executable incompatibility 单次即可触发 `quarantined`，使 revision 立即退出在线检索与执行候选；普通 utility、热度或时间衰减不能抵消该状态。解除必须来自显式授权重验、修复后的新 revision 或版本化治理 transition，不能等待旧事件自然过期。

普通任务失败、低收益、用户纠正或未履行 guidance 不直接 quarantine。它们作为带 attribution grade 的负向 utility evidence 更新 posterior；只有达到最小有效样本与置信阈值后才降低 exploitation 排名。降级与恢复采用不同阈值和最小驻留条件形成 hysteresis，防止少量噪声使 revision 在 active/低排之间反复震荡。

skill-utility/Q133-A 决定直接触发权：只有版本化服务端 verifier、安全策略、权威撤销事件或授权管理员可以提交生效的 quarantine transition。Memory Agent、Diagnosis、Builder/Critic/Refiner/Reader 与普通 task agent 只能提交带 evidence refs 的 quarantine proposal；服务端校验主体权限、来源完整性、ACL、policy version 与幂等键后决定 transition。Utility aggregator 只维护效果 posterior，不得由负分自动生成 quarantine。

## Considered Options

- 安全/完整性硬门与普通效果 posterior 双通道（**选定**）：事件严重度决定治理语义，避免平均分掩盖不可接受风险。
- 所有事件进入统一 utility 分数（否决）：足够多成功样本可能稀释一次严重事故。
- 任一负向 outcome 立即停用（否决）：会把困难任务、测量噪声和弱归因变成大规模误杀。

## Consequences

- Candidate eligibility 先过 ACL、provenance、compatibility、revocation 与 safety gate，只有通过者才参与 utility/freshness 排序。
- Quarantine ledger 与 utility evidence ledger 必须可分别审计；排序器不能把 quarantine 转译成有限负分。
- 严重事件的可信来源与 quarantine 直接触发权由 skill-utility/Q133-A 固定；普通负向 posterior 的具体分布、置信阈值、hysteresis 数值与最小驻留时间仍须后续 policy 决策。
