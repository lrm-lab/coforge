# 13 — 只消费已服务结果的 Hint 与 Offer

**What to build:** Hint 和 Offer 只能引用一次已完成发现里真正服务给调用方的记忆候选。当前证据、类比先验、失败或不可用的发现、未服务的卡片，以及已退役的 Episode/Insight，都不能驱动新的 Hint 或 Offer。后续更完整的检索不会被早先的部分 Hint 当成重复而吞掉。生成前，服务端按冻结信封重新核对卡片仍在结果中、仍有权限、状态仍有效。

**Blocked by:**
- 05 — SkillRevision 调用与效用治理
- 08 — 分配与确定性交织
- 11 — 已服务锚点的派生子图展开
- 12 — 预算、截止、取消与完整性树

**Status:** ready-for-agent

权威决定：`memory-partial-hint/Q146-B`、`memory-expansion-placement/Q155-B` 的 served-candidate 规则，以及 `memory-coforge-episode-insight-retirement/Q160-B`。效用事件链沿用票 05：Hint/Offer 本身不是 utility。

- [ ] 只有 completed `memory_discovery` 的公开 memory candidates，且是该信封真正 served 的卡片，可以生成 Hint/Offer
- [ ] exact-only 的 current evidence、analogical prior、discovery terminated 或 unavailable retrieval 都不能驱动 Hint
- [ ] 只有 completed E1 上真正 served 的 candidate 可以驱动 Hint/Offer；E0 的 served candidate 同样必须通过当前状态重验
- [ ] HintRetrievalProvenance 绑定冻结信封引用、operationId、planHash、派生完整性、贡献与未完成 lane、laneAuditHash 与 served sourceCardRefs
- [ ] 服务端重验 membership、ACL 与 status；partial/complete 以及 incomplete-lane 集合进入去重，使后续 complete Hint 不被 partial Hint 吞掉
- [ ] Coforge 的直接 offer 与 OpenViking 的 hint composer 都收口到该 served-envelope grounding
- [ ] Episode 与 Insight 不能成为新的 Hint/Offer 来源；历史 Hint 保持不可变，但不构成新的服务
- [ ] 合格 SkillRevision 只有在上述 served-only 条件成立时才能成为 Hint/Offer 来源；offer 不计 utility
- [ ] 自动化测试覆盖：未服务卡片、先验、退役对象和 terminated discovery 都被拒绝；部分 Hint 不阻止后来的完整 Hint
