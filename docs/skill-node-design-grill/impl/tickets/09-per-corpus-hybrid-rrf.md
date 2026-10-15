# 09 — 按语料的 hybrid RRF

**What to build:** 每个仍在役的类型化语料各自用词法与向量召回发现对象，合并成该语料自己的全序，再交给已有的分类、分配和交织。词面完全不同但语义接近的对象可以被向量通道发现。某一个语料的向量失败时，只有它退回确定性的词法顺序，已经成功的其他语料保持融合结果。

**Blocked by:**
- 07 — 仅 Skills 的类型化语料发现

**Status:** ready-for-agent

权威决定：`memory-hybrid-fusion/Q156-B`。融合发生在语料内全序，早于票 08 的分配；本票不改 8/4 座位，也不做跨语料全局分数。诊断子图检索保持 BM25-only，不属于本票。

共享检索门面会与票 03、06、08、10 交汇。本票在隔离 worktree/分支中开发；共享文件冲突留到票 14。

- [ ] 每个 typed corpus 独立取 BM25 top-32 与 vector top-32，按 canonical native identity 去重并取并集；同一对象两路命中只占一个 card，但保留两路 rank 贡献
- [ ] 等权 `RRF(k=60)`：`1/(60+bm25Rank) + 1/(60+vectorRank)`；缺席通道贡献为零；不把原始 BM25 与 cosine 数值相加或做 min-max
- [ ] 最终 tie-break 使用 canonical identity；fusion policy version 进入语料内顺序与 audit
- [ ] 每个语料必须有 vector completeness proof，覆盖适用的 snapshot、index/model/policy 与 native retrieval completion
- [ ] proof 缺失、向量异常、超时或 index/embedding 不可用时，仅该语料退化为 BM25 top-32 的确定性顺序；不重跑、不降级已成功的兄弟语料，也不把整个 discovery lane 伪装成全局 BM25 fallback
- [ ] 现有「必须先 BM25 命中才进入向量」的门，以及共享 rank-plan 的全局回退，被移除
- [ ] 融合输出继续经过 ACL/status、中央 use-class、Q153 allocation 与 Q154 zipper；公开信封不包含 raw ranks、proof 细节、fallback 原因或隐藏候选计数
- [ ] 零词面重叠但向量 top-32 命中的对象能进入该语料并集；自动化测试覆盖该场景、双路单席，以及单语料向量失败不影响兄弟语料
