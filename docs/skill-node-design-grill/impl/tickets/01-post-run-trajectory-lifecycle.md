# 01 — 生产化 post-run 轨迹生命周期

**What to build:** 一次任务 commit 之后，系统按「任务目标 + 观察到的结果」生成有界的 `purpose=post_run_index` 冻结修订，并让它的投影在检索里随 supersede 与 ACL 变化保持正确：新修订接上索引，旧修订退出检索但仍可被诊断引用，权限变化会再投影或撤下并迫使相关 grounding 重验。调用方能看到覆盖了哪些 AO/Segment、省略了哪些区间以及原因和水印；工作区预算或速率打满时，结果是确定性 fallback 或明确的「无投影」，而不是半成品冒充完整经验。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

权威决定：Q109-A、Q110-A、Q111-A、Q113-A、Q114-A。Q112-A 的 6/4/2 查询配额不是本票的公共 discovery 座位合同；公共 12 席分配属于票 08。

- [ ] post-run 视图按任务目标与 observed outcome 覆盖相关 AO/Segment 子集，并带 coverage_manifest（省略区间、理由、watermark）；不做全轨迹重写，也不做固定窗口
- [ ] 索引由独立异步服务完成：工作区级预算与速率上限；优先级为 evaluation > 失败轨迹 > 成功轨迹；超限降级为确定性 fallback 或明确无投影；工作区可暂停
- [ ] 同一 session/task run 的后续 commit 产生 superseding revision；旧 revision 保留为历史证据且诊断仍可引用，但其 projection 退出检索索引
- [ ] 被 validated ForkRevision grounding 的 block/claim projection 进入 verified 通道并带 provenance；未被 grounding，或只被 provisional/invalidated 引用的，保持 provisional
- [ ] projection 继承来源 AO/Segment 的安全标签；ACL 变更经 outbox 触发再投影或撤下，引用它的 Fork grounding 标为 needs_revalidation；redacted 节点仍是下钻断点
- [ ] 上述行为有自动化测试覆盖：有界覆盖、supersede 退出索引、预算降级、ACL 再投影与 needs_revalidation
