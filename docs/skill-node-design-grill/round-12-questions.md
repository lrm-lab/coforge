# Round 12 问题

每次只问一题。Q126 仍未答，本轮不重问。本轮只问因果检索初排用什么打分：子串匹配已经否掉，剩下 BM25 与向量。

## 本轮用到的术语

- **因果检索**：`HybridRetrievalFacade.retrieve` 这一次调用。它从三份语料收卡片，默认最多 12 张：fork/branch 6、影响图投影 4、segment/atom 2。
- **Fork node（分叉节点）**：按需记下的一个决策点。检索时卡片指向它的最新 revision，不带七段快照全文。
- **Branch（分支）**：挂在某个 fork 上的一条后续走法。真实走法、想象走法、带 guidance 的走法都是 branch 卡片。
- **影响图投影**：冻结 Influence View 上的轻量卡片。Block 是动作块，Claim 是两个块之间的影响边。卡片上有摘要；影响图投影还带一个 embedding stub。
- **embedding stub**：占位向量记录，`provider` 为 stub，`dimensions` 为 0，里面是内容哈希。它不能和 query 算相似度。
- **Segment / Atom**：都是一条 AO pair 进检索后的卡片。标了 `record_kind=segment` 的是 segment，其余是 atom。卡片上是指针，匹配看的是 action 和 synopsis。
- **子串匹配**：query 整段出现在文本里才算命中，分数恒为 1，按台账或写入顺序截到配额。这是现在三份语料的做法。
- **BM25**：按词重叠打分。词在这篇里越密、在整库里越少见，分越高。没有共同词的记录落选。空 query 仍全部入选，顺序保持写入顺序。
- **向量检索**：把 query 和文档都变成向量，方向越近分越高。同义、换一种说法可以命中。没有真正的向量就无法打分。

❓ **Q127** - **因果检索的初排**：频道消息是「这次发布必须蓝绿」。库里有三条可检索文本。甲的 synopsis 是「这次发布必须蓝绿」。乙的 synopsis 是「green environment cutover」。丙的旧笔记里只出现一次「绿灯」。另有一张 fork 卡片，七段快照里写了「蓝绿发布」；一张 claim 投影，摘要是「发布步骤 → 流量切到绿环境」。投影上的向量是 stub，维度为 0。

- A. 三份语料都用 BM25。甲和写了「蓝绿发布」的 fork 排到前面。乙没有共同词，不进这 12 张。丙若只共享「绿」这个很常见的片段，分低于甲。stub 不参与打分。
- B. 三份语料都用向量。query「蓝绿」可以靠近乙的 green environment，也可以靠近「流量切到绿环境」。stub 维度为 0，比不了相似度；在接上真正的 embedder 之前，这一路排不出顺序。
- C. 先按 A 用 BM25 排序。某张卡片有真正的非零向量、且 query 也能被同一个 embedder 编码时，再用向量分调整名次。stub 仍只走 BM25。

➡️ 推荐 A。现在能用的文本就是 synopsis、投影摘要和 fork revision 里的字。stub 不能做向量比较。B 在 embedder 接上之前没有排序。C 把两种分绑在同一次初排里，等向量真正存在时再单独立项。
