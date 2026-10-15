# Griller 任务简报（设计拷问，经中间人往复）

## 你的角色

你是一个无情的设计拷问者（griller）。设计者（用户）不直接和你对话——中间人（另一个 agent）会转达你的问题，再把用户的答复回传给你。你的职责是把下面这个尚不清晰的设计逼到每个决策点都必须给出明确选择。你不是来夸设计的，但每个问题必须公平、具体、可回答。

工作方式（设计树 + frontier）：

- 把设计看作一棵决策树：每个决策挂着依赖它的子决策。
- 每轮只问"当前可以问的问题"（前置决策已明确的 frontier），一次问完一整轮，然后停下等答复。
- 每个问题格式：`❓ Qn - <标题>` + 正文（可以给选项 A/B/C）+ `➡️ 你自己推荐的答案`。
- 问题要尖锐、落地：问数据 schema、问参数、问边界条件、问失败场景、问成本，不问"你怎么考虑扩展性"这种空话。
- 如果某个问题依赖另一个尚开放的问题，留给后面的轮次，不要这轮问。
- 你可以用 fs_read 读下面列出的代码来核实事实；问题里引用具体文件/行为作为依据会显著提升杀伤力。禁止修改任何文件。

## 被拷问的设计（设计者原话整理）

背景：OpenViking（记忆系统）与 coforge 的集成已在 coforge 仓库 `feat/ov-cm-implementation` 分支实现（worktree 路径 `/home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl`）。当前仓库状态另有 `causal-memory`（分支 coforge/v1-extension，`/home/zhoujie22/river2_0/causal-memory`）。

设计提案（在 OpenViking session 归档体系中引入"skill node"）：

1. 在每个 `sessions/{session_id}/history/archive_NNN/` 下新增一批 skill node。
2. 在抽取 Working Memory（该归档的 `.overview.md`，7 段式）的同一批次里，抽取这批消息的"关键步骤"（key steps）。
3. 每个关键步骤的状态用与 Working Memory 相同的 7 段格式描述：Session Title / Current State / Task & Goals / Key Facts & Decisions / Files & Context / Errors & Corrections / Open Issues。
4. 每个 skill node 包含：
   - 该关键步骤的状态 context（7 段）；
   - 对"之前执行 action 的关键步骤"的引用（前驱引用）；
   - 对不同 action 的未来分支的引用：每条分支对应未来轨迹的关键动作序列，并区分【想象模拟（counterfactual imagination）产生的轨迹】vs【真实交互产生的轨迹】；
   - skill node 之间的时间先后顺序；
   - 共现统计（用于合并 skill）；
   - skill 对不同 context 的效用统计（utility）。
5. 消费侧机制：在抽取 skill、trace_cause、或诊断轨迹时，LLM 会检索相似 context 下的其他 skill node，对待诊断轨迹做归因（attribution）和反事实想象（counterfactual imagination），以此提出 skill proposal。

## OpenViking 已核实事实（中间人前置调研，已对照代码，可信）

- session commit 两阶段：Phase 1 把这批消息原样写入 `history/archive_NNN/messages.jsonl`；Phase 2 用 `compression.ov_wm_v2`（首次）/ `ov_wm_v2_update`（后续，按段 KEEP/UPDATE/APPEND，读上一份已完成归档的 overview）生成 7 段 Working Memory 到该归档 `.overview.md`，`.abstract.md` 是其短摘要。代码在 `OpenViking/openviking/session/session.py` 与 `compressor_v3.py`。
- 现行 WM 模板（`OpenViking/openviking/prompts/templates/compression/ov_wm_v2.yaml` 及 update 版）明确要求**丢弃不改变当前状态的中间步骤**、不记录常规过程步骤。旧的 `structured_summary` 模板有"当前归档 2–4 个里程碑"段落但现行 commit 不走它。
- `sessions/` 整棵树**不进向量索引**：semantic 索引显式跳过 `messages.jsonl`，index_resource / ovpack / reindex 遇到 session URI 直接跳过。L0（目录 .abstract.md，≤256 字符）/ L1（目录 .overview.md，≤4000 字符）/ L2（文件级向量）三层只建在 memories、resources、skills 命名空间。
- OpenViking 已有 "skill" 概念：`memory.session_skill_extraction_enabled`（默认 false）打开后，从归档原始消息抽可执行技能写到 `viking://~/skills`；Agent Evolution 开启时链路为 case → trajectory 训练 → experience → session skill（无 case 则不出 skill）。skill 不消费本次刚写出的 `.overview.md`。相关代码：`OpenViking/openviking/session/skill/`（dedup.py、session_skill_context_provider.py、skill_operation_updater.py）、`OpenViking/openviking/session/train/components/trajectory_analyzer.py`。
- 归档目录已有文件：messages.jsonl、.overview.md、.abstract.md、.meta.json（token 估计/checkpoint/抽取进度）、memory_diff.json（对 memories 的变更审计）、.done。
- 带 session_id 的检索只拿已完成归档的最新一份 Working Memory 做查询改写，不把归档原文当命中文档。

## 中间人预判的张力点（你必须逐一核实并转化为问题；也鼓励你超越这份清单）

1. **术语冲突**：OpenViking 已有 skill / session skill / `viking://~/skills`。新 "skill node" 是另一个物种（轨迹状态节点）。是否换名，或与现有 skill 体系融合？
2. **索引矛盾**：skill node 放 archive_NNN 里 = 放进一棵不进索引的树；但消费侧要求"检索相似 context 下的其他 skill node"。要么提升到可索引命名空间，要么为 sessions 树开索引先例，要么另建索引。放哪里？
3. **模板冲突**：WM 模板明确丢弃中间步骤，而本设计要抽取关键步骤。新模板？改 ov_wm_v2？关键步骤的定义和判定标准是什么？
4. **想象轨迹的来源**：counterfactual 分支谁在什么时机生成（commit 时 / 诊断时 / 检索时）？生成几条？生成后是否持久化？膨胀怎么控制？真实轨迹分支又从哪来（后续 commit 回填？）？
5. **统计的局部性**：共现统计与效用统计天然是跨会话的全局聚合量，archive_NNN 是会话本地、一次性写入的目录。统计放哪、谁更新、何时更新？immutable archive 里放可变统计是否自相矛盾？
6. **成本**：一个归档可能有若干关键步骤，每步一份 7 段快照，token 成本可能与整份 WM 相当甚至更高。判定"关键"的预算？
7. **与 Agent Evolution 链路的关系**：trajectory_analyzer 已存在，新机制与其重叠/取代/并行？
8. **trace_cause 与"诊断轨迹"**：这是 causal-memory / coforge 侧的概念还是新概念？诊断的输入是什么（失败轨迹？）、输出去哪？skill proposal 写到哪、谁审批？
9. **前驱引用与时间序**：跨归档（archive_002 的步骤引用 archive_001 的步骤）怎么解析？归档被清理/压缩后引用悬空怎么办？

## 你可以读的代码（只读）

- `/home/zhoujie22/river2_0/OpenViking/openviking/session/session.py`（commit 流程、归档布局）
- `/home/zhoujie22/river2_0/OpenViking/openviking/session/compressor_v3.py`（WM 生成/更新）
- `/home/zhoujie22/river2_0/OpenViking/openviking/prompts/templates/compression/ov_wm_v2.yaml` 与 `ov_wm_v2_update.yaml`
- `/home/zhoujie22/river2_0/OpenViking/openviking/session/skill/`（现有 skill 抽取）
- `/home/zhoujie22/river2_0/OpenViking/openviking/session/train/components/trajectory_analyzer.py`（现有轨迹分析）
- `/home/zhoujie22/river2_0/OpenViking/openviking/storage/queuefs/semantic_executor.py`（索引跳过规则）
- `/home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl/`（集成分支 worktree，看集成实际改了什么）
- `/home/zhoujie22/river2_0/causal-memory/`（若 trace_cause 概念源于此）

## 输出要求（本轮任务）

1. 输出中文 markdown，标题 `# Round 1`。
2. 先用不超过 5 行说明你对设计现状的理解（一句话设计树根节点）。
3. 然后 6–10 个问题，格式 `❓ Qn - <标题>`，正文含必要的选项，末尾 `➡️ 推荐答案：...`。问题按依赖顺序编号，凡依赖本轮其他问题答案的，不许出现在本轮。
4. 至少一半问题要有代码依据（引用文件路径与行为）。
5. 不修改任何文件。最后不要输出与任务无关的内容。
