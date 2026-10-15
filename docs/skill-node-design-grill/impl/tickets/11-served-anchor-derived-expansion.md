# 11 — 已服务锚点的派生子图展开

**What to build:** 第一次检索只冻结直接发现结果 E0。之后只能拿 E0 或更晚一跳里真正服务过、而且现在仍然可见的候选或先验当锚点，向一个关系走一步，得到独立冻结的 E1。E1 重新过权限、用途、分配和交织。这一跳失败时 E0 保持原样，也不公开半成品。旧的自由探索和重定向不再作为公开入口。

**Blocked by:**
- 08 — 分配与确定性交织
- 09 — 按语料的 hybrid RRF

**Status:** ready-for-agent

权威决定：`memory-expansion-placement/Q155-B`，以及 Q160 对 `episodeInsight` 的移除。Hint/Offer 是否允许引用这些卡片属于票 13；本票只保证展开结果本身满足 served-anchor 合同。

- [ ] 初始 `retrieve` 只做直接类型化语料发现并冻结 E0；展开没有自由文本查询
- [ ] `expand` 的锚点必须是父信封中真正 served、且当前仍可见的 candidate 或 prior；每操作一个 relation、一跳
- [ ] 调度时签发绑定 parent、anchor、principal 与 native watermark 的 child snapshot、budget、deadline 与 cancel；E1 独立冻结
- [ ] E1 重新执行 ACL/status、use-class、Q153 allocation 与 Q154 zipper
- [ ] 链的 TTL 为 10 分钟；默认 4 步，硬上限 8 步；累计最多 30 个 unique served；单次操作 limit 为 1..12
- [ ] E1 失败不修改 E0，且没有 partial public hits
- [ ] Episode/Insight 不能作为 anchor 或 target；公开关系里没有 `episodeInsight`
- [ ] 旧 start 迁移为 retrieve 加链；explore 迁移为 expand；redirect 删除并改为新的 retrieve；close 只做 checkpoint
- [ ] 自动化测试覆盖：未服务卡片不能当锚点、E1 失败不污染 E0、步数与 30 个 unique served 上限、退役对象不能进入新展开
