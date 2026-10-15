# 05 — SkillRevision 调用与效用治理

**What to build:** 每个具体 skill revision 的下游消费形成一条可审计的事件链，并且只有真正 applied 的结果才进入效用。正常排序使用保守下界而不是平均数；新发布的 active revision 先走有上限的探索，凑满可归因结果后才进入正常利用。严重安全或完整性事件可以由授权服务端立即隔离，普通失败只进入负向效用，代理不能靠低分直接隔离。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

权威决定：Q126-A、Q127-B、Q128-B、Q129-A，以及 `skill-utility/Q130-A` 至 `skill-utility/Q133-A`。这些键不改写更早的历史检索编号。本票不实现 discovery 座位分配；探索配额要能被票 08 的 discovery-wide exploration seat 读取。

- [ ] 消费事件链为 eligible → offered → selected → invoked → applied → followthrough → objective_outcome，并以 `invocation_id` 绑定 task/run、context/cluster 与 outcome policy version；事件不可变
- [ ] offer、exposure、citation 与生成方自报不计 utility
- [ ] 唯一 applied revision 的真实结果记 observational evidence；满足 ControlContract 的配对相对差异记 counterfactual evidence；多个 revision 同时 applied 且未逐一消融时只记 `confounded_set`，不向各 revision 复制完整正效用
- [ ] 以 `(skill_revision_id, context/cluster)` 维护局部 posterior，并向该 revision 的全局 prior 做有限收缩；observational 与 counterfactual 分开建模；正常 exploitation 按 `utility_LCB` 排序
- [ ] observational evidence 默认半衰期 30 天，counterfactual evidence 默认 180 天；参数随 policy version 冻结，衰减只重算投影、不覆写原始事件；明确 drift 使受影响 evidence 立即 `needs_revalidation`
- [ ] revision 本身无 TTL；严重安全、完整性、撤销或可执行不兼容事件不随时间自动洗白
- [ ] 新的 `published_active_skill_revision` 立即 online eligible，但以中性 prior 进入独立 seeded-exploration；探索最多占 eligible invocation 的 10%；进入正常 exploitation 前至少 5 个可归因 objective outcomes，且来自至少 3 条 task lineage
- [ ] 高 uncertainty 只提高探索资格，不直接提高 exploit 排名，也不挤占既有 provisional 3+1 配额
- [ ] 只有版本化服务端 verifier、安全策略、权威撤销事件或授权管理员可直接 quarantine；Memory、Diagnosis、Builder/Critic/Refiner/Reader 与普通 task agent 只能提交带 evidence refs 的 proposal；utility aggregator 不得因负分自动 quarantine
- [ ] 普通失败走负向 posterior，并以升降不同阈值的 hysteresis 防震荡；安全硬门与普通负效用保持两条通道
- [ ] 自动化测试覆盖事件链归因、LCB 排序、30/180 天衰减、10% 与 5/3 门槛、以及非授权角色不能直接 quarantine
