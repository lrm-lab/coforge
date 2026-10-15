# 时间衰减 utility evidence，新 active revision 走独立探索冷启动

Q127-B 决定：时间作用于每条普通 utility evidence 的当前权重，而不是直接作用于 skill revision 的资格或存在性。事件永久保留，物化排序贡献按 policy-versioned 时间函数衰减并回归中性 prior；revision 不设“发布满 N 天即失效/删除”的 TTL。skill-utility/Q131-A 冻结初始默认值：observational evidence half-life 为 30 天，counterfactual evidence half-life 为 180 天。明确的 context/cluster 分布、工具、模型、schema、证据、ACL 或兼容性 drift 使受影响 evidence 立即进入 `needs_revalidation`，不等待自然半衰期；严重安全或完整性事件不受普通时间衰减洗白。策略参数变化只重算投影，不覆写原始事件。

Q128-B 决定：Q13-C 原子发布的 `published_active_skill_revision` 立即 online eligible，但冷启动 utility prior 为中性。它只通过独立 skill seeded-exploration 配额获得有上限的曝光/调用；每次选择记录 eligible set、seed 与 selection propensity。skill-utility/Q132-A 冻结初始门槛：skill 探索最多占 eligible invocation 的 10%；具体 revision 至少取得 5 个可归因 objective outcomes、且来自至少 3 条不同 task lineage 后，才可进入正常 exploitation。高 uncertainty 只影响探索资格，不作为 exploit 加分项；该配额独立于既有 provisional memory 的 3 exploitation + 1 exploration 配额。

## Considered Options

- Evidence decay + drift revalidation；active 冷启动走独立探索（**选定**）：同时避免旧证据永久垄断和新 revision 凭空高排。
- Revision 硬 TTL（否决）：把年龄误作错误，会删除仍适用的稳定技能并破坏审计。
- 完全不衰减、只等显式漂移（否决）：未被检测的渐进分布变化会让旧样本长期主导。
- 新 active revision 直接进入 exploitation（否决）：proposal 质量会被偷换为在线效用。
- 收集足够样本前禁止执行（否决）：实质重建 published-inactive 状态，与 Q13-C 冲突。
- 一开始在线学习每个 context 的半衰期或立即改用无门槛 contextual bandit（否决）：当前样本不足，参数不可解释且难以审计。

## Consequences

- 排名器必须读取按 evidence grade、事件年龄与 drift scope 计算的有效证据，而不能使用 skill age 作为简单扣分项。
- “active”继续只表示资格；冷启动探索、正常 exploitation 与 quarantine 是三个不同轴。
- 30/180 天、10%、5 outcomes/3 lineages 均属于版本化初始 policy；后续调整可重算当前投影，但不得改写历史事件或把同一 task lineage 的重复运行伪装成独立冷启动证据。
