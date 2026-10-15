# 08 — 分配与确定性交织

**What to build:** 发现结果在权限和用途分类之后，按固定信封选出最多 8 张候选和 4 张先验，并用每个仍在役语料的保底席与封顶席决定谁入选。入选集合一旦冻结，公开顺序只是这个集合的确定性重排：候选和先验各自有名次，探索卡片插在候选的第一轮利用之后，暂停的事实席留空且不被别人填上。两次相同计划得到相同的入选集合和相同的公开顺序。

**Blocked by:**
- 07 — 仅 Skills 的类型化语料发现

**Status:** ready-for-agent

权威决定：`memory-discovery-allocation/Q153-B`、`memory-discovery-interleave/Q154-B`。Q160 之后不再给 Episode 或 Insight 留 floor；退役不产生替换席，也不放宽 8/4/12。事实暂停仍只封存 segment/atom 的那一个 prior 席。

共享检索门面会与票 03、06、09、10 交汇。本票在隔离 worktree/分支中开发；共享文件冲突留到票 14。

- [ ] 分类之后的公开座位为 candidate 最多 8、prior 最多 4、总计最多 12；该 8/4 不继承旧的 verified/provisional 8/4
- [ ] 仍在役且在所属 class 内有 eligible 卡片的语料 floor=1、ceiling=4；Episode 与 Insight 不占 floor，也不把席位转给其他语料
- [ ] 剩余席按语料内 rank depth 做 water-fill；同一 depth 的顺序由 planHash、allocation policy version 与 use class 派生 stable rotation；只做同类 backfill，candidate 与 prior 不互借
- [ ] fact active 时占一个 prior 席；paused 时该席为不可回填的 `pause_reserved`，因此最多 11；不生成 placeholder 卡片
- [ ] candidate 帽内最多一个 discovery-wide exploration seat；可见 provisional fork/branch 与 cold-start skill revision 分 stratum 抽样；skill 继续受滚动不超过 10% 的门；无合格对象时在 candidate 类内回填 exploitation
- [ ] allocationHash 冻结入选成员；interleave 只能对该集合做完整排列，不能增删、重复、跨 class、重新截断，或按异构 native score 重排
- [ ] 两个 class 各自有 publicRank，没有信封级总名次；探索卡片插在候选第一轮 exploitation 之后，没有 exploitation 时为 rank 1
- [ ] 每席审计 floor/flex/backfill/exploration 原因；每张卡片审计语料内名次、交织原因与 tie-break version；两个有序数组产生 finalOrderHash；公开 LaneAudit 不泄露 eligible counts
- [ ] 自动化测试覆盖保底与封顶、同类回填、事实暂停空席、探索插入位置，以及相同计划的 allocationHash/finalOrderHash 稳定
