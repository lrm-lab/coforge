# R9 独立验证：#125 抽取模型的输出契约（零模型半边，2026-10-01）

被验对象：`a5ac33a37`（`feat(session): add the model extraction contract and its ledger snapshot seam`）＋ `22ccf40f1`（`bench(causal-memory): round-trip the canvas through the extraction contract`），基线 `19c8cf934`，未 push。验证者：编排侧（**不是**作者）。R9-fix（`impl/R9-fix-brief.md`）在本记录末尾单独记账。

我的复算件（全部在 `/tmp`，仓库不依赖）：`/tmp/probes/r9_coverage_derivable.py`、`r9_ledger_fidelity.py`、`r9_my_encoder.py`、`r9_revision_diff.py`、`r9_mine_roundtrip.py`、`r9_e2e_and_rejections.py`；产物 `/tmp/zcode-verify/r9/`。**我没有跑过任何模型**（本环境也没有可用的模型提供方凭据）。

## 1. 提交审计

| 检查 | 结果 |
|---|---|
| `git diff --stat 19c8cf934..HEAD` | **6 个文件 ＋2489／−15**：新增 `openviking/session/extraction_contract.py`(1017)、`benchmark/causal_memory/r9_model_extraction.py`(503)、`tests/test_extraction_contract.py`(911)；改 `trajectory_index_hook.py`(43)、`session.py`(16)、`session_service.py`(14) |
| 禁令路径 0 行 | ✅ 逐条点名 `git diff --numstat` 无输出：`trajectory_index.py`／`extraction_write.py`／`influence_view.py`／`retrieval_facade.py`／`subgraph_forks.py`／`causal_experiences.py`、长期记忆提取四处、`sb_influence_extraction.py`／`r7b_*.py`／`r8c_typed_truncation.py`／`l1_locomo_hitk.py`、既有三个测试文件 |
| 工作区 | 干净（无未提交改动） |
| 加性 | 三处接线全是加性：新关键词参数／新键／新分支；`set_extraction_provider` 正文与文档串未改；**`Builder`／`ExtractionProvider`／`extraction_index_builder`／`_build_locked` 零改动**（我原设计要给 `Builder` 加第 4 个位置参数，实测会打断 15 处既有三参 builder 用例，改设计为「工厂」——交回件正是工厂，见 `R9-design.md` §2 #159） |

接线 diff 的实质（我逐行读过）：`ledger_rows = _page_ao_records(...)` 保留原始行、`ao_records` 由它派生（**台账仍只分页一次**）；快照 dict 加 `ledger_rows` 键；`provider = extraction_provider_factory(fallback_session(job))` **只在有工厂时**构造快照（原「只给提供方」的路径一行未动）；两者同时非空 ⇒ `ValueError`（在钩子层被 `logger.warning` 吞掉，属既有约定）；有工厂时 `_log_phase2_index_result` 也照打。

## 2. 往返门 14/14：我复现了，且数字逐字节相同

| 检查 | 结果 |
|---|---|
| 我连跑两次 `--mode fake` | `report.json` SHA256 ＝ **`29b8f36e08370b05a2577daf76e0473e1f84e09920ef6f86938f629ba5fff7e5`**，与 cursor 报的**完全相同**；两次逐字节相同 |
| 报告内容 | `equal=14`，`diff_count` 合计 **0**；`frozen_at=2026-10-01T00:00:00.000Z`、`schema=r9-extraction-contract-roundtrip-v1` |
| 口径 | 比对四段 payload（`blocks`／`claims`／`coverage`／`retrieval_subgraphs`），递归比到标量 |

### 2.1 我自己的交叉复算（不同的编码器 ＋ 不同的比对器 ＋ **真台账**快照）

`/tmp/probes/r9_my_encoder.py`：我**只照设计文本**自己写了一份编码器（画布修订 → 契约 JSON，模型只写「身份＋散文」那几类字段），产出 14 份；`r9_mine_roundtrip.py` 把**我的** JSON 喂给**生产** `parse_contract_response` → `freeze_extracted_view`，再用**我自己写的** `r9_revision_diff.py`（递归、路径级、自测过：顺序洗牌判等、植错能逐路径报出）与画布修订比对。

**结果**：见 §3 的第一条发现——**除 `captured_state` 一个字段外 14/14 全等**；把该字段排除后 `blocks／claims／coverage／retrieval_subgraphs` 四段**逐路径无差异**，且同一 payload 两次冻结 `content_hash` 相同（幂等）。

这条比 cursor 的假快照更严：我的快照是**从真台账分页出来的**（生产的 `_page_ao_records`／`_view_ao_record`／`_stable_snapshot_watermark`），不是从画布合成的。

### 2.2 三条预检（派发后、交回前我自己跑的）

| 预检 | 结果 |
|---|---|
| coverage 两张表可复算（`r9_coverage_derivable.py`） | **14/14**：`included_ranges` 能从块区间独立重算、与画布逐条相同；略去区间与块区间无重叠无缝隙、并集恰是 `total_ao_*` 跨度；`inspected = 块 ∪ 略去` 恒等（每 episode 3 行前导被略） |
| 分页台账复现画布身份（`r9_ledger_fidelity.py`） | **14/14**：`ao_id`／`content_hash`（经 `_view_ao_record`）与 `inspected_refs` 逐条相同、每个块的 `source_refs` ＝ 区间内行、`_stable_snapshot_watermark` ＝ 画布的 `snapshot_watermark` |
| 画布词表审计 | `role`／`block_kind`／`status`／`relation_type` 都是生产词表的子集；`granularity_reason` 只有一个常数且**不是**保留值；**1634 条证据 ref 的 `evidence_role` 全是 `contemporaneous_basis`**、`captured_state` 全是 `committed`（**画布常数**）、archive 两字段全 `null`；6 个子图都是 `failure_marked=True` 各带 1 条证据 |

**顺带查出一条实现陷阱**（写进 `R9-design.md` §1.5）：**原始台账行没有 `content_hash` 键**（哈希由 `_ao_content_hash`／`_view_ao_record` 现算）⇒ 模型输入必须从投影取哈希；`_stable_snapshot_watermark` 也只吃投影。交回件按下标 zip 两个列表并断言 `ao_id`／`sequence` 一致，正确。

## 3. 发现（两条，都已派 R9-fix 收口）

### 3.1 往返门用的是**从画布合成**的快照，真台账那一列没被走到

`r9_model_extraction.py` 的 `snapshot_from_revision()` 用 `revision["coverage"]["inspected_refs"]` 造 `ao_records`，并**写死 `"captured_state": "committed"`**（docstring 自述「Captured state is the canvas value」）。后果有二：

1. **14/14 是闭路结论**（画布 → 契约 → 画布），**不覆盖**「真台账 → 契约」。`--mode model` 才走真台账，而它要模型授权。
2. 它把一处**真实差异**盖住了：我改用真台账快照后，**1634/1634 条证据 ref** 的 `captured_state` 不一致——画布写 `committed`（`sb_influence_extraction.py` 的 `_evidence()` 里是**常数**），台账行实际是 `live`（`ao_ledger.py:412` 的 `CAPTURED_STATE_LIVE`；语料 920 行全是 `live`）。

**判定**：不是缺陷。两个值都在 `CAPTURED_STATES = ("committed","live")`（`causal_experiences.py:70`）里，视图侧对 `captured_state` 只 `_require_str`、不校验词表（`influence_view.py:232`），没有任何下游按它分支；而且**解析器按台账行推导比画布写常数更诚实**（设计 #158「身份来自输入」）。**该改的是跑分件与报告**：补一列真台账快照、把 `captured_state` 的差异**显式报出来**，而不是用合成快照让它消失在 0 diff 里。

### 3.2 真跑模型时 **token 数会报成 0**

`_run_completion` 只传 `messages`＋`max_tokens`、**不传 tools**；两个生产后端在这个形状下返回**裸字符串**（`litellm_vlm.py:488-490`、`openai_vlm.py:383-386`：`if tools: return VLMResponse(...)` 否则 `return str`）⇒ 响应没有 `usage`，`_account` 取到 0。而 #162 承诺报「逐 episode 与合计 tokens」，用户给的预算是按 token 算的 ⇒ **不能报 0 了事**。**可用的正路**：用量记在句柄上（`VLMBase.__init__` 的 `_token_tracker`，后端在返回前 `_update_token_usage_from_response`；三个类都有公开 `token_tracker`／`get_token_usage()`）⇒ 取前后差值即可，不必改调用形状、不必传假 tools。

**顺带一条好消息**（我查过，写下来免得日后重查）：`_run_completion` 在**有运行中的事件循环**时把协程丢到工作线程里 `asyncio.run`——`resume_queued_commit` 是 async、`_run_post_extraction_causal_seam` 在它里面同步调用，所以生产**一定是**这条路径。这是安全的：OpenAI 兼容后端用 `LoopScopedAsyncClientCache`（`openai_vlm.py:19/81`）**按事件循环缓存客户端**，litellm 后端每次 `acompletion` 建短命客户端；两者都不怕换循环。**但**若日后接入第三个后端且它持有绑定主循环的客户端，这里会炸——记在案。

## 4. 拒绝矩阵与端到端（我自己写的用例，非作者）

`/tmp/probes/r9_e2e_and_rejections.py`：真台账（`AOLedger` 写出的 `ao-ledger.jsonl`）＋ 生产钩子接线（`maybe_index_session_trajectory(..., extraction_provider_factory=...)`）＋ 生产解析器。

| 用例 | 结果 |
|---|---|
| happy path（我的编码 JSON，真台账快照） | adaptive 修订落库，`blocks=20`、`subgraphs=1`，latest ✅ |
| 5 个端到端篡改（`bad_hash`／`unknown_ao`／`bad_watermark`／`overlap`／`subgraph_too_big`）经完整钩子接线 | 全部拒绝、**视图存储无新修订**（latest 为 `None`）✅ |
| 9 个解析器级篡改（`bad_hash`／`unknown_ao`／`bad_watermark`／`foreign_inspected`／`overlap`／`unknown_claim_endpoint`／`subgraph_too_big`／`failure_without_evidence`／`extra_top_key`） | 全部 `ExtractionContractError`；对照未篡改 payload **解析通过** ✅ |
| 逐条消息（我另跑的三个隔离用例） | `same-participant overlap` → `block b-000006 overlaps b-000005`；`range beyond snapshot` → 报重叠（相邻块先触发）；`start outside snapshot` → `blocks[2] AO range is empty`。**三条都是拒绝**，规则确实在跑；`overlap` 那条我第一版探针先撞到 `crosses participant`，是我的用例没隔离干净，不是实现问题 |

## 5. 测试与 lint 对照（同一命令、两个树）

命令：`pytest tests/test_trajectory_index.py tests/session/test_phase2_causal_seam.py tests/test_extraction_write.py tests/test_extraction_contract.py -q --no-cov -p no:cacheprovider`

| 树 | 结果 |
|---|---|
| HEAD `22ccf40f1` | **2 failed, 79 passed** |
| 基线 `19c8cf934`（`git worktree`，我实测那次导入的确实是基线代码：`openviking.__file__` 指向 worktree） | **2 failed, 35 passed** |
| 差额 | 44 ＝ 新测试文件；**同样两条失败**：`test_missing_projection_registry_warns_once_and_still_indexes`、`test_supersede_without_revalidation_callback_warns_once`（caplog 收不到已打出的 warning，基线就在）⇒ 与本波无关 |

`ruff`：新文件与 `trajectory_index_hook.py` 的 format 全过；`session.py`／`trajectory_index_hook.py` 的 I001 与 `session.py`／`session_service.py` 的 format 在基线同样失败（既有漂移，未被顺手修）。

## 6. 残余与边界（照写，不许读成别的）

1. **`captured_state`**：画布写常数 `committed`，台账行是 `live`。生产视图侧不校验词表、无下游分支 ⇒ 不修；但**跨版本比对时这一列不可当锚**。
2. **身份子串规则**：`_reject_embedded` 是**大小写敏感的整串子串**判定，与生产的 `_reject_embedded_subgraph_ids` **逐字一致**（我比对过）。副作用：**短身份串会误伤**——我探针里 `task_run_id="t"` 时 `subgraph_id="sg-tail"` 被拒（`sg-tail` 含 `t`）。这是**既有生产的锐边**，交回件忠实镜像了它；真跑模型时要么用非退化 id（语料里都是长名），要么在 prompt 里把身份串列清楚（已列）。**不是本波引入。**
3. **未知键严格拒绝**：多一个 `notes` 顶层键即整体拒（`extra=['notes']`）。这是设计要的 fail-closed（「不修、不部分接受」），但真跑时**装饰性多余键会吃掉修复额度**，report 应把这类失败单列。
4. **无提供方时生产零变化**：`Builder` 未加参、既有三参通道测试一行未改照过、`ledger_rows` 是加性键（cursor 有自己的 `content_hash` 用例，我在 §2.1 的真台账路径上也复核了同源行为）。
5. **本波没有回答**（照设计 §6）：检索价值／模型是否更好、跨 session 泛化、branches/guidance 的消费侧作用、`position_kind="cut"` 语义、手写草稿绕过提取侧时的证据对账（#138 的残留仍在）。
6. **`--mode model` 一次都没真跑**：本环境只有 `CURSOR_API_KEY`，没有 LiteLLM 认的模型凭据，`ov.conf` 不存在且我不建。跑它需要：点名提供方（模型名）＋凭据怎么进。预算上限是代码里的冻结常数（`MAX_TOKENS_PER_CALL=32768`／`MAX_TOTAL_TOKENS=2_000_000`／`MAX_REPAIRS=1`）；**预期**花费远低于上限（输入实测 15.1K–115.7K 字符／episode，14 个合计 633K 字符；输出估 5–40 KB／episode）。按 §3.2，真跑前应先落 R9-fix 的用量记账。

---

# 附：R9-fix 验证（`d51684adc`，2026-10-01）

承接 §3 的两条发现（#165 合成快照盖住真差异、#166 token 会报 0）。交回件：`d51684adc`「fix(session): report the ledger column and handle token deltas」，父 `22ccf40f1`。

## 7.1 提交审计

3 个文件 **+695／−28**，未 push：

| 文件 | 行数 |
|---|---|
| `benchmark/causal_memory/r9_model_extraction.py` | +424／−10 |
| `openviking/session/extraction_contract.py` | +131／−18 |
| `tests/test_extraction_contract.py` | +140／−0 |

**禁令路径 0 行 diff**（numstat 只有上面三行）：`l1_locomo_hitk.py` 字节不变、无 `ov.conf` 新增、`influence_view.py`／`retrieval_facade.py`／`extraction_write.py`／`trajectory_index.py`／`trajectory_index_hook.py` 一行未动。**生产侧那 131 行只改记账**：`_account` 加 `before／after` 两参、`_measured_usage` 定优先级（响应 usage 优先，否则句柄差值），**没有放宽任何校验**——三处冻结上限的检查一字未改，仍跑在记账后的数字上。

## 7.2 两条发现各自的收口（我独立复核）

| 复核项 | 结果 |
|---|---|
| **画布列未被扰动**（最重要的一条：证明没顺手改生产推导） | `report.json` 画布列与修前**逐字节相同**，整文件 SHA256 仍是 **`29b8f36e08370b05a2577daf76e0473e1f84e09920ef6f86938f629ba5fff7e5`**（修前我连跑两次同值） |
| **台账列 14/14** | 真台账分页建快照；`captured_state_delta = {"canvas": "committed", "ledger_rows": "live", "refs": 1634}` |
| **我自己的直方图**（拿报告逐条 diff 数） | 台账列的 **1634 条 diff 全是 `captured_state` 路径，别的 0 条**（`captured_state_rows=1634`、`other_diff_rows=0`）⇒ 这三段 payload（`blocks`／`claims`／`coverage`／`retrieval_subgraphs`）在真台账快照下与画布**语义全等**，唯一差异就是 #165 那一处、且**被显式报出来了** |
| **缺台账时不许退回画布** | 台账目录不存在 ⇒ 退出码 **1**，报「台账目录不存在……拒绝退回画布快照」。（我第一次用管道量的，`$?` 取到的是 `tail` 的状态——重测不带管道才是 1，记下来免得日后再踩） |
| **`--mode model` 不能偷偷用画布快照**（我最后一条开放问题） | 已闭合：`run_model_episode` → `episode_snapshot()`，那条路**先往真台账写**（`sb._append_ledger`）再分页（`page_ao_records`）→ 投影（`view_ao_record`）→ 水位（`snapshot_watermark`）；`snapshot_from_revision`（画布合成）**只**被 `_run_fake_file` 调；`snapshot_from_ledger` 在目录／文件缺失时抛 `FileNotFoundError`；且 `--mode model` 无句柄时**退出码 2、明说不退回 fake**。⇒ 模型模式**没有**画布快照回退路径 |

**我自己的句柄桩探针**（5 条，非作者用例）：`handle_tracker` 差值 50／30／80 → `total=80`；纯 `unavailable` **报字符串 `unavailable`，不报 0 当花费**；响应有 usage 时**响应优先于句柄**；超上限抛 `ExtractionLimitError`。报告聚合侧也一致：`_aggregate_tokens` 只要有一个 episode 没测到就整体返回 `unavailable`（**不会把残缺的求和读成总数**），`_aggregate_usage_source` 同理。

## 7.3 测试与 lint（同一命令、两个树）

`pytest tests/test_trajectory_index.py tests/session/test_phase2_causal_seam.py tests/test_extraction_write.py tests/test_extraction_contract.py -q --no-cov -p no:cacheprovider`

| 树 | 结果 |
|---|---|
| HEAD `d51684adc` | **2 failed, 84 passed** |
| 基线 `19c8cf934`（`git worktree`） | **2 failed, 35 passed** |
| 差额 | 49 ＝ 契约测试文件（44 → 49）；**同样两条** caplog 失败（`test_missing_projection_registry_warns_once_and_still_indexes`、`test_supersede_without_revalidation_callback_warns_once`），基线就在 |

`ruff check` ＋ `ruff format --check` 对这三个改动文件**全过**（既有漂移未被顺手修）。

## 7.4 本波新增的残余（照写）

1. **`unavailable` 的那次调用不吃累计上限**：读数测不到时 `_account` 在 `MAX_TOTAL_TOKENS` 检查前就返回（单次上限仍在——`max_tokens` 还是发给模型、`finish_reason=length` 仍然抛）。**不是本波引入**：修前 usage 恒 0 同样不触发累计上限；改动只是把「0」换成了诚实的「未测到」。真跑时两个生产后端都有句柄计数 ⇒ 走的会是 `handle_tracker` 那条路。
2. **`--mode model` 的控制台回声**仍打印 `snapshot_source=<参数值>`（默认 `canvas`），而该模式实际只有台账来源；**JSON 报告里没有这个字段**（模型模式报告只有 `mode`／`frozen_limits`／`episodes`／`summary`），且 §7.2 已证无回退路径 ⇒ 只是**控制台一行措辞**的口径问题，不是数据；留作下次顺手修。
3. §6 的六条残余**不变**（`captured_state` 不可当跨版本锚、身份子串规则是既有生产锐边、未知键严格拒绝、无提供方时生产零变化、本波未回答的四项、**`--mode model` 仍一次未真跑**）。
