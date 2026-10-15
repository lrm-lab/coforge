# R7b 设计：诊断侧检索的**查询表示**与**尺子**（编排侧代定，2026-10-01）

依据：`CONSENSUS.md` #128（R7b 待设计，须标「基于夹具」）、#130（结构轴要么等带边视图要么走诊断侧夹具）、#140（R8a／R8b 的检索级负结果：那把尺子量的是工具词汇重合）；`R4a-brief.md` 与 `R4a-verification.md`（诊断侧读通道已实现）；`R4b-verification.md`（fork 写已实现）。

## 0. 为什么这一步必须先做设计（R8b 的教训）

R8b 结案时我写下：**「不要再跑一把看看」**。R8a 的失败不是实现错，是**尺子的口径**错——命中测试的 pattern 键退化成 shell token（41 个键／444 次事件，两个 `cd` 键覆盖 63.7%），于是「结构 vs 词法」量的是词汇重合。诊断侧如果照搬，会重演同一种失败，而且更隐蔽：**生产的诊断侧通道本身就是一个词法通道**。

## 1. 现场事实（我逐条读过代码，实现侧直接用，不要重猜）

| 事实 | 依据 |
|---|---|
| 诊断侧读通道已存在：`RetrievalSubgraphAdapter.retrieve_historical_subgraphs(view_revision_id, subgraph_id, principal_labels)`，交回 ≤`DIAGNOSTIC_SUBGRAPH_HIT_CAP = 3` 份 `DiagnosticSubgraphHit`（含该子图的 blocks／claims 与接地其中的 forks） | `retrieval_facade.py:1578,1619,142` |
| 该通道的**排名是 BM25**：query 与候选都用 `_subgraph_retrieval_text(revision, subgraph)`，`_rank_document_indexes(query_text, documents)` 排序 | `:1638,1642,1653` |
| **它故意丢掉结构**：`_subgraph_retrieval_text` 的文档字符串写着「Schema labels, ids, roles, relation types, the failure marker, guidance, and raw AO text are omitted so two subgraphs with disjoint prose do not share tokens」——文档正文只由每块的 `summary`／`input`／`output` 与每条 claim 的 `carried_artifact`／`downstream_effect` 拼成 | `:1655-1674` |
| 该文本表示是**未定设计的占位**：`SUBGRAPH_TEXT_POLICY_VERSION = "subgraph-text-pending-v0"`；R4a 派发件原话「相似度算法与文本表示都是**实现侧占位**，不是已定设计」 | `:141`、`R4a-brief.md` §3 |
| 语料只取 `purpose == post_run_index` 的冻结修订，且排除发起查询的那一份 revision 自己；ACL 在候选入语料**之前**过滤，session 无标签即不可见 | `:1644-1652` |
| 失败子图必须 `is_failure`：未打标记的子图调用即报错（只有含坏结果的子图发起检索） | `:1712-1720`、#102／#103 |
| 锚点可派生位置：`default_failure_grounding_position(revision, subgraph_id)` → `("block", "block:<id>")`，要求恰好一个 block 覆盖 `failure_evidence_refs[0]`（同 `ao_id`／session／sequence） | `subgraph_forks.py:95` |
| 结构词表（已是生产常量）：`BLOCK_ROLES = (task, orchestrator, agent_action, conclusion)`；`RELATION_INFLUENCE="influence"`／`RELATION_SKIP="skip"`；`POSITION_KINDS = {block, edge, cut}`；`BRANCH_EVIDENCE_STATUSES = {real, imagined_synthetic, imagined_unverified}`；`MAX_RETRIEVAL_SUBGRAPH_BLOCKS = 12` | `influence_view.py:28,39-42,47` |
| 夹具已有现成搭法：`tests/test_subgraph_forks.py` 的 `_freeze`／`_release_blocks`／`_release_subgraphs`／`_release_claim`／`_store`（进程内造冻结修订＋子图＋写 fork） | `tests/test_subgraph_forks.py:149-241` |

**结论**：生产今天在诊断侧做的事是「把子图的散文取出来跑 BM25」。所以「结构值不值钱」在本波有一个非常干净的提法——**把生产丢弃的那些字段拿出来，问它们能不能表达散文表达不了的区分**。

## 2. 决策 #144：查询表示 = **失败子图本身**，不含任何模型写的文本

**决定**：诊断侧检索的 query 一律由**发起查询那一刻真实存在的东西**构成，即：

1. 失败运行自己的冻结 `post_run_index` 修订（blocks／claims／coverage）；
2. 该修订上的失败子图（`failure_marked=true`，`failure_evidence_refs[0]` ＝ 截断邻域的锚点 AO）；
3. 该 session 的 AO 台账（尾部原文，消息粒度）；
4. workspace／ACL 标签。

**七段 section、branches、guidance、诊断结论一律不进 query**——它们是诊断**要产出**的东西，不是诊断的输入。理由：如果 query 里塞模型写的失败描述，那「结构 vs 词法」的对照立刻失去意义（两边都在比模型写的文本），而这正是 R8b 踩过的坑。

**两臂据此取同源材料，只换匹配函数**：

| | 查询侧（当前失败） | 候选侧（历史子图＋fork） |
|---|---|---|
| **词法臂**（＝**生产现状**，逐字调用，不许重写） | `_subgraph_retrieval_text(current_revision, query_subgraph)` | `_subgraph_retrieval_text(revision, subgraph)` |
| **结构臂**（benchmark 侧新写，见 §3） | 类型化签名 `structural_signature(revision, subgraph)` | 同一函数对候选算签名 |

**硬隔离**：`structural_signature` 只吃 `(revision, subgraph)` 并只吐**封闭词表＋整数＋id／哈希**，不许含任何自然语言；词法臂只调生产函数（它本来就不读结构字段）。两条都要有门检（§5）。

## 3. 决策 #145：结构签名与结构匹配器（冻结在前，打分在后）

**签名（只收录生产 `_subgraph_retrieval_text` 明确丢弃的那些维度）**，每条都对应设计语料里已经存在的概念，不是新发明：

| 字段 | 取值 | 设计依据 |
|---|---|---|
| `boundary` | `call_cut`／`result_cut`／`text_end` | 尾部块的角色与相邻块种类（R8a 的 `cut:toolCall`／`cut:toolResult`／`text_end`）；「死在等结果」与「死在没发出去」是不同的失败签名，**散文字面上看不出来** |
| `anchor_kind` | `block`／`edge` | `POSITION_KINDS`；position 由 `default_failure_grounding_position` 派生 |
| `anchor_incidence` | `influence_upstream`／`influence_downstream`／`influence_both`／`skip_only` | 锚点块是不是 influence claim 的端点；#115／#106「邻域只走 influence、在 skip 缺口停下」 |
| `relation_profile` | `(influence_n, skip_n)` 与子图内按端点聚合的计数 | #106：`skip` 与 `influence` 语义不同 |
| `role_profile` | 四种角色的计数 | `BLOCK_ROLES` |
| `coverage_crossing` | 布尔：子图落点是否与 coverage 的 `omitted_ranges` 相邻／跨越 | 覆盖清单与「证据基础」语义（#113 一脉） |
| `member_gap` | 子图内相邻块之间的最大序列间隙 | 子图是不是「跳着取的」 |
| `truncation_lines` | 整数：尾部坏 JSON 行数（台账可算则算，不可算记 `unknown`） | R8a 的 `bad_json_lines` |
| `workspace_id` | 标签（ACL 用，匹配时同标签才可比） | #118 |

候选侧另加（历史 fork 的结构字段）：`grounding_kind`／`grounding_ref` 的 kind、branch 的 `evidence_status`、branch `ao_sequence` 与锚点序列的**重叠**（`overlaps_anchor` 布尔）、`used_skills` 的**种类**（不是文本）。**不读七段**。

**匹配器（冻结）**：结构相似度 ＝ **逐字段相等计数的加权和**，权重与字段清单**在打分前写死**（建议：`boundary`、`anchor_incidence`、`coverage_crossing`、`overlaps_anchor` 各权重 2；其余 1；`workspace_id` 不同直接不可比），平局按 `(session_id, subgraph_id)` 字典序。不许读散文，不许调模型。

## 4. 决策 #145（续）：尺子 ＝「判别力夹具」＋「真数据切片」，且**不是效果量**

**为什么不能用「哪条臂赢」当结论**：诊断侧没有裁决——SkillsBench 的 14 个 episode 里只有 2 个 `recorded failed`（且都是 agent 超时）、7 个无裁决、**没有任何修复链**（失败之后没有再跑同一任务并成功的记录）。所以「哪个历史子图真的有用」在本语料上**无法从结果定义**。硬凑一个「相关性」标签就是又一次自欺。

**所以尺子分两层，各自只回答它能回答的问题**：

### L1 判别力夹具（controlled pairs）——回答「生产丢弃的字段是不是唯一载体」

由**规则**生成，不许手写个案、不许事后增删：从真实语料（R8a 的 14 个冻结修订／15 个 fork，或 `tests/test_subgraph_forks.py` 那套进程内夹具）**克隆**一个子图，只改**类型化字段**，**散文逐字节保持相同**，于是每对成员构成一个受控对：

- 轴 A：`boundary` = `call_cut` vs `result_cut`（散文相同）
- 轴 B：`anchor_incidence` = `influence_both` vs `skip_only`（散文相同）
- 轴 C：`coverage_crossing` = true vs false（散文相同）
- 轴 D：候选侧 `overlaps_anchor` = true vs false（散文相同）

报的量：每对成员上两臂的**判别率**（能否把「与 query 同轴的一方」排在前面）＋ top-1／top-3／MRR（cap=3，与生产一致）。**必须标「基于夹具，判别力 ≠ 效果量」**。

**探针（kill tests，必须做，用于证明两臂各自真的在读它该读的东西）**：
1. **洗牌测试**：把候选的结构字段在候选之间随机置换（固定种子）→ 结构臂分数必须塌到随机水平（判别率落回 50% ± 噪声区间）。
2. **散文互换测试**：把受控对两名成员的散文**互换**（结构字段不动）→ 词法臂的选择必须跟着散文走（说明它只读散文），结构臂的选择必须**不**跟着散文走（说明它没读散文）。
3. **隔离测试**：`json.dumps(signature)` 里不许出现夹具散文中任何长度 ≥ 8 的自然语言 token；词法臂的输入必须是生产函数的原样输出（断言调用的是生产函数，不是本地实现）。

### L2 真数据切片（14 个真实修订＋15 个 fork）——回答「在真数据上两臂有没有差别」

不算判别力（没有裁决可用），只报**两臂排名的一致性**与**分歧点**：top-3 集合重叠度、两臂排名的秩相关、以及**每个分歧点的手工归因**（结构臂把某候选往上抬／往下压，是因为哪个字段）。如果两臂在真数据上排名完全一致 → 就写「**本语料上结构字段在生产通道里是惰性的**」，这也是一条有效结论。

### L3 对生产的含义（只写结论，不改代码）

本波的产出之一是对 `SUBGRAPH_TEXT_POLICY_VERSION = "subgraph-text-pending-v0"` 的**决策输入**：丢弃 roles／relation types／failure marker 是否合理？**只许写成发现与建议，不许改 `retrieval_facade.py`**（生产检索不在本波授权范围，见 §5 硬约束）。

## 5. 硬约束（照旧）

- **只读语料**；**不调用模型**；**不加依赖**；**不 push**。
- **只动 `benchmark/causal_memory/`**（新增 R7b 文件）＋必要时 `impl/`。**不改** `openviking/` 与 `tests/` 的**任何**文件；`_subgraph_retrieval_text`／`SUBGRAPH_TEXT_POLICY_VERSION`／`retrieve_historical_subgraphs` 一个字都不改（本波要测的就是它，动了就自证）。
- `l1_locomo_hitk.py` 保持字节相同。
- 不动暂停的 live 栈；不建 `ov.conf`；不重跑 `evo-lsk1`。
- **规则冻结在前**：签名字段、权重、平局规则、夹具生成规则、cap=3，全部写成常量并**在任何分数之前打印**；看到数字后不许改规则、不许删臂、不许挑轴。
- 确定性：同一输入两次运行报告**逐字节相同**（给哈希）。

## 6. 门检

1. 词法臂**逐字调用生产** `RetrievalSubgraphAdapter.retrieve_historical_subgraphs`（断言 `SUBGRAPH_TEXT_POLICY_VERSION` 与 `DIAGNOSTIC_SUBGRAPH_HIT_CAP` 被打进报告），无本地重写。
2. 隔离测试通过（签名里无散文 token；词法臂输入＝生产输出）。
3. 洗牌测试：结构臂判别率塌回随机带（要给出随机带的定义与实测值）。
4. 散文互换测试：词法臂跟散文、结构臂不跟散文。
5. L2 真数据切片两臂排名一致性与分歧点清单齐备。
6. 报告里**没有**「结构臂更好」这类效果量表述；L1 结果一律带「基于夹具／判别力」标签。
7. 两次运行产物哈希相同；`git status` 干净；未 push；`openviking/` 与 `tests/` 零改动（`git diff --stat` 为空）。

## 7. 本波**不**回答的问题（必须在报告里声明）

- 诊断侧的真实效用（没有裁决、没有修复链，量不了）。
- 结构通道在**非夹具**数据上的相对收益（L2 只报一致性，不报胜负）。
- 跨 session／跨 workspace 的泛化（夹具与真切片都在同一 workspace 内构造；ACL 只作为可见性前提）。
- 模型写的七段／branches 在检索里的作用（#125 的范围）。
