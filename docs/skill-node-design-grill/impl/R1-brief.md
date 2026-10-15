# R1 brief：因果检索初排（BM25／混合档）、fact 通道暂停、邻域展开只走 influence

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（已建好，从 main 切出）。不要 push。

设计依据（先读再动手）：

- `/home/zhoujie22/river2_0/skill-node-design-grill/CONSENSUS.md` 叙述 86、87、88、106；决策表 #95、#96、#97、#115。
- `/home/zhoujie22/river2_0/skill-node-design-grill/CONTEXT.md` 的「因果检索初排」「因果检索配额」「邻域展开」「检索子图」四条术语。

主文件：`openviking/session/retrieval_facade.py`（现有 19 个测试在 `tests/test_retrieval_facade.py`）。

## 任务 1：fact 通道暂停（叙述 87、决策 #96/#97）

`HybridRetrievalFacade.retrieve` 不再返回 segment/atom 卡片。那 2 个位子**留空、不回填**给 fork 或投影；一次结果最多 6 张 fork/branch 加 4 张投影，共 10 张；查询级总帽仍是 12（`CAUSAL_MEMORY_CAP` 不改）。

- 不要靠在调用点传 0 配额 profile 来"实现暂停"（`benchmark/causal_memory/l1_locomo_hitk.py` 里那种反向用法不是实现）。要一个**显式的暂停开关**，默认暂停，恢复时改一处：建议模块常量 `FACT_LANE_PAUSED = True` 加构造参数 `fact_lane_paused: bool | None = None`（None 取常量），具体形式你定。
- 暂停期间不调用 `segment_atom` adapter 的 `search`，不产生 `channel="fact"` 卡片，`DEFAULT_SEGMENT_ATOM_QUOTA = 2`、`CARD_KINDS`、`FACT_KINDS`、`CARD_CHANNELS` 全部保持不变（恢复时它们还要用）。
- profile 校验不变：三者相加超过 12 仍抛 `QuotaError`。
- 测试：既要覆盖"暂停时结果里没有 segment/atom、长度 ≤10、fork 够 8 张也只出 6 张（不回填）、cap 仍 12"，也要覆盖"开关打开时回到 6/4/2 的旧行为"。既有依赖 fact 卡片的断言要相应更新，不要删掉能力。

## 任务 2：因果检索初排改成 BM25（叙述 86、决策 #95）

三份语料的初排从"子串匹配 + 常数分"（`_text_hits` / `_score`，现在恒定返回 `{"lexical": 1}`）改成 BM25。这是**默认档**。

- 新建 `openviking/session/bm25.py`，自己实现标准 BM25（k1=1.2、b=0.75 可传参），**不要引新依赖**（`rank_bm25` 不在 `pyproject.toml` 里，`rapidfuzz` 只用于别处）。
- 每份语料的"文档文本"沿用今天已经送进 `_text_hits` 的那些字段集合，只换打分：fork/branch 用今天序列化出来的 revision blob，投影用摘要／卡片 id／语义类型／解析后的 AO 文本，segment/atom 用它的 blob（暂停后这一路暂时不走，但实现要留着）。
- 空 query：所有文档同分，**保持写入顺序**（`_assign_ranks` 的稳定顺序语义不变）。没有任何共同词的文档：不进入结果（BM25 分为 0）。
- 分数写进 `score_breakdown`，形状要能解释，例如 `{"bm25": <float>, "lexical": ...}`，保留 `FEATURE_SPEC_VERSION` 那类版本说明的位置。
- ACL 过滤仍在花配额之前（既有语义不动）。
- 测试：共同词命中、无共同词落选、词频/文档频率改变名次、空 query 保持顺序、配额仍按语料分别生效。

## 任务 3：混合档 —— BM25 与真实向量合成名次（叙述 86、决策 #95）

增加一个**显式可选**的混合档：BM25 分与真实向量相似度合成名次。

- 今天投影上的 `embedding_stub` 维度为 0（`openviking/session/influence_projection.py` 里的 `_embedding_stub`），**它不算向量档**。
- 没有真实向量、embedder 不可用、或向量维度为 0 时：这一次**仍按纯 BM25 返回，绝不交回空列表**，并在结果或特征里记明这一次实际用的是哪一档。**不设"只有向量"这一档。**
- 做成可注入的 seam（例如 facade 构造参数 `embedder: EmbedFn | None = None`，配 profile 上的档位选择），默认纯 BM25；用一个测试假 embedder 覆盖混合档合成与"维度 0 → 退回 BM25"两条路径。

## 任务 4：邻域展开只走 influence（叙述 106、决策 #115）

`InfluenceProjectionAdapter.expand_claim_neighborhood`（以及 `HybridRetrievalFacade` 上的委派）：

- 建邻接之前滤掉 `relation_type != RELATION_INFLUENCE` 的 claim，**skip 不进邻接**。
- 种子自身若是 skip：它的边不进邻接（两端 block 仍在起点集合里），返回的 `edges` 只含 influence 边。
- **保留**：双向走（从下游也能走回上游）、最多 12 个 block 的上限、`check_path_budget` 的预算检查、"只在这次返回里、不落对象"。
- 测试：库里有 skip 边时不踩；只靠 skip 相连的一截停下；种子是 skip 时的行为；双向仍可达。

## 边界（本轮不做）

fork 卡片带七段与分支摘要（#113/#114）、子图提取与失败标记（#101/#108）、诊断子图检索（#104）、`TrajectoryIndexService` 挂到 session commit（#110/#111）。这些是后续波次，本轮不要顺手做。

## 交付要求

- 只改 OpenViking。不要动 `benchmark/`，除非签名变化逼得必须改（那就最小改动）。
- 不加新依赖；代码风格与既有文件一致；不顺手重构无关代码。
- 必须跑过：`uv run pytest tests/test_retrieval_facade.py tests/test_influence_view.py tests/test_influence_projection.py tests/test_trajectory_index.py -q`；再跑一次 `uv run pytest tests/ -q` 看有没有更宽的回归（既有失败要如实记录，不要掩盖）。
- 提交到 `feat/causal-subgraph-retrieval` 分支，提交信息用仓库既有的 `feat(session): ...` 风格，**不要 push**。
- 回复里报：分支与 commit 短哈希、改了哪些文件、测试命令与结果摘要、以及任何与设计对不上的地方（发现了就说，不要自己改设计）。
