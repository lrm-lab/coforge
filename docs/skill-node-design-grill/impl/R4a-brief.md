# R4a brief：诊断侧子图检索（读）

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（已有 `988148ad8`、`12f783d19`、`c63995f8e`、`145adc72b`、`63c915d5a`）。**追加新提交；不要 rebase／amend；不要 push；不引新依赖；不动 `benchmark/`（除非签名必须，先报告）。**

设计依据：`CONSENSUS.md` 叙述 92–95、97–98、101、104 与决策 #101、#102、#103、#104、#107、#113；`CONTEXT.md` 术语「检索子图」「失败标记」「失败子图」「诊断子图命中」。round-13 的 Q143／Q144 原文在 `round-13-questions.md`。

这一波**只做读**：拿一个当前视图里的失败子图，去查历史视图里的子图，交回最多 3 份命中，每份带该子图与该子图内接地的 fork。**不写 fork**（那是 R4b）。**不做混合检索的接线**（R6）。

## 现有设施（勘查结论，直接用，不要重造）

- 失败标记：`RetrievalSubgraph.failure_marked` / `is_failure`（`openviking/session/influence_view.py:703`、`:729`）；`MAX_RETRIEVAL_SUBGRAPH_BLOCKS = 12`（`:47`）。
- 冻结视图的唯一完整存放处是 `ViewSupersedeIndex`（`influence_view.py:1729`），它有 `latest(session_id, purpose)`、`history(session_id, purpose)`、`to_dict()`。今天**没有**按 purpose 枚举全部修订的读接口，也没有跨 session 枚举。
- 排名设施：`openviking/session/bm25.py` 的 `BM25Index`；`retrieval_facade.py` 的 `_rank_hits`／`_score_breakdown`／`_document_text`／`_pending_score`／`_clip_text`。R1 定下的约定：**非空 query 丢掉 BM25 为 0 的候选**，空 query 保留原顺序。
- fork 文本构造已有：`_fork_retrieval_text(sections)`（`retrieval_facade.py:710`，按 `SEVEN_SECTION_KEYS` 顺序、不含 guidance）与分支动作摘要（R2 的 `_synopsis_from_observation` 那套）。**直接复用，不要另写一套。**
- fork 枚举与 ACL 的既有做法：`ForkBranchAdapter._fork_ids()`（`:910`）+ `get_fork_node`；fork 的标签取 `latest["workspace_id"]`（`:848-851`）。**沿用这个约定。**
- 会话标签的既有做法：`ProjectionRegistry._labels_for(session_id, acl_labels)`（`influence_projection.py:620`），靠注入的 `session_acl` 回调；没有标签就返回空。
- 接地：`InfluenceGrounding`（`causal_experiences.py:435`）字段 `view_revision_id`、`position_kind`（`block`｜`edge`｜`cut`）、`position_ref`、`semantic_summary_snapshot`、`content_hash`、`grounded_at`；`influence_position_key(grounding)`（`:487`）。**注意：`position_ref` 是不校验的不透明字符串**，现有测试里写作 `"block:42"`、`"edge:7"`（`tests/test_fork_revision_lifecycle.py:46,198`）。
- 没有真实向量：`_embedding_stub` 维度 0，`_real_vector` 会拒掉（`retrieval_facade.py:537`）；`EmbedFn` 只在测试里被注入过。

## 要做的

1. **子图检索适配器**：在 `retrieval_facade.py` 新增一个适配器（`name` 用 `"retrieval_subgraph"` 之类），**语料是历史视图的检索子图**。
   - 语料来源：**只取 `purpose == post_run_index`** 的冻结修订上的 `retrieval_subgraphs`（决策 #111：子图只由 commit 后的提取产生），**排除发起查询的那一份 revision 自己**。
   - 需要按 purpose 枚举历史修订：`ViewSupersedeIndex` 上加一个**读**接口（例如 `revisions_for_purpose(purpose)`）。**不要**用 `ViewSupersedeIndex.to_dict()` 当在线读路径——`retrieval_facade.py:36-42` 已经把「离线管理读」列为在线代码不许调用的一类。
   - ACL：沿用 `session_acl` 注入约定（同 `ProjectionRegistry._labels_for`），在候选**进入语料之前**按 principal 过滤；某个 session 拿不到标签时该子图**不可见**（返回空，不许拿 session id 当标签，与 `SegmentAtomAdapter` 的处理一致）。
2. **查询侧只有一个入口**：门面上加方法（例如 `retrieve_historical_subgraphs(view_revision_id, subgraph_id, principal_labels)`）。入参只能是**当前视图上那个失败子图**：
   - 子图必须在该 revision 上存在 → 否则报错；
   - 子图必须 `is_failure`（决策 #102／#103：只有含坏结果的子图发起检索）→ 未打标记的子图调用即报错；
   - 服务端自己解析子图，**调用方不能指定别的子图**，也不能拿历史命中里的子图 id 回头再查（历史子图不在当前 revision 上，天然被这条挡住）。
3. **排名**：query 文本与候选文本用**同一套子图文本表示**（你定，但要确定性、可测）。这一波**没有真实向量**，所以用 `BM25Index` 排（沿用 R1 约定：非空 query 丢 0 分候选；空 query 保序）。相似度算法与文本表示都是**实现侧占位**，不是已定设计——报告中必须写明你选了什么。
4. **命中形状 `诊断子图命中`**（新记录类型，名字你定）：
   - 一份**历史检索子图**（它自己的 block 与该子图内的 claim）；**同一张历史 view 里的旁路子图不在命中里**；不超过 **3 份**；**不足 3 份不回填**（有几份返回几份）。
   - 该子图内**接地的 fork**：`influence_grounding.view_revision_id` 等于这份历史修订，且位置落在该子图内。位置解析规则你定，但要：`block` 看 `block_ids`，`edge` 看 `claim_ids`；`cut` 与任何无法解析的 `position_ref` **一律算不在子图内**（不抛异常、静默不入选）。这也是实现侧占位，报告里写明。
   - fork 的文字：**七段快照 + 分支动作摘要**（决策 #113／Q144-B），**不带 guidance 全文、不带原始 AO**。复用现有构造器。
   - fork 的 ACL 沿用 `workspace_id` 标签约定。
5. **不写任何 fork**，不改失败标记，不做「任务级结论单独再检索一次」，也不为失败子图合成一个对象（不造 `cause_set`、不造 `subtask_id`）。
6. `score_breakdown` 形状与 R1 保持一致（至少 `bm25` / `lexical` / `rank_tier`），让命中可解释。

## 测试

新建 `tests/test_subgraph_retrieval.py`（或你觉得更合适的位置），至少覆盖：

- 最多 3 份：库里有 4 份相似历史子图时返回 3 份；只有 2 份时返回 2 份，**不用别的子图补满**（不返回 0 分的擦边子图）。
- 同一张历史 view 里的旁路子图不出现在命中里。
- 未打标记的子图发起查询 → 报错；不存在／不属于该 revision 的子图 id → 报错。
- 当前 revision 自己不进自己的命中。
- 接地：`block` 位置在子图内 → 入选；`edge` 位置在子图 claim 内 → 入选；落在子图外 → 不入选；`cut` → 不入选；无法解析的 `position_ref` → 不入选且不抛异常。
- 命中里的 fork 文字含七段、含分支动作摘要；**不含 guidance、不含原始 AO**（用带 guidance 与 AO 原文的 fixture 断言这两段文字不出现）。
- ACL：某历史 session 无标签 → 该子图不可见；principal 不匹配 → 被丢在语料之外（不消耗 3 份配额）。
- 排名确定：同一输入重复调用，命中顺序一致。

## 交付要求

- 只改 OpenViking；不顺手重构；不跨波做 R4b／R6 的事。
- 跑：`uv run pytest tests/test_subgraph_retrieval.py tests/test_influence_view.py tests/test_retrieval_facade.py tests/test_fork_revision_lifecycle.py tests/test_influence_projection.py tests/test_trajectory_index.py -q -o addopts=''`。已知基线 3 个失败（`test_influence_projection.py::test_acl_change_without_revalidation_callback_warns_once`、`test_trajectory_index.py::test_missing_projection_registry_warns_once_and_still_indexes`、`test_trajectory_index.py::test_supersede_without_revalidation_callback_warns_once`），不改、如实报告。
- 提交到 `feat/causal-subgraph-retrieval`，`feat(session): ...` 风格，不要 push。
- 回复报：新 commit 短哈希；新增的类与方法签名；**子图文本表示与相似度算法（明确标为占位）**；`position_ref` 解析规则；按 purpose 枚举历史修订的读接口加在哪、是否越过 `retrieval_facade.py:36-42` 的离线围栏；ACL 怎么接的；测试条数与结果；以及任何你觉得两处设计对不上、只能自己选一处的地方——写出来让我去设计对话确认，不要自己下结论。
