# Skill utility 采用 revision-level 事件链与分级归因

Q126-A 决定：下游效用的最小归因单位是具体 `skill_revision_id` 的真实 invocation，而不是 skill URI、检索命中、Memory Hint 或整个 session。服务端将 `eligible → offered → selected → invoked → applied → followthrough → objective_outcome` 记录为不可变事件链，以 `invocation_id` 绑定 task/run、context/cluster、候选集合与版本化 outcome measurement policy。缺失阶段不能由最终成功反向补齐；offer、exposure、citation 和生成方自报均不产生 utility。

效用证据分级保存。只有一个 revision 被 applied 且出现客观结果时，产生 `observational` evidence：它可用于学习，但只表示带时序和适用范围的关联。满足冻结 ControlContract 的配对 replay/continuation 相对基线差异产生 `counterfactual` evidence，证据权重更高。多个 revision 同时 applied 且未做逐一消融时，仅记录带全部 invocation refs 的 `confounded_set` 联合证据；不得把整次成功等分或全额复制给每个 revision。

skill-utility/Q130-A 进一步决定聚合模型：为每个 `(skill_revision_id, context/cluster)` 维护局部 utility posterior，并向该 revision 的全局层级 prior 做有限收缩；observational 与 counterfactual evidence 分别保留并按不同可靠度进入，confounded set 不拆样本。正常 exploitation 使用保守下置信界 `utility_LCB`，而不是 posterior mean；revision 全局统计只提供 prior、样本量与异质性视图，不能覆盖局部负向 evidence。

## Considered Options

- Revision-level 事件链 + observational/counterfactual/confounded 分级（**选定**）：保留在线反馈覆盖率，同时不把相关性伪装成因果性。
- Episode 成功归给所有 offered/cited revisions（否决）：选择偏差和搭便车会形成自证排名循环。
- 只认配对对照（否决）：因果最强但丢弃绝大多数真实在线反馈，无法支持冷启动与长尾 context。

## Consequences

- 异步 aggregator 必须按 revision、context/cluster、evidence grade 与 principal-visible evidence 聚合，不能只维护 skill URI 或 session 总分。
- 多 skill episode 在没有消融前不能贡献各 revision 的独立正向 exploit utility，但仍保留联合证据供后续 replay/诊断选择。
- 选择策略必须记录 eligible set 与 selection propensity，以便评估曝光偏差；原始事件不可被去偏投影覆写。
