# R9 派发件：#125 抽取模型的输出契约（先把「零模型调用」那半边做完并验收）

先读 **`impl/R9-design.md`（本波设计正文，裁定 #157–#163、改动面与判据都已冻结）**，再读 `impl/pending-design-decisions.md` 第 15 条（长期记忆提取那四处过滤的 file:line）、`impl/R8a-verification.md` §5（#138：生产证据门不查台账的现场证据）、`impl/R9-design.md` §1 的现场事实表。

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支 `feat/causal-subgraph-retrieval`，基线 **`19c8cf934`**。**追加新提交；不要 rebase／amend；不要 push；不引新依赖。**

## 0. 一句话

Phase 2 的插座是空的：`ExtractionProvider`（`extraction_write.py:108`）没有任何生产调用方，而且**即使注入了提供方也拿不到台账**——`_build_locked` 只在没有 builder 时才构造台账快照（`trajectory_index.py:511-525`）。本波做两件事：(a) 给模型一条看得见台账的输入通路；(b) 定一份「只选不造」的 JSON 契约并把它解析成生产 `ExtractionPayload`，并**在提取侧输入边界上收口 #138 的后半**（不可解析的证据一律拒）。**本波不调用任何模型**：真模型走的是另一个假不了的口（`--mode model`，要用户单独授权提供方）。

**这是契约与管道测试，不是效果量测试。** 它不回答「模型抽取比确定性抽取更有用」。

## 1. 只做四件事

### 1.1 新生产模块 `openviking/session/extraction_contract.py`（照设计 §2 #158／#159／#160）

冻结常数（值可以选，但选定即冻结、启动时打印）：`EXTRACTION_CONTRACT_VERSION = "extraction-contract-v1"`、`EVIDENCE_ROLE = "contemporaneous_basis"`、逐字符串值的 `VALUE_CLIP`、列表元素的 `MAX_ITEMS`、单次调用的 `MAX_TOKENS_PER_CALL`、整轮 `MAX_TOTAL_TOKENS`、`MAX_REPAIRS = 1`、`MAX_INPUT_CHARS`。**任何一个上限被触到都必须非零退出／抛错，不许静默截断。**

四件东西：

1. `build_model_input(snapshot) -> dict`：把钩子给的提交快照投影成模型输入。快照里 `ao_records` 是六字段投影（`ao_id/sequence/participant_id/segment_id/session_id/content_hash`），`ledger_rows` 是**同一分页顺序**的原始行（见 1.2）。两者**按下标 zip**，逐条断言 `ao_id`／`sequence` 相同，不等即 `ExtractionContractError`。逐行的 `action`／`observation` 用**形状无关**的方式投影：键全部保留、顺序规范（`sort_keys`）、逐字符串值截到 `VALUE_CLIP`、列表截到 `MAX_ITEMS`——**不许**硬编码 R8a 那套键名（R8a 语料的行是 `action{record_kind, acl_labels, segment_id, participant_id, transcript_type, block_kind}` ＋ `observation{synopsis}`，生产的录制器写的是 `action{tool, tool_id?, arguments?}` ＋ synopsis 观测，两种都要能过）。加 `snapshot_watermark`。总长超 `MAX_INPUT_CHARS` ⇒ 抛错（调用方按「输入超限」记账，不发调用）。
2. `render_contract_prompt(model_input) -> str`：指令正文（**规则逐条写清**：块＝同 participant 同 segment 的连续 AO 区间且互不重叠；只能引用给你的 `ao_id`；`evidence_content_hash` 必须原样回抄；失败标记只能由你写、且必须配证据；不得使用 `deterministic_fallback`／`synthetic_root_sink` 当 `granularity_reason`；只输出一个 JSON 对象、不要别的文本）＋ 契约 JSON 的字段清单与取值域（`BLOCK_ROLES`／`BLOCK_KINDS`／`relation_type`／`status` 从**生产模块 import**，不许手抄一份词表）。
3. `parse_contract_response(text, model_input) -> ExtractionPayload`：剥 ```json 围栏 → `json.loads` → 严格字段与类型检查 → **对账**（设计 §2 #160 的清单）→ 构造 `InfluenceBlock`／`InfluenceClaim`／`CoverageManifest`／`RetrievalSubgraph`。**派生字段由解析器从快照算、模型不写**：块的 `source_refs`（区间内每行的六元 `SourceRef`）与 `source_content_hashes`、证据的 `source_session_id`／`source_sequence`／`source_read_snapshot_watermark`／`evidence_role`（常数）／`captured_state`／两个 archive 字段（`None`）、coverage 的 `included_ranges`（从块区间推）／`total_ao_*`（快照首末）。coverage 的另外两项照设计 §2 #158 的最后一条：`inspected_refs` ＝ **模型声明的 `inspected_ao_ids`**（校验 ⊆ 快照，**不是**推导成全部行）；`omitted_ranges` 模型**可写**（带自己的 `reason`），解析器验它与块区间构成快照的**精确划分**（互不重叠、无缝隙、并集恰是 `total_ao_*` 跨度），**没写就用常数理由 `record_type_not_a_block` 推导**。**模型只写**：块的身份区间与 `participant_id`／`segment_id`／角色类字段与三段散文、claim 的两端与散文类字段、每条证据的 `ao_id` ＋ `evidence_content_hash`（**回抄**）、子图的成员与标记、以及 `coverage` 的 `total_ao_*`／`inspected_ao_ids`／`snapshot_watermark`。任一条对账失败 ⇒ `ExtractionContractError`（新异常类型），**不修、不部分接受、不降级**。
4. `model_extraction_provider(vlm_handle, *, max_repairs=1) -> ExtractionProviderFactory`：`ExtractionProviderFactory = Callable[[Mapping[str, Any]], ExtractionProvider]`（**工厂**，因为 prompt 由提交快照决定）。唯一调模型的地方：`vlm_handle.get_completion_async(messages=[...], max_tokens=MAX_TOKENS_PER_CALL)`；用量从响应的 `usage` 取并累加，**总用量超 `MAX_TOTAL_TOKENS` 即抛**；**只在解析失败时重试**、次数 ≤ `max_repairs`，其余异常直接上抛。**不读文件、不读配置、不建客户端、不 import `ov.conf`。**

### 1.2 生产接线：三处加性小改（`trajectory_index.py`／`extraction_write.py` **零改动**）

**不要给 `Builder`／`ExtractionProvider`／`extraction_index_builder` 加参数**——`tests/test_trajectory_index.py` 有 15 处三参 builder，加了就全断。按设计 §2 #159 走**工厂**：

- `trajectory_index_hook.py`：`_page_ao_records(...)` 的返回值**留着**（今天是随用随丢的列表推导，`ao_records` 由它派生，`ledger_rows` 进快照 dict）；`_index_commit`／`maybe_index_session_trajectory` 各加 `extraction_provider_factory=None`；有工厂时 `provider = factory(snapshot)`（`snapshot` ＝ `fallback_session(job)` 那个 dict **＋ `ledger_rows` 键**）→ 仍走 `extraction_index_builder(provider, frozen_at=job.enqueued_at)`。**原来的三参通道一行不动、行为不变**（既有 `extraction_provider` 与工厂可同时为空／只有一个）。
- `session.py`：`extraction_provider_factory=None` 关键词参数 ＋ `_run_post_extraction_causal_seam` 在**有工厂时也走钩子**（今天是 `if provider is not None:`）。两个都空 ⇒ 钩子仍不调用（Phase 1 已写 fallback，别多花预算）。
- `session_service.py`：`set_extraction_provider_factory(factory)` ＋ 构造 session 时透传。**`set_extraction_provider` 与其语义、文档串一个字都不改。**

`ledger_rows` 是新键、**加性**：`build_minimal_fallback_view` 只读已知键 ⇒ fallback 视图必须逐字节不变（§4 门 3 要证）。

### 1.3 新跑分件 `benchmark/causal_memory/r9_model_extraction.py`

语料（只读）：`/tmp/sb-influence-r8c/checkpoints/*.json`（14 个 episode 的**已冻结画布修订**，键 `revision` 里就有 `blocks`／`claims`／`coverage`／`retrieval_subgraphs`／`content_hash`；**这就是本波的画布基准**）。R8a 抽取件 `benchmark/causal_memory/sb_influence_extraction.py` **只许 import、只许调用**（它已有 `_parse_transcript`／`_append_ledger`：后者把 episode 的事录写进**真** `AOLedger` 并返回分页后的行）——**它的文件一个字节都不许改**。

- `--mode fake`（默认，**零模型调用**）：把每个 episode 的 `revision` 编码成契约 JSON（**编码器只写在这个跑分件里**，生产模块不许有「从画布反向生成契约」的函数）→ 交给**生产** `parse_contract_response` → 把得到的 `ExtractionPayload` 经 `freeze_extracted_view` 冻结（`frozen_at` 用固定戳）→ 与画布修订在 `blocks`／`claims`／`coverage`／`retrieval_subgraphs` 上做**语义比对**（不比 `frozen_at`／`revision_id`／`content_hash`）。差异逐条打印。
- `--mode model`（要用户单独授权提供方，见设计 §5）：逐 episode `_parse_transcript` ＋ `_append_ledger`（写进临时目录的真台账）→ 分页 → `build_model_input` → `model_extraction_provider(...)` → 解析 → 冻结 → 出报告（合规率／重试次数／丰度表 vs 画布／模型标记 vs 台账事实的一致率／逐 episode 与合计 tokens／`finish_reason` 与截断计数）。**没有提供方时 `--mode model` 必须明确失败**（非零退出＋人话），不许静默降级成 fake。**本波只需交付这条通道，不许真的调模型**（除了 §4 门 5 里的假 VLM 句柄）。
- 报告：`--out /tmp/r9-contract/report.json`，支持 `--resume`；两次运行逐字节相同并给 SHA256。

### 1.4 新测试 `tests/test_extraction_contract.py`

- 解析器矩阵：**正例**（一个手写的小快照 + 一份合规 JSON ⇒ 冻结成功、`content_hash` 稳定）；**反例逐条**（至少）：`ao_id` 不在快照、`evidence_content_hash` 回抄错、`snapshot_watermark` 不符、`inspected_ao_ids` 含快照外 id、块区间越界／跨 participant／跨 segment／不连续／与其他块重叠、`role`×`block_kind` 不相容（R8c 不变量）、claim 端点块未声明、子图成员块／claim 未声明、`failure_marked` 与 `failure_evidence` 单向缺失（两个方向）、子图成员 > 12、重复 id、id 内嵌 session／view／task_run／revision、`granularity_reason` 用保留值、JSON 带围栏／带多余文本／顶层不是对象。**每条都要断言「没有任何东西被写进视图存储」**。
- 端到端（**假工厂**，不碰模型）：经 `SessionService.set_extraction_provider_factory` ＋ `resume_queued_commit` ⇒ adaptive 修订落库且为 latest、fallback 修订仍可读、`(session_id, purpose)` 下 `_revision()` 不抛「not unique」；工厂抛 `ExtractionContractError` ⇒ **fallback 保持 latest**。
- 加性证明：同一个快照 dict **带／不带 `ledger_rows`** 各建一次 fallback 视图 ⇒ `content_hash` 逐字节相同。
- **既有测试一行不许改**（`tests/test_trajectory_index.py`、`tests/session/test_phase2_causal_seam.py`、`tests/test_extraction_write.py`）。若你认为非改不可，**停下来报告**。

## 2. 交付与报告

- 两个提交（建议顺序）：① `feat(session): add the model extraction contract and its ledger snapshot seam`（生产模块＋三处接线＋测试）；② `bench(causal-memory): round-trip the canvas through the extraction contract`（跑分件）。标题可改，语义要准。
- 报告（写在最终消息里）必须含：生产改动清单（逐文件逐行说明，含「为什么没有动 `Builder`」）、冻结常数表、**往返门 14/14 的实际数字与逐 episode 差异表**、拒绝矩阵的用例数与全拒结果、端到端假工厂结果、`pytest` 通过数（与基线同命令对照）、以及设计 §6 的五条「不回答」原样出现。
- **标签**：本波一律标「契约与管道测试，**不回答检索价值／不回答模型是否更好**」；不得出现任何效果量表述。

## 3. 硬约束

- **只允许**改这三个生产文件（`trajectory_index_hook.py`／`session.py`／`session_service.py`，加性）＋**新增** `openviking/session/extraction_contract.py`。**`trajectory_index.py`／`extraction_write.py`／`influence_view.py`／`retrieval_facade.py`／`subgraph_forks.py`／`causal_experiences.py` 一行不改**；若你认为别处必须改，**停下来报告**。
- **长期记忆提取的四处一处不碰**（`extract_loop.py`／`extraction_output_protocol/*`／`schema_model_generator.py`／`session_extract_context_provider.py`／`session_memory/utils/json_parser.py`）。
- `benchmark/`：只**新增** `r9_model_extraction.py`；`sb_influence_extraction.py` 与 `r7b_*.py`、`r8c_typed_truncation.py`、`l1_locomo_hitk.py` **字节不变**。
- 只读语料；**零模型调用**；不加依赖；不 push。
- 不读配置、不建 `ov.conf`、不新增 config key；不动暂停的 live 栈（`eval/NEXT.md` 的「不要动」清单）；不重跑／不重归档 `evo-lsk1`。
- **规则与上限冻结在前**（常数、截断、重试、token 上限），**任何调用与任何分数之前打印**；看到数字后不许改。
- `ruff check` ＋ `ruff format --check` 对改动与新文件全过（既有漂移不许顺手修）。

## 4. 门检（任一条不过就非零退出）

1. **往返门 14/14**：画布 14 个 payload 经契约编码 → **生产**解析器 → `freeze_extracted_view`，与画布修订语义相等（差异表为空）。这条证明**契约能表达确定性画布所表达的一切**。
2. **拒绝矩阵全拒 ＋ 零写入**：§1.4 每条反例都被 `ExtractionContractError` 拒、视图存储无新修订、fallback 仍是 latest。
3. **无提供方时生产零变化**：受影响区测试在 HEAD 与基线（`git worktree`，同一命令）失败集相同；既有三参通道测试**一行未改**照过；带／不带 `ledger_rows` 的 fallback `content_hash` 相同。
4. **证据可解析（#138 后半）**：伪造的 `ao_id`／`evidence_content_hash` 两类都在解析期被拒；对照：同一 payload 只改一处即被拒、不改则过。
5. **假 VLM 句柄端到端**：一个 stub 句柄（有 `get_completion_async`、返回固定 JSON 与 `usage`）走完 `--mode model` 的**单 episode** 路径 ⇒ 落地 adaptive 修订、`usage` 累加被报出、token 上限被触发时抛错（用一个把上限调小的实例证）；`--mode model` 在没提供方时明确失败。
6. **禁令路径 0 行 diff**（`git diff --stat` 逐个点名）＋ `ruff` 两条全过。
