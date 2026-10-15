# R8a 派发件：SkillsBench 录制轨迹上的**影响图抽取**＋**fork 抽取**＋**跨任务泛化测量**（零 LLM／只读／可续跑）

用户原话（2026-09-30）：**「让cursor测一下skill相关的benchmark，测试influence graph和fork的抽取，并看能不能泛化到新的任务」**。

本波是**评测浪**，不是设计浪：不改任何设计、不改任何生产签名、不改任何既有文件。失败要如实报，不许把没测到的东西写成测到了。

---

## 0. 为什么是这一浪（先读，避免跑偏）

我（编排侧）勘察后确认的一个事实：**`InfluenceClaim` 与 `RetrievalSubgraph` 至今从未在真实语料上被构造过**——生产代码里只有 `influence_view.py:1573` 的 `_fallback_link` 内部构造，其余构造点全在 `tests/` 里。也就是说「影响图（带关系边的 claim）」和「失败子图＋fork」到本波为止**只被单元测试和 R3／R4a 夹具碰过**。上一浪 R7a 已给出原因：L1（LoCoMo）的 fallback 视图**没有跨消息边**，结构轴在那里无法被测量（账本 #130）。

SkillsBench 的录制轨迹正好补上这个缺口：它是**真实 agent 轨迹**（每条 13–78 次工具调用），且有一批**在固定预算处被截断**的 episode——这就是失败子图与 fork 的天然语料。

**本波要回答三问**：(1) 影响图能不能从真实轨迹里抽出来并通过生产冻结校验；(2) 失败子图＋fork 能不能写成、读回、幂等、且守住 ACL 门；(3) 抽出来的东西能不能**泛化到没见过的任务**（在可测量的口径下，见 §3）。

---

## 1. 语料事实（我已逐条核过；不要再猜路径与数字）

### 1.1 题目与切分

- `/home/zhoujie22/river2_0/evol_bench/SkillsBench/data/sb-full.jsonl`：**87 题＝42 train / 45 test**，按 category 分层、`SPLIT_SEED = 42`（`evol_bench/SkillsBench/code/skillsbench_official.py:45,113`）。
- 每条字段：`benchmark, converter_version, domain, episode_id, family_id, grader, order, role, schema_version, split, stage_files, task_id, turns, selection, upstream`。
- **题面在 `turns[0].prompt`**；`grader` 只有验证器元数据（`kind/task_id/domain/difficulty/verifier_timeout`），**不是裁决结果**。
- 10 个 category 名（train/test 各半）：`sb_software-engineering`(8/8)、`sb_industrial-physical-systems`(7/7)、`sb_natural-science`(7/7)、`sb_office-white-collar`(7/7)、`sb_finance-economics`(4/5)、`sb_mathematics-or-formal-reasoning`(4/4)、`sb_cybersecurity`(3/4)、`sb_media-content-production`(2/3)。

### 1.2 录制轨迹（本波的抽取对象）

根目录：`/home/zhoujie22/river2_0/evol_bench/SkillsBench/results/sb-train-wsb-dsv4flash-r1/work-warm-skill-batch/`

- `episodes/0001..0014`：**14 个 episode 目录**（14 个 train 题，非全部 42 题）。
- 每个 episode 目录内：
  - Pi transcript `2*.jsonl`：每行一个记录，`{"type": "session"|"model_change"|"thinking_level_change"|"message", ...}`；`message` 记录形如 `{"message": {"role": ..., "content": [ {"type":"text"|"toolCall"|"toolResult", ...} ]}}`。工具调用名 `run_command`（普通 episode 的 0004 里也有 `bash`）。**注意 0014 的 transcript 是被截断的坏 JSON（最后一行不可解析）——读取必须容错并如实报"截断"。**
  - `host-events.jsonl`：room 级事件（`turn_start`、`recall`（本运行 `items` 全空）、…）。
  - `sb-task.json`：**只有 `{"task_id": ...}`**（题面不在这里，在 transcript 首条 user 消息里，也在 §1.1 的 `turns[0].prompt` 里）。
  - 部分 episode 另有 `sb-actions.jsonl`（`{call_id, command, exit_code, stdout_tail}`）。
- `attempts.jsonl` **只有 7 行**（5 成功 2 失败）：
  - **recorded success（5）**：0002、0004、0005、0006、0007。
  - **recorded failure（2）**：0001、0003 —— `status=failed, failure_kind=task, error="PI_CANCELLED: context deadline exceeded"`，`duration_seconds ≈ 1800.03`（即 1800s agent 预算耗尽）。
- **无 attempts 记录（7）**：0008、0009、0010、0011、0012、0013、0014。该 run 在 08:01 被外部掐断（见目录时间戳；0014 的 transcript 是坏 JSON）。**不许把"没有 attempts 行"读成"没有发生"，也不许自己判定它们的成败**：本波把它们按**轨迹尾部形状**分两档、并**两个口径都跑一遍**：
  - 尾部**在工具调用/工具结果处戛然而止**（回合被打断）：0008、0010、0012、0014。
  - 尾部**以一段文本结尾**（可能收敛、也可能是在写文本时被掐）：0009、0011、0013。
- 我（编排侧）已用独立脚本逐 episode 核过尾部形状（`tool_calls` 合计 444）：读轨迹时**必须容错**（0014 坏 JSON），并把每条 episode 的尾部形状原样报出来。
- **失败子图语料因此有两个口径**：窄口径 = 2 recorded failure + 4 打断 = **6 个**；宽口径 = 再把 3 个"文本结尾但无记录"算进来 = **9 个**。**两个口径的 L2/L3 结果都要报。**
- `_mechanism/lifecycle-stage2a.jsonl`（在 `results/_mechanism/`）：容器生命周期事件，`image_built`／`env_created`（带 `limits: {"cpus":1,"memory_mb":4096,"verifier_timeout":600.0,"agent_timeout":1800.0}`）／`exec`（`call_id, command, exit_code, stdout, stderr`）。
- `diagnosis/0002,0004,0005,0006,0007/`：**模型写的自然语言诊断**（DeepSeek-V4-Flash，逐 chunk 读轨迹后写的结论，5 个全部结论为 `NO_SKILL`）。它们是**窄用途 prompt 的产物（skill 抽取门）**，不是中性摘要，只能作对照视角，不能当作 ground truth。

### 1.3 **语料最硬的事实：全语料零裁决**

14 个 episode **没有任何 grader 裁决**（成功/失败只有 attempts 里的 `status`，且只有 2 条失败有记录；`final_output` 是**模型自己写的总结**，不是判分）。因此：

> **"任务成功率"层面的泛化在本语料上不可测。** 本波只测**检索/抽取层面**的泛化（§3），并且必须在报告里把这条写清楚。

---

## 2. 要建的东西

新文件：**`benchmark/causal_memory/sb_influence_extraction.py`**（唯一新增文件；其它文件一律不改）。

### 2.1 L1：影响图抽取（每 episode 一个 adaptive 视图）

- 台账写入：把 transcript 记录按顺序 append 成 AO（用与既有跑分件相同的方式：`_view_ao_record`／`_page_ao_records`／`appender`，参考 `benchmark/causal_memory/l1_locomo_oracle_arm.py` 与 `l1_locomo_ranked_arm.py` 的用法；**照抄它们的构造形态，不要自创**）。
- **block 粒度规则（确定性，写进 `granularity_reason`）**：一条 transcript 记录 = 一个 block。
  - 首条 user 消息 → `role = ROLE_TASK`（`participant_id = "user"`，`segment_id = f"{episode_id}:task"`）。
  - 有最终总结的最后一条 assistant 文本记录（若有）→ `role = ROLE_CONCLUSION`。
  - 含 `toolCall` 的记录 → `role = "agent_action"`，`input` = 该记录前的 assistant 文本（可空串），`output` = 该 toolCall 的 `arguments.command` 截断文本。
  - 纯文本、无工具调用的 assistant 记录 → `role = "orchestrator"`。
  - `toolResult` 记录 → `role = "agent_action"`，`output` = 结果文本截断，`input` = 空串。
  - 其余记录（`session`/`model_change`/`thinking_level_change`）**不进 block**（但必须出现在 coverage 的 inspected 或 omitted 里，见下）。
  - `participant_id`：task 块为 `"user"`，其余为 `"agent"`（整条 episode 只有一个 agent 参与者——单 agent 现实）。**block 内所有 source_refs 必须同 participant 同 segment**（生产 `InfluenceBlock.validate` 会拒跨参与者的块）。
  - `source_content_hashes` 用台账里该 AO 的 content hash（从记录里取，不要自己编）。
- **claims（影响图的关系边）**：对**相邻** block 依次判定，规则确定性：
  - 若两块之间发生了**可观察的干预→效果**（前块是 `agent_action` 且带工具调用，后块是该调用的结果，或前块的结果后块给出了具体后续动作）→ `relation_type = RELATION_INFLUENCE`，`carried_artifact` = 工具调用命令的首个 token（如 `run_command`／`bash`），`downstream_effect` = 后块的可观察效果（exit_code 或输出的确定性摘要）。
  - 否则 → `relation_type = RELATION_SKIP`，`carried_artifact = "no-effect"`，`downstream_effect = "no observable change"`。
  - 证据：`influence` 边**必须**带 `source_evidence_refs` 与 `target_evidence_refs`（`InfluenceEvidenceRef`，指向真实 AO，字段照 `tests/test_extraction_write.py:137` 的 `_evidence` 构造：`ao_id, source_session_id, source_archive_id, archive_commit_watermark, source_sequence, source_read_snapshot_watermark, evidence_role="contemporaneous_basis", evidence_content_hash, captured_state="committed"`）。**不许编造 ref**：每个 `ao_id`／`source_sequence`／`evidence_content_hash` 都必须能在台账里解析到，否则脚本自己先失败。
- **coverage**：`CoverageManifest(total_ao_range=..., inspected_refs=..., included_ranges=..., omitted_ranges=..., snapshot_watermark=...)`，必须与台账逐条一致（进了 block 的 AO 在 included，没进的在不进任何 block 的原因里）。构造样例见 `l1_locomo_oracle_arm.py:340`。
- **冻结**：`freeze_extracted_view(session_id=..., task_run_id=..., view_id=f"{session_id}:{PURPOSE_POST_RUN_INDEX}", revision_id=..., frozen_at=..., blocks=..., claims=..., coverage=..., retrieval_subgraphs=...)`。
  - 注意 `freeze_extracted_view` **硬编码 `purpose=post_run_index`**（`extraction_write.py:111-150`）——这是生产签名，**不许改**；`purpose=failure_diagnosis` 的连通性规则（恰一个 task root、一个 sink、弱连通）只在该 purpose 的视图上生效（`influence_view.py:1243`），本波不涉及。
  - `HighSeverityViolation` 一律**原样上报**，不许 try/except 吞掉、不许降级成 fallback。
- 分段落盘：**stage1 = 1 个 episode**，然后 **stage2 = 全部 14 个**；`--out <path>` + `--resume` 逐 episode 落盘（R7a 教训：长跑必须可续）。

### 2.2 L2：失败子图 + fork（两口径：6 个／9 个，见 §1.2）

- 对每个"失败候选" episode 写**恰好 1 个** `RetrievalSubgraph`（窄口径 6 个：0001、0003、0008、0010、0012、0014；宽口径再加 0009、0011、0013）：
  - `block_ids` ≤ `MAX_RETRIEVAL_SUBGRAPH_BLOCKS`（= 12，`influence_view.py:47`）；选择规则确定性（例如"末 12 个 block"或"task 块 + 末 11 个"，写清在报告里）。
  - `claim_ids`：其**两端都必须在该 subgraph 的 block_ids 内**（否则 `subgraph_claim_endpoint_outside`）。
  - `failure_marked = True` 且 `failure_evidence_refs` **非空**（两者必须同时成立或同时不成立：`influence_view.py:1424-1441`）。证据锚取**截断处附近**的真实 AO（最后一条可解析记录）。
- fork 写入：`write_failure_subgraph_fork(store, revision, subgraph_id, ...)`（`subgraph_forks.py:144`）。**字段要求（我核过生产校验，别再猜）**：
  - `seven_sections`：`SEVEN_SECTION_KEYS` 七键**齐全且非空**（`session_title, current_state, task_and_goals, key_facts_and_decisions, files_and_context, errors_and_corrections, open_issues`）。
  - `branches`：每条必须是 dict，且 `branch_id` 非空 str、`evidence_status ∈ {"real","imagined_synthetic","imagined_unverified"}`（`causal_experiences.py:71`；本波恒为 `"real"`——有录制事件支撑）、`ao_sequence` 是 str 列表、`guidance` 是 dict 或 None（free-form，照测试用 `{"instruction": ...}`）。
  - `position_kind`：`POSITION_KINDS = {"block","edge","cut"}`，但 `_semantic_summary_snapshot`（`subgraph_forks.py:309-326`）**只解析 `block`／`edge`，`cut` 返回 None ⇒ 写前 raise**——本波**只用 `block:<block_id>`**（`position_kind="block"`，`position_ref=f"block:{block_id}"`），且该 block 的 `summary` 必须非空。
  - `contemporaneous_basis` **必传**（不能只给 anchor：`subgraph_forks.py:180-184`）。
  - `workspace_id` 必须在 `workspace_labels` 里（`_require_workspace_in_labels`），store 用 `CausalExperiencesStore(root, config={"skill_trajectory_mode": "causal"})`（照 `tests/test_subgraph_forks.py:44,233`；**不要创建 `ov.conf`**）。
- **三个必须有的门**：
  1. **幂等**：同 revision＋subgraph＋同 payload 第二次调用返回同一个 fork（不新增文件）。
  2. **ACL 负例**：`workspace_id` 不在 `workspace_labels` 里 ⇒ 拒绝且**磁盘上零新增文件**（照 `tests/test_subgraph_forks.py:689-694`）。
  3. **读回**：从 store 读回该 fork，七键与写入一致，grounding（`view_revision_id`/`position_kind`/`position_ref`/`content_hash`）可解析回 revision。

### 2.3 L3：泛化测量（**检索级**，必须标注不是任务成功率）

对下面每一问都跑**同一个查询接口**（生产检索面：`HybridRetrievalFacade` + fork 适配器；参考 `tests/test_subgraph_forks.py:626` 的 `ForkBranchAdapter(root, store)` 组装方式），并**同时**跑一个**词法基线**（对其它 episode 的原始 transcript 文本做 BM25，同一批 query、同一 k）作为对照：

- **(a) 留一任务（leave-one-task-out，n=14）**：用其余 13 个 episode 建的图/fork 做语料；对留出 episode 的**前缀**发查询（前缀 = 前 `ceil(工具调用数/2)` 步，确定性，与抽取器无关）；看 top-k 里是否命中该 episode **后半段**真实出现的模式。分母＝后半段事件数；**判"命中"的定义必须在跑之前写死并打印出来**。
- **(b) 跨 family 切片（关键）**：把 (a) 里 query 与命中来源**不同 family** 的配对单独报。理由（R7a 教训，`R6e-verification.md` §5）：词法方法在饱和区测不出结构价值；能区分结构与否的切片，恰恰是"query 与答案没有表面词重合"的那部分。若这一片上结构不优于词法基线，**如实报**（这是一个合格结论，不是失败）。
- **(c) 45 个 test 题（只有题面、没有轨迹）**：用 `turns[0].prompt` 发查询，报 top-k 命中的 family 分布与"命中的是否 failure fork"。**这是"新任务"的接口演示，不是泛化度量**——报告里必须这么写。
- **(d) 明确缺口**：真正"泛化到新任务"＝新任务上任务成功率变化，需要 paused live 栈 + 模型额度（`eval/NEXT.md` 的「不要动」清单 + 额度限制）。**本波不许碰 live 栈、不许调用任何模型**；把缺口写成"未测"。

---

## 3. 硬约束（照旧，逐条遵守）

1. **只读录制件**：`evol_bench/SkillsBench/results/**` 与 `evol_bench/SkillsBench/data/**` 一律不许写、不许改。本波全部产物落 `/tmp/sb-influence/`。
2. **零 LLM、零网络、不加依赖**（不新增 pyproject 依赖）。不调用任何模型 API。
3. **不改既有文件**：`benchmark/causal_memory/l1_locomo_hitk.py` 必须**逐字节不变**；`l1_locomo_projection_arm.py`、`l1_locomo_ranked_arm.py`、`l1_locomo_oracle_arm.py` 也不许改。新代码只在 `benchmark/causal_memory/sb_influence_extraction.py`。
4. **源码零改动**：`openviking/**`、`tests/**` 不许改。**如果生产签名不够用，不许改签名**——停下来，把缺口（缺哪个参数/哪个校验挡路）写进报告，交编排侧裁定。
5. **不动 paused live 栈**（18888／1933／8789／8732／8733／`coforge-openviking-prototype-1`／共享 `coforge` DB）；不建 `ov.conf`；不 push。
6. **确定性**：同一输入两次运行，产物 JSON **逐字节一致**（这是门检之一）。
7. **本波是评测浪**：不许为了让数字好看而改抽取规则——规则先写死、跑完再报；要改规则就重跑并两个数字都报。

---

## 4. 门检（任一条不过就非零退出，不许"跳过"）

1. **台账一致性**：每个 block 的 `source_refs` 都能在台账解析到；同块内同 participant 同 segment；`ao_start_seq ≤ ao_end_seq` 且跨度非空。
2. **claim 证据可解析**：每条 `influence` claim 的 `source_evidence_refs`/`target_evidence_refs` 逐个能在台账里查到 `ao_id`＋`source_sequence`＋`evidence_content_hash`（我会独立复算这一步）。
3. **零冻结拒绝**：`freeze_extracted_view` 对所有 14 个 episode 成功；若有拒绝，**原样贴出 `Violation` 全文**并以非零退出。
4. **子图结构**：每个 failure subgraph 的成员闭合（claim 两端在成员内）、块数 ≤ 12、`failure_marked ⇔ failure_evidence_refs 非空`。
5. **fork 完整性**：七键齐全非空；`position_ref` 可解析；读回一致；幂等；**ACL 负例被拒且磁盘零新增**。
6. **控制门**：伪造/不存在的 `ao_id` 或 `claim_id` 必须被拒（自检：故意造一条坏 claim，确认生产校验会拒——这条要在报告里贴出被拒的 violation code）。
7. **两次运行逐字节一致**。
8. **失败判定不许靠单一来源**：逐 episode 报出判据——(a) `attempts.jsonl` 的 `status`（只有 5 success／2 failed），(b) 轨迹尾部形状（`toolCall`/`toolResult` 处戛然而止 vs 文本结尾），(c) 坏 JSON（0014）。**没有 attempts 行的一律标 `unrecorded`，不许写成"成功"或"失败"**；L2/L3 的窄／宽两口径结果都要给。

---

## 5. 报告要求（`impl/R8a-cursor-raw.log` 是 nohup 原始输出，正式报告写在你的最终消息里）

1. **抽取值表**（每 episode 一行）：`episode_id | task_id | family | 确认状态（recorded success/failed/unrecorded） | 尾部形状 | 工具调用数 | block 数 | claim 数（influence/skip） | subgraph 数`。
2. **fork 表**：`episode | subgraph_id | 块数 | position_ref | 七键字节数 | 幂等 | ACL 负例`。
3. **L3 三张小表**：(a) 留一出命中率（结构 vs 词法基线，逐 episode）、(b) 跨 family 切片（同样的两列）、(c) 45 个 test 题面的 top-k 命中分布。每张表都要标 n。
4. **明确"没测什么"段**：任务成功率泛化（无裁决＋live 栈两重限制）、模型驱动抽取（本波是**确定性 stand-in**，忠实版本要 Phase 2 模型调用＝账本 #125，需用户授权额度）、其余 28 个 train 题与 45 个 test 题无轨迹。
5. **残余与阻塞**：任何签名不够、校验挡路、语料损坏（0014 坏 JSON）都要点名。
6. 运行命令、耗时、退出码、产物路径；`git show --name-only` 的输出贴在报告里。

---

## 6. 分段执行（必须）

- **stage 1**：1 个未收敛 episode（建议 `0001-sb-fix-druid-loophole-cve`，它有 attempts 失败记录）走完 L1→L2→读回，报告通过后继续。
- **stage 2**：全部 14 个 episode 走 L1；失败候选走 L2（窄口径 6 个：0001／0003／0008／0010／0012／0014；宽口径再加 0009／0011／0013）。
- **stage 3**：L3 三问 + 基线。
- 每段结束打印进度并落盘 `--out`；`--resume` 必须可用（长跑可续是硬要求）。

---

## 7. 提交

一个提交，只含新增文件 `benchmark/causal_memory/sb_influence_extraction.py`。提交信息用 `bench(causal-memory): ...` 前缀（与既有风格一致）。**不许 push。** 若发现需要改任何既有文件才能跑通，**先停**并报告（本波不允许）。
