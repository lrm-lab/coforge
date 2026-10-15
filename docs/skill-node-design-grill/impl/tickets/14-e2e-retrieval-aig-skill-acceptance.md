# 14 — 检索、AIG 与 Skill 的端到端验收

**What to build:** 一条可重复的验收把前面各票串成调用方能观察的整条路径：任务跑完后的轨迹进入索引，AIG 角色基于冻结证据完成构建与阅读，Memory 只拿到历史发现，授权角色还能核验当前证据，SkillRevision 按效用与隔离规则被发现或拒绝，Hint 只引用真正服务过的候选。共享检索门面上分票开发的改动在这里合并，并证明合并后的合同仍然同时成立。

**Blocked by:**
- 01 — 生产化 post-run 轨迹生命周期
- 02 — AIG 多角色构建链
- 05 — SkillRevision 调用与效用治理
- 06 — 非 Memory 的 exact lane
- 07 — 仅 Skills 的类型化语料发现
- 08 — 分配与确定性交织
- 09 — 按语料的 hybrid RRF
- 10 — 诊断子图的类型化文本检索
- 11 — 已服务锚点的派生子图展开
- 12 — 预算、截止、取消与完整性树
- 13 — 只消费已服务结果的 Hint 与 Offer

**Status:** ready-for-agent

票 04 的退役合同通过票 07 与票 13 进入本验收，不单独再列一条阻塞。本票是票 03、06、08、09、10 的集成分支：解决共享检索门面的冲突，并只在合并后的树上承诺整条路径为绿。不要把本验收读成检索效果实验，也不要在这里重开已接受的产品决定。

- [ ] 隔离分支上的检索门面改动合并到一条集成分支；合并后 Memory 发现、非 Memory exact、分配/交织、RRF 与诊断类型化文本的既有测试同时通过
- [ ] 端到端路径覆盖：post-run 冻结修订可被诊断引用；supersede 后旧投影退出检索；ACL 变化触发 needs_revalidation
- [ ] 一次 AIG run 产出冻结 revision 或明确的 provisional-only fallback，且 ReaderReport 的 phase gate 在这条路径上成立
- [ ] Memory 发现计划返回候选与先验；注入 exact 时在调度前被拒绝
- [ ] 授权非 Memory 角色的 exact 与 discovery 同时存在时，两 lane 名额独立；一条 lane 终止不公开其中间命中，也不清掉已完成兄弟 lane
- [ ] Episode/Insight 不出现在新的发现、展开或 Hint 中；合格 SkillRevision 可以出现，并受探索门槛与 quarantine 权威约束
- [ ] 向量失败只降级对应语料；诊断历史子图仍是 BM25-only，且类型 token 能分开散文相同、结构不同的子图
- [ ] Hint/Offer 只引用 completed discovery 中真正 served 的 candidate；未服务锚点不能展开
- [ ] 验收记录写明所跑命令与结果；不把通过本票写成「记忆提高了任务成功率」
