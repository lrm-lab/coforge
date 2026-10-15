# Handoff：诊断与 Memory 的子图检索

日期：2026-09-29。这是设计交接，不是实现任务。代码还没有这些检索子图。不要 push，不要在没被要求时改检索实现。

> **现行模型边界（2026-10-12）：** 本交接记录的是 ADR-0043 之前的检索/Claim/Cut/Fork 模型，只能作为历史设计来源与 legacy 审计材料，不能定义当前新写需求。对新写 AIG、Fork grounding、Fork 生成者或 Claim/Cut 消费的任何冲突，以 [ADR-0043](./docs/adr/0043-aig-native-fork-overlay-and-guided-remediation.md) 和 `CONTEXT.md` Q166–Q189 为准；其实施闸门仍关闭。

权威记录在本目录：`CONSENSUS.md` 叙述 86–106、决策表 #95–#115，`CONTEXT.md` 里的检索术语，`round-13-answers.md`，`round-13-questions.md`。叙述 93–94 里「只有含结论块的那一个子图」已被叙述 97–99 放宽，以 97–99 为准。本文已按 Q152、Q133-B、Q132-B 更新，不是作废快照。

## 现在停在哪

**Q132 已定：B。** 邻域展开只走 influence，不踩 skip；只靠 skip 相连的一截停在缺口这边。influence 仍双向走。本交接「还没答」表里列出的题都已定，前沿空着。

## 两条检索

**诊断检索**发生在 commit 之后、子图已经提取完成时。诊断 agent 用失败子图检索历史子图。任务进行中不做这次检索。

**Memory 检索**在进行中用混合检索卡片：fork/branch 与影响图投影，外加按 claim 卡片 id 展开邻域。它不提取子图，也不做子图对子图。

再次用到 fork 的一般情况是**另一个任务**，不是把同一个任务再跑一遍。旧 fork 七段里的原话对不上新任务的措辞，不能拿七段原文当查询条件。

## 提取时机

- **commit 之后：** 异步轨迹索引服务冻结 `purpose=post_run_index` 的视图。失败诊断另有 `purpose=failure_diagnosis` 的 DIV。检索子图和失败标记只在这次提取时由模型写入。诊断等的是这一次。
- **commit 之前：** 不提取子图。Memory Agent 没有子图提取工具。
- **代码：** `OpenViking/openviking/session/trajectory_index.py` 里有 `TrajectoryIndexService`，但没有挂到 session commit 上。没有检索子图，也没有失败标记。

## 子图怎么划

群聊里通常只有用户的一个任务。各 agent 的子任务没有事先写下的名单，不能按「跑之前的子目标」划界。

提取模型把动作划成检索子图，写入它正在提取的那张图。不铸造 `subtask_id`。效用仍记在 fork 和 `task_id` 上。子任务因果链仍是读的时候顺着 claim 拼出来的，不是另一张图。

同一个任务里可以有多份子图。例如发布里的「切流」「迁移」「通知」。

## 失败与 fork

失败标记由提取模型在写入子图时加上。诊断 agent 不改标记。

- 子图里有失败结果，就有自己的失败结论。例子：「错误率升高」「schema 不匹配」。
- 没有失败结果的子图不写 fork。例子：「公告已发送」。
- 整张 DIV 上的任务级结论「发布失败」不单独再发起一次检索。

诊断 agent 对每一个带失败标记的子图各发起一次检索，也可以不调用。每次各写一份普通 fork。不合成一份 fork，不绑成一组，不造 `cause_set`，也不新造 fork 种类。`fork-cutover`、`fork-migrate` 只是例子名字。

以后查找时，分两次检索、各命中一份即可，不必出现在同一次结果里。

## 一次诊断子图检索返回什么

查询是一个已经提取好的失败子图。命中是历史子图，不是整张 view，也不要求历史边上的句子和当前的 C1、C2 同文同序。

- 最多 3 份，按模糊相似排序。不足 3 份不拿别的子图补。
- 每份是该历史子图，加上**影响定位落在这份子图内部**的 fork。fork 不是图上的 block，它指向某个 block、某条边或某个 cut。
- 同一张历史 view 里的旁路子图不返回。
- 子图内 block 不超过 12。
- 命中里的 fork 带多少文字还没定（Q144）。

模糊相似比的是意思。纯 BM25 只看词是否重叠，跨任务措辞对不上。混合档已定：默认纯 BM25；显式打开时 BM25 加真实向量；没有真实向量时仍返回纯 BM25，不交回空列表。维度为 0 的向量占位不算向量档。

## Memory 的卡片检索（子图工具之外，仍有效）

混合检索暂时不返回 segment/atom。fact 的 2 个位子留空，不回填。一次最多 6 张 fork/branch 加 4 张 block/claim 投影，共 10 张。查询级总帽仍是 12。6/4/2 留到 fact 通道恢复后再用。

block 和 claim 各是一张卡片，共享那 4 个投影位子。命中两张卡片不会把整张影响图一起返回。

邻域展开只给 Memory Agent。参数只有 claim 投影的卡片 id。服务端解析 view 和 claim。模型可以不调用。诊断 agent 不用这个工具。`ov_find` 仍只搜文档。设计（Q132-B）只走 `relation_type=influence`，skip 不进邻接；剩下的 influence 仍按两端登记、双向走。现在的代码还没做这道过滤：`expand_claim_neighborhood` 把 view 里的 claim 全收了（`retrieval_facade.py` 约 789 行），邻接表按两端登记、双向走（约 819 行之后）。

## 代码现状（不要当成设计已经落地）

OpenViking `HybridRetrievalFacade`（`openviking/session/retrieval_facade.py`）：

- 三个语料都是子串匹配，分数恒为 `lexical: 1`。不是 BM25，也不是向量。
- segment/atom 仍会返回，设计上的暂停还没做。
- `expand_claim_neighborhood` 只在测试里调用，不是 Memory 工具。代码仍走一张冻结 view 上的全部 `InfluenceClaim`（含 `skip`），按端点双向走，最多 12 个 block。设计要求先滤掉 `skip`，influence 的双向走保留。不走 HypothesisBridge、EvidenceBridge、fork 边、interaction DAG。代码尚未改。
- 影响投影的 `embedding_stub` 维度为 0。
- 代码里的 fork 卡片仍只有 `fork_node_id` 和 `revision_id`。设计（Q133-B、Q144-B）要求带七段快照和分支动作摘要。claim 卡片的检索信封有 `carried_artifact` 和 `downstream_effect`，摘要留在投影库里用于命中，不在信封上。

Coforge 集成分支 `.worktrees/cursor-ov-cm-impl` 上，Memory Agent 的工具是 `ov_find`、`ov_search_context`、`ov_read`、`memory_offer`、`message_check`、`message_read`、`send_channel_message`。围栏排除 `causal_*`。它不调用 `HybridRetrievalFacade`。

## 还没答

| 题 | 内容 | 推荐 |
|---|---|---|
| Q144 | 诊断命中里的 fork 带多少文字 | 已定 B |
| Q133 | 混合检索的 fork 卡片带不带七段 | 已定 B。整张 view 不进结果 |
| Q132 | 邻域展开走不走 skip | 已定 B。只走 influence；只靠 skip 相连则停在缺口这边。双向走 influence 保留 |

上表三题都已定。没有下一题。

Q152 已定为取消进行中提取，不是早先推荐的 A。

## 接下去不要做的事

- 不要实现 BM25、子图工具或暂停 segment/atom，除非明确要求改代码。
- 不要把整张影响图当作一条命中。
- 不要铸造 `subtask_id` 或 `cause_set`。
- 不要把 block 之间的相似写成跨任务相似边。跨任务泛化仍在 fork 修订之间的已验证相似边和簇上。
- 不要 push。
