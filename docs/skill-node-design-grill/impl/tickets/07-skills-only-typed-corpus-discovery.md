# 07 — 仅 Skills 的类型化语料发现

**What to build:** 一次 memory-discovery 由外层协调器看到每个仍在役的类型化语料的原生卡片，再统一做逐对象权限、状态和用途分类。合格的 SkillRevision、已验证的 fork/branch，以及带机器警告的可见 provisional fork/branch 可以成为记忆候选；投影与 segment/atom 只能成为类比先验。Coforge Episode 与 Insight 在分类前就退出，不再占任何候选或先验身份。提供方不能提前把公开结果裁到 12 张。

**Blocked by:**
- 03 — 按角色投影的统一检索入口
- 04 — 退役 Coforge Episode 与 Insight，保留 SkillRevision

**Status:** ready-for-agent

权威决定：`memory-corpus-topology/Q147-B`、`memory-use-class-policy/Q148-B`，并由 `memory-coforge-episode-insight-retirement/Q160-B` 覆盖 Episode/Insight 的消费含义。12 席 floor/ceiling、交织顺序、混合 RRF 与展开分别属于票 08、09、11。本票的适配器必须交出未经公开预裁剪的、带语料内全序的原生卡片，供后续票消费。

- [ ] outer coordinator 独占逐对象 ACL/status recheck、中央 use-class 与最终选择；adapter 只报告原生对象、身份、状态、来源指针、语料内顺序与受控 audit
- [ ] adapter 输出未经 provider-level public pre-truncation；不把两个系统物理并成一个索引
- [ ] 中央分类把 active/current SkillRevision、validated fork/branch，以及带机器警告的 visible provisional fork/branch 标为 `memory_candidate`
- [ ] projection 与 segment/atom 标为 `analogical_prior`；无效、撤回、不可授权或关键 provenance 缺失的对象为 `excluded`
- [ ] Episode 与 Insight，包括曾经 active/current-head 的 Insight，在 use-class 之前排除；它们既不是 candidate 也不是 prior
- [ ] 每张卡片最多一个 use class；adapter 不得自我升级；classifier 不能产生 current evidence；excluded 不返回且不泄露数量；policy version 写入信封
- [ ] 自动化测试覆盖：预裁剪不会发生、SkillRevision 与 fork 的分类、Episode/Insight 在分类前消失、excluded 数量不外泄
