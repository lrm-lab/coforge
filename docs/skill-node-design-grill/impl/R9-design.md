# R9 设计：#125 抽取模型的输出契约（编排侧代定，2026-10-01）

用户 2026-10-01「可以」（在我把两条候补摆出来之后：**#125 模型驱动抽取**要预算授权、R7d 要不要做）。本波按 #125 落地**契约与管道**，把「花模型的钱」那一步单独留成一次有界冒烟。

## 0. 一句话

今天 Phase 2 的插座是**空的**：`ExtractionProvider = Callable[[str,str,str], ExtractionPayload]`（`extraction_write.py:108`）没有任何生产调用方（只有测试），而且**即使注入了提供方，提供方也拿不到台账**——`_build_locked` 只在没有 builder 时才构造台账快照（`trajectory_index.py:511-525`）。所以 #125 不是「写个 prompt」，是**两件事**：(a) 给模型一条**看得见台账**的输入通路；(b) 定一份**「只选不造」的输出契约**，把模型的 JSON 变成生产 `ExtractionPayload`，并在**提取侧输入边界**上把 #138 剩下那半（证据不可解析）收口。本波把这两件做成**零模型调用**可验收的形态（假提供方 ＋ 往返门 ＋ 拒绝矩阵），真模型的冒烟单独一次、有界、要用户点提供方。

## 1. 现场事实（我逐条读过）

| 事实 | 证据 |
|---|---|
| 插座存在但生产为空 | `ExtractionProvider = Callable[[str,str,str], ExtractionPayload]`（[`extraction_write.py:108`](/home/zhoujie22/river2_0/OpenViking/openviking/session/extraction_write.py:108)）；`set_extraction_provider` 的文档写明「This is not read from config」，全库只有测试调用（[`session_service.py:105-111`](/home/zhoujie22/river2_0/OpenViking/openviking/service/session_service.py:105)） |
| 提供方看不到台账 | `_build_locked`：`if self._builder is None: session = self._fallback_session(job) / build_minimal_fallback_view(session)` **`else:`** `revision = self._builder(job.session_id, job.task_run_id, job.outcome_status)`（[`trajectory_index.py:511-525`](/home/zhoujie22/river2_0/OpenViking/openviking/session/trajectory_index.py:511)）——快照只在 fallback 分支里构造 |
| 但台账快照是现成的 | 钩子里 `ao_records = [_view_ao_record(item, session_id) for item in _page_ao_records(session_dir, session_id)]` ＋ `watermark = _stable_snapshot_watermark(...)`，装进 `fallback_session(job)` 的 dict（[`trajectory_index_hook.py:239-266`](/home/zhoujie22/river2_0/OpenViking/openviking/session/trajectory_index_hook.py:239)） |
| 台账是真的、有内容的 | `AORecord{ao_id, session_id, sequence, action, observation, skill_invocations, message_ref, created_at, captured_state}`（[`ao_ledger.py:285-310`](/home/zhoujie22/river2_0/OpenViking/openviking/session/ao_ledger.py:285)）；`action` = `{"tool", "tool_id"?, "arguments"?}`（[`ao_ledger_recorder.py:142-156`](/home/zhoujie22/river2_0/OpenViking/openviking/session/ao_ledger_recorder.py:142)）；`observation` = 确定性 synopsis `{kind,title,summary[],structure[],notable_items[],sample}`（[`tool_result_synopsis.py:43-52`](/home/zhoujie22/river2_0/OpenViking/openviking/session/tool_result_synopsis.py:43)） |
| 读者 API | `list_ao_ledger(session_dir, session_id, *, cursor, limit, snapshot_watermark, include_live)`／`get_ao_evidence(session_dir, ao_id, *, acl_check)`（[`ao_ledger_reader.py:287`](/home/zhoujie22/river2_0/OpenViking/openviking/session/ao_ledger_reader.py:287)、[`:370`](/home/zhoujie22/river2_0/OpenViking/openviking/session/ao_ledger_reader.py:370)） |
| 行内容哈希可复算 | 行上有 `content_hash` 就用它，否则 sha256(规范 JSON{ao_id, session_id, sequence, action, observation, skill_invocations, message_ref, captured_state, created_at})（[`trajectory_index_hook.py:122-138`](/home/zhoujie22/river2_0/OpenViking/openviking/session/trajectory_index_hook.py:122)）⇒ **对账可做** |
| 证据 ref 是九字段 | `InfluenceEvidenceRef{ao_id, source_session_id, source_archive_id?, archive_commit_watermark?, source_sequence, source_read_snapshot_watermark, evidence_role, evidence_content_hash, captured_state}`（[`influence_view.py:203-214`](/home/zhoujie22/river2_0/OpenViking/openviking/session/influence_view.py:203)） |
| 冻结门查结构、**不查台账** | `freeze_extracted_view` 逐项校验身份串、coverage 类型、子图 id 卫生，再 `draft.freeze(enforce_checks=True)` 跑 `validate_view`（[`extraction_write.py:111-155`](/home/zhoujie22/river2_0/OpenViking/openviking/session/extraction_write.py:111)）；子图侧查 `subgraph_unknown_member`／`subgraph_claim_endpoint_outside`／`subgraph_block_limit`(12)／**失败标记与证据双向**／`duplicate_subgraph_id`（[`influence_view.py:1382-1472`](/home/zhoujie22/river2_0/OpenViking/openviking/session/influence_view.py:1382)）。docstring 明写「``validate_view`` still does not resolve evidence against a ledger」（[`subgraph_forks.py:39`](/home/zhoujie22/river2_0/OpenViking/openviking/session/subgraph_forks.py:39)）⇒ 这就是 #138 剩的那一半 |
| 失败即上抛、降级是调用方的选择 | `extraction_index_builder`「A refused freeze propagates. This builder does not degrade to fallback.」（[`extraction_write.py:171-207`](/home/zhoujie22/river2_0/OpenViking/openviking/session/extraction_write.py:171)）；`degrade_to_fallback_view` 单独存在（[`:158-168`](/home/zhoujie22/river2_0/OpenViking/openviking/session/extraction_write.py:158)）；Phase 2 的 `except` 只 log（[`session.py:1935-1956`](/home/zhoujie22/river2_0/OpenViking/openviking/session/session.py:1935)） |
| 模型面已经存在 | `VLMResolver.get_vlm(account_id)`（[`config/vlm.py:46-53`](/home/zhoujie22/river2_0/OpenViking/openviking/config/vlm.py:46)）、`get_completion_async(messages=, tools=, tool_choice=, thinking=, max_tokens=)`（[`models/vlm/base.py:107-130`](/home/zhoujie22/river2_0/OpenViking/openviking/models/vlm/base.py:107)）、生产装配点 [`service/core.py:320`](/home/zhoujie22/river2_0/OpenViking/openviking/service/core.py:320) |
| 记忆提取那条路的四处过滤（**本波不碰**） | 生成模型 `extra="ignore"`、协议骨架只列 `delete_ids`＋各 memory 类型字段、指令正文只讲长期记忆、解析层 L3 过滤额外字段（`impl/pending-design-decisions.md` 第 15 条逐条给了 file:line） |
| 本环境没有可用的模型凭据 | `/tmp/pcm-cursor-api-key.env` 只有 `CURSOR_API_KEY`（那是给 cursor-agent 的）；`ov.conf` 不存在且我不建；LiteLLM 会读的 `OPENAI_API_KEY`／`ANTHROPIC_API_KEY`／`DEEPSEEK_API_KEY` 等在本环境**一个都没设** |

## 1.5 预检（编排侧在派发后独立跑，用的是**生产**钩子函数，不是 cursor 的代码）

两个探针，都在真实语料上、都用生产函数：

1. **coverage 两张表可复算**（`/tmp/probes/r9_coverage_derivable.py`）：14/14 个 episode 的 `included_ranges` 能从块区间独立重算出来、与冻结件逐条相同，`inspected = 块 ∪ 略去` 恒等、无缝隙无重叠、跨度对齐 —— 所以往返门不需要模型写这两张表（就是 §2 #158 那条收窄的依据）。
2. **分页台账复现画布身份**（`/tmp/probes/r9_ledger_fidelity.py`）：直接用生产的 `_page_ao_records` 读回 `/tmp/sb-influence-r8c/ledgers/<session>`，14/14 个 episode 的 `ao_id`／`content_hash`（经 `_view_ao_record`）与画布的 `inspected_refs` 逐条相同、每个块的 `source_refs` 与区间内行一一相同、`_stable_snapshot_watermark` 与 `coverage.snapshot_watermark` **全等**。**输入信封实测**：每 episode 15.1K–115.7K 字符（最多 161 行），14 个合计 633K 字符 ⇒ 单 episode 输入不超过约 30K token。
   **顺手查出一条实现陷阱**：**原始台账行没有 `content_hash` 键**（哈希由 `_ao_content_hash`／`_view_ao_record` 现算），所以 `build_model_input` 必须**从六字段投影取哈希**（按下标 zip），不能去读原始行的 `content_hash`——`_stable_snapshot_watermark` 也只吃投影。这是「为什么快照要同时带两个列表」的硬理由，不是风格。
3. **画布词表审计**（同一批 14 个修订，纯统计）：`role` 只用 `task`／`agent_action`／`conclusion`，`block_kind` 只用 `task`／`tool_call`／`tool_result`／`conclusion`，`status` 只有 `hypothesis`，`relation_type` 只有 `skip`／`influence`；`granularity_reason` **只有一个常数**且不是生产保留值；**1634 条证据 ref 的 `evidence_role` 全是 `contemporaneous_basis`**、`captured_state` 全是 `committed`、两个 archive 字段全 `null`；略去理由只有 `record_type_not_a_block`；6 个子图都是 `failure_marked=True` 且各带 1 条证据。⇒ 本契约把 `evidence_role`／`captured_state`／archive 三处**定成推导常数**不是偷懒，是这份语料上唯一出现过的取值；失败标记的证据配对在往返门里会被真实走到（6 个子图）。

## 2. 裁定
### #157 **契约走 Phase 2 的一次专门调用，不扩长期记忆提取的输出**

理由（每条都有上文证据）：(a) 四处过滤属于**既有长期记忆提取的 prompt 面**，改了就会改掉所有用户的长期记忆行为，而且**无法**被 `memory.skill_trajectory_mode=causal` 门住；(b) #119 已经把「调用提取模型」的地点定在 Phase 2；(c) 插座已经在那里（`extraction_write.py:108`），只差一个真实现；(d) 新调用有自己的 JSON 契约、自己的 fail-closed 解析，能用假 VLM 测。(a)(b) 四点里本波**一行都不改**。

代价（写清楚）：causal 模式下每次 commit 多一次模型调用。这个代价只在操作方**显式注入提供方**时发生——本波不读配置、不新增 config key、不建 `ov.conf`。

### #158 **契约是「只选不造」：模型只能引用它拿到的台账身份，块／claim／子图的名字由它起**

模型输出一份 JSON（`EXTRACTION_CONTRACT_VERSION = "extraction-contract-v1"`）：

```
{ "schema_version": "extraction-contract-v1",
  "blocks":  [ {"block_id", "role", "block_kind", "participant_id", "segment_id",
                "ao_start_seq", "ao_end_seq", "summary", "input", "output",
                "authorship", "granularity_reason"} ],
  "claims":  [ {"claim_id", "source_block_id", "target_block_id", "carried_artifact",
                "downstream_effect", "relation_type", "status",
                "source_evidence": [{"ao_id", "evidence_content_hash"}],
                "target_evidence": [{"ao_id", "evidence_content_hash"}]} ],
  "subgraphs": [ {"subgraph_id", "block_ids", "claim_ids", "failure_marked",
                 "failure_evidence": [{"ao_id", "evidence_content_hash"}]} ],
  "coverage": {"total_ao_start_seq", "total_ao_end_seq", "inspected_ao_ids",
               "snapshot_watermark", "omitted_ranges"?} }
```

- **身份来自输入**：块的 `participant_id`／`segment_id`／`ao_start_seq`／`ao_end_seq`、每条证据的 `ao_id` 与 `evidence_content_hash`、`coverage.snapshot_watermark`、`inspected_ao_ids` —— **每一条都必须能在交给它的快照里查到**，查不到或对不上即拒（#159／#160）。
- **派生字段：模型不写、解析器从快照算**（比「照抄」更强的一道）：块的两个来源字段（`source_refs`＝区间内每行的六元 `SourceRef`、`source_content_hashes`）与证据的其余七字段（`source_session_id`／`source_sequence`／`source_read_snapshot_watermark`＝快照水位／`evidence_role`＝冻结常数 `contemporaneous_basis`／`captured_state`＝行上的值／两个 archive 字段＝`None`）**全部推导**。理由：问模型要输入已经决定的事，只会引入噪声；而 `evidence_content_hash` **要它回抄**——那是「它确实读了给你的行」的唯一可检证据，对不上即拒。
- **coverage 的两张区间表**（**2026-10-01 我用真实语料实测后收窄**）：`included_ranges` 与 `total_ao_*` 由块的区间**推导**；`inspected_refs` ＝ **模型声明的 `inspected_ao_ids`**（校验 ⊆ 快照；不是「推导成全部行」——那样「读过哪些」就没意义了）；`omitted_ranges` **模型可写**（`{start_seq,end_seq,segment_id,reason}`，理由由模型写），解析器验它和块区间构成快照的**精确划分**（互不重叠、无缝隙、并集恰是 `total_ao_*` 的跨度），**不写就用常数理由 `record_type_not_a_block` 推导**。这样「模型悄悄漏掉一半台账」会被划分检查抓住。**实测**（`/tmp/probes/r9_coverage_derivable.py`，14/14）：画布的两张表确实可从块区间独立复算（1 段被略区间 × 14 个 episode，`inspected` ＝ 块 ∪ 略去 恒等），所以往返门不需要模型写这两张表。**时序说明**：这一处收窄发生在派发之后（`impl/R9-brief.md` 写的是「两张表都由解析器推导」）——**以本条为准**；若交回件按派发件实现，记为「待收口的一处小差」，不影响往返门与拒绝矩阵（`inspected_refs` 两个版本一致，只差 `omitted_ranges` 的理由作者）。
- **名字由模型起**：`block_id`／`claim_id`／`subgraph_id` 是模型自己起的字符串，受既有生产规则约束（非空、唯一、不得内嵌 `session_id`／`view_id`／`task_run_id`／`revision_id`——后一条 `freeze_extracted_view` 本来就会拒）。
- **块的语义**：块是**同 participant 同一 segment 内的连续 AO 区间**，且区间**互不重叠**（解析器查）；`role ∈ BLOCK_ROLES`，`block_kind ∈ BLOCK_KINDS` 且与 `role` 相容（R8c 的不变量）。`granularity_reason` 由模型写、但**不得**使用生产的两个保留值 `deterministic_fallback`／`synthetic_root_sink`（那是 fallback 的标识）。
- **失败标记只由模型写**（#99／#108）：`failure_marked=true` 必须配 `failure_evidence`（生产门双向查，本波提前到解析期也查一次）。**不**从块角色推、**不**用台账事实改标（见 #161）。

### #159 **输入准备＝台账本身（同一来源、同一水位），不给原始 transcript**

模型看到的 = 本批 AO 行的**冻结投影**：`ao_id, sequence, participant_id, segment_id, content_hash, captured_state, action{tool, arguments?}, observation{kind,title,summary,structure,notable_items,sample}`，逐字段文本按**冻结常数**截断；另加 `snapshot_watermark`（就是视图要写进 coverage 的那个 digest）。

- **不加新数据源**：不走 `get_ao_evidence`（那是诊断侧的 ACL 闸门），不读 archive 正文 ⇒ 契约不可能依赖 transcript 细节。
- **提供方的形状是「工厂」，不是给 `Builder` 加新入参**（改设计：我原稿要 `_build_locked` 把台账当第 4 个位置参数传下去，实测**会打断 15 处既有 3 参 builder 测试**）：登记的是由提交快照构造提供方的工厂 `ExtractionProviderFactory = Callable[[Mapping[str, Any]], ExtractionProvider]`。钩子本来就**在同一处**握着原始行、六字段投影、水位与 `job`（[`trajectory_index_hook.py:239-267`](/home/zhoujie22/river2_0/OpenViking/openviking/session/trajectory_index_hook.py:239)），所以 `provider = factory(snapshot)` → 再交给**一字不改**的 `extraction_index_builder(provider, frozen_at=…)`。结果：`Builder`／`ExtractionProvider`／`extraction_index_builder`／`_build_locked`／`set_extraction_provider` **全部零改动**，既有 3 参通道逐字照旧。工厂也不是将就——模型的 prompt 由快照决定，提供方本来就必须**按提交**构造。
- 钩子把**原始台账行**（`_page_ao_records` 的 items）一并放进那个 dict 的一个新键（如 `ledger_rows`）；`build_minimal_fallback_view` 只读已知键 ⇒ fallback 视图**一个字节都不变**，水位算法（`_stable_snapshot_watermark`）仍只用六字段投影算，**不许**把它改成用富字段（那会改所有 fallback 视图的 `content_hash`、破坏 `(session_id,purpose,content_hash)` 幂等）。

### #160 **对账在提取侧输入边界上收口（#138 后半），拒绝即整体拒绝**

解析期（生产模块，无模型）逐条对账：`ao_id` 在快照里？回抄的 `evidence_content_hash` 与那一行相等？`coverage.snapshot_watermark` 等于快照水位？`inspected_ao_ids` ⊆ 快照？块的区间在快照里存在、同一 participant／segment、连续、互不重叠？claim 两端都是**已声明**的块？子图成员／claim 都是已声明的？coverage 的**划分**自洽（块区间／略去区间不相交、并集恰是 `total_ao_*` 的跨度）？——**任一条不成立 ⇒ 抛 `ExtractionContractError`，不修、不部分接受、不降级**（降级是调用方的选择，R6b 的 `except` 会把 fallback 留在 latest）。

`validate_view(draft)` 的签名**保持无台账**（它是纯结构门）。理由与边界写进判决：**能查台账的地方只有提取侧**，把不可解析的证据在进入视图之前拦掉，比事后在无台账的门里假装检查更诚实。手写草稿直调 `freeze_extracted_view` 的残留**照旧存在**，如实记账、不在本波收。

### #161 **失败标记存模型写的，台账事实只进报告**

按 #108 标记是模型的判断，设计原文也写「The marker is stored as written. It is not inferred from block roles.」（[`influence_view.py:11-13`](/home/zhoujie22/river2_0/OpenViking/openviking/session/influence_view.py:11)）。本波**不**用台账事实去否决或改写标记——失败可以是语义的（有结论但没解决问题），而台账事实（轨迹截断）在 R8a 语料上恰好等价（#137）只是**这份语料**的性质。做法：runner 另外算一份**台账事实**（该 episode 的 AO 序列是否结束在工具交换中途）并**只写进报告**，报告「模型标记 vs 台账事实」的一致率——这是 #125 少有的**可量化**读数之一。

### #162 **测量计划：能回答什么、不能回答什么**

零模型调用就成立的三条硬门（§4）。真模型跑到之后**可以**报：
- **契约合规率**（每个 episode 的 payload 是否一次通过；重试次数）；
- **结构丰度 vs 确定性基线**（块数／influence／skip claim 数／子图数与规模／`block_kind` 分布，对照 R8a 画布在 14 个 episode 上的同一张表）；
- **标记一致率**（#161）；
- **成本**（每次调用的 prompt／completion tokens，逐 episode 与合计）。

**不能**报：检索价值。#140 的结论（检索级测不出因果子图价值）**仍然成立**，R7b 的真切片**仍然没有裁决**；本波只有一条允许的检索侧读法——「在模型写的视图上，R7b 的类型化字段是否终于**非常数**」（前置条件检查，标「不是效果量」）。

### #163 **本波不做／不许读成**

不改长期记忆提取的四处（`extract_loop.py`、`extraction_output_protocol/*`、`schema_model_generator.py`、`session_extract_context_provider.py`、`session_memory/utils/json_parser.py`）；不改 `validate_view` 签名；不读配置／不建 `ov.conf`／不新增 config key；不做诊断 sink 水位（pending 第 17 条）；不接 `content_resolver`（第 18 条）；不做 `position_kind="cut"` 的落地；不做 R7d；**不许**把「模型写的结构更丰富」读成「检索更有用」；`retrieval_facade.py`／`subgraph_forks.py`／`causal_experiences.py`／`influence_view.py`／`r7b_*.py`／`l1_locomo_hitk.py` **一行不改**。

## 3. 交付件

1. **`openviking/session/extraction_contract.py`（新，生产）**：冻结常数（契约版本、文本截断、`max_tokens` 上限、`max_repairs`）＋ `build_model_input(session) -> dict`（把台账行投影成模型输入，含水位）＋ `render_contract_prompt(model_input) -> str`（指令正文＋schema 提要＋规则）＋ `parse_contract_response(text, model_input) -> ExtractionPayload`（取围栏、`json.loads`、逐字段类型与**对账**、构造 `InfluenceBlock`／`InfluenceClaim`／`CoverageManifest`／`RetrievalSubgraph`）＋ `model_extraction_provider(vlm, *, max_repairs=1) -> ExtractionProviderFactory`（唯一调模型的地方；用量从 `VLMResponse.usage` 取并累加；只在**解析失败**时重试，≤`max_repairs`；超 token 上限即抛）。**不读文件、不读配置、不建客户端**。
2. **生产修改（三处加性小改，`trajectory_index.py`／`extraction_write.py` 零改动）**：`trajectory_index_hook.py`（保留原始行 ⇒ 快照 dict 加 `ledger_rows` 键；`_index_commit`／`maybe_index_session_trajectory` 各加一个 `extraction_provider_factory=None` 参数，有工厂时用它绑定快照后走原路）、`session.py`（`extraction_provider_factory` 关键词参数 ＋ `_run_post_extraction_causal_seam` 在有工厂时也走钩子）、`session_service.py`（`set_extraction_provider_factory()` ＋ 构造 session 时透传）。**`set_extraction_provider` 与其 3 参通道语义不变**，既有测试不许改。
3. **`benchmark/causal_memory/r9_model_extraction.py`（新，跑分件）**：`--mode fake`：把 R8a 14 个确定性 payload **编码成契约 JSON**（编码器只在这个跑分件里）→ 走**生产**解析器与 `freeze_extracted_view` → 与画布的修订做语义比对；`--mode model`：逐 episode 把 R8a 的 AO 行写进**生产台账**（`ao_ledger_recorder`）→ 分页 → 建模型输入 → 调模型 → 解析 → 冻结 → 出报告（合规率／丰度表／标记一致率／tokens）。**没有配置提供方时 `--mode model` 明确失败**，不许静默成功。
4. **`tests/test_extraction_contract.py`（新）**：解析器正例／反例矩阵（未知 `ao_id`、`content_hash` 不符、`sequence` 不符、水位不符、claim 端点未声明、子图成员未声明、标记无证据、证据无标记、子图 > 12 块、重复 id、id 内嵌 session id、`granularity_reason` 用保留值）、假工厂端到端（经 `SessionService.set_extraction_provider_factory` ＋ `resume_queued_commit`：adaptive 修订落库且 latest，fallback 仍可读，同一 `(session_id,purpose)` 下 id 唯一）、工厂抛错时 **fallback 保持 latest**、**快照带 `ledger_rows` 时 fallback 视图 `content_hash` 与不带时逐字节相同**。

## 4. 硬门（brief 与验证件都用这五条）

1. **往返门 14/14**（`--mode fake`，零模型）：画布 14 个 payload 编码成契约 JSON 再经**生产**解析器冻结，与画布修订在 `blocks／claims／coverage／retrieval_subgraphs` 上**语义相等**（不比 `frozen_at`／revision_id）。这条证明**契约能表达确定性画布所表达的一切**——表达不了画布的结构，就更表达不了模型的结构。
2. **拒绝矩阵全拒**：§3.4 的每条反例都被拒、**零写入**、fallback 修订仍是 latest、`_revision()` 不抛「not unique」。
3. **无提供方时生产零变化**：受影响区测试在 HEAD 与基线（`git worktree`）上**同一命令、失败集相同**；`builder=None` 路径行为等价；**既有 3 参通道与 `set_extraction_provider` 的测试一行不许改**（`tests/test_trajectory_index.py` 的 15 处 builder 用例、`tests/session/test_phase2_causal_seam.py`、`tests/test_extraction_write.py` 逐条同）。
4. **证据可解析（#138 后半）**：伪造 ref 的 `ao_id`／`content_hash`／`sequence` 三类**都在解析期被拒**（拿 R8a 的伪造探针思路做负例）；对照：同一 payload 只改一处即被拒，不改则过。
5. **禁令路径 0 行 diff** ＋ `ruff check`／`format --check` 对新文件全过（既有漂移不许顺手修）。

## 5. 预算信封（要用户点一次）

- `--mode fake`：**0 次模型调用**（本波主体，随波交付）。
- `--mode model`（另一次授权后跑）：**14 个 episode × (1 + ≤1 次修复) = 最多 28 次调用**；每次输入 = 该 episode 的台账投影（**实测 15.1K–115.7K 字符，约 4K–30K token**，见 §1.5），输出 = 契约 JSON（画布 claim 数 19–157，估 5–40 KB、数千 token）；`max_tokens` 与**全轮 token 上限**都写成冻结常数，**超了就停下报数**，不许跑完再说。按实测信封，一次 `max_tokens=16000` 对最大 episode 也够，整轮上限取 14×16000×2 的余量即可。
- **要用户给的**：提供方（模型名）＋凭据怎么进（要么你把 `ov.conf` 配好，要么点名一个 LiteLLM 认的环境变量名）。我不建 `ov.conf`、不把 key 写进 argv。

## 6. 不回答（照写进报告）

- 检索价值／「结构更有用」——#140 未被推翻，真切片仍无裁决无修复链。
- 跨 session／跨 workspace 泛化。
- 模型写的 branches／guidance／七段在消费侧的作用（那是诊断与晋升侧）。
- `position_kind="cut"` 的语义（仍未落地）。
- 手写草稿绕过提取侧时的证据对账（#138 的残留，本波只在提取侧收口）。
