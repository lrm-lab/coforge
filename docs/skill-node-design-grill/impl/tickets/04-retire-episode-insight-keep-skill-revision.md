# 04 — 退役 Coforge Episode 与 Insight，保留 SkillRevision

**What to build:** 新的记忆发现、展开和 Hint/Offer 不再把 Coforge Episode 或 Insight 当作候选、先验、锚点、目标或来源。它们的原生存储、历史信封、引用和结果记录仍可审计，但任何新的服务或展开都会重验当前状态并拒绝重新公开它们。Coforge SkillRevision 继续可被发现，也继续作为 Agent Evolution 的可执行修订注册表。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

权威决定：`memory-coforge-episode-insight-retirement/Q160-B`。本票主要落在 Coforge 的发现/展开/Hint 消费边界，可与 OpenViking 检索票真正并行。不要实现跨语料 12 席分配（票 08）或混合融合（票 09）。未来的事实记忆替换必须另开决策，本票不得让任何语料继承 Episode/Insight 的席位或信任。

- [ ] Episode 与 Insight 在 central use-class 之前以 `retired_from_memory_discovery` 排除；它们不是 pause hole，不产生 replacement seat，也不把原优先级转给其他语料
- [ ] 新的 discovery adapter dispatch、候选池、公开结果数组、allocation/interleave 输入、discovery exploration 与 public expansion 都看不到 Episode 或 Insight
- [ ] 公开 expansion 移除 `episodeInsight`；Episode/Insight 不能作为 anchor 或 target
- [ ] 已完成的 envelope、Hint、disposition、citation 与 outcome 保持不可变；新的 serve 或 expand 重验 current status 后不能重新暴露 retired object
- [ ] native records 与 provenance 仍按原生命周期和 ACL 保留，供授权审计读取
- [ ] active/current 且通过 ACL、scope、quarantine、utility、cold-start 与 exploration 门的 SkillRevision 仍可作为 memory candidate，并保留稳定 URI、lineage 与任务侧执行语义
- [ ] 回归测试覆盖：退役对象不进新发现/展开/Hint；历史记录不被改写；合格 SkillRevision 仍可发现且可执行
