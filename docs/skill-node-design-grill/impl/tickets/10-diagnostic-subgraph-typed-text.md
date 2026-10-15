# 10 — 诊断子图的类型化文本检索

**What to build:** 诊断在失败子图上查找历史子图时，查询和文档使用同一份文本：原有散文在前，后面追加一组有界的规范类型 token。散文相近但失败、角色、种类或关系不同的子图因此能被词法检索分开。这条路径仍然只做 BM25，最多返回 3 个正分命中；类型 token 不是因果证明，也不是当前 Claim 的证据。

**Blocked by:**
- 01 — 生产化 post-run 轨迹生命周期

**Status:** ready-for-agent

权威决定：`diagnostic-subgraph-text/Q157-B`。本票不引入 embedding、RRF、结构评分或跨语料重排，也不改变候选资格、top-3、零分不回填和同分保持存储序。它依赖票 01 产出的可引用 post-run 冻结修订，但不改票 09 的 discovery 融合。

共享检索文本实现会与票 03、06、08、09 交汇。本票在隔离 worktree/分支中开发；共享文件冲突留到票 14。

- [ ] 查询仍是失败标记子图本身；七段、guidance、诊断结论与模型自由文本不进入查询
- [ ] 共享文本先保留既有散文顺序，再追加且只追加：subgraph failure、block role、block kind、block failure、claim relation、claim failure，以及有界的 canonical relation profile
- [ ] 缺失或不支持的值显式为 `unknown`；不改变文本形状来假装字段不存在
- [ ] raw AO、guidance、用户/频道消息、provenance/evidence ref、AO 区间、opaque ID、ACL/安全元数据与隐藏候选信息不进入文本
- [ ] 查询与历史文档使用同一 policy version；表示内容哈希与 policy version 一起变化
- [ ] 排序保持 BM25-only、正分准入、top-3，且零分不回填；同分仍保持既有存储序
- [ ] 公开诊断结果不暴露原始 token 内部、隐藏候选计数或被 ACL 滤掉的结构
- [ ] 自动化测试覆盖：散文相同而关系/失败不同的两个子图可被词法区分；禁止字段不出现；top-3 与零分政策不变
