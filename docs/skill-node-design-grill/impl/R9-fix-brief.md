# R9-fix 派发件：把往返门的**台账那一列**补上，把**真实 token 数**取到（零模型调用）

先读 `impl/R9-design.md`（本波设计正文 #157–#163）与你自己交回的 `../../OpenViking` 提交 `a5ac33a37`／`22ccf40f1`。**编排侧已独立验证 R9 主体：通过**，但发现两处该补的洞（下面 §1、§2），都不涉及模型调用、不改生产语义。

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支 `feat/causal-subgraph-retrieval`，基线 **`22ccf40f1`**。**追加新提交；不要 rebase／amend；不要 push；不引新依赖。**

## 0. 两处洞的现场证据（我自己跑的）

1. **往返门的快照是从画布自己合成的**：`benchmark/causal_memory/r9_model_extraction.py` 的 `snapshot_from_revision()` 用 `revision["coverage"]["inspected_refs"]` 造 `ao_records`，并**写死 `"captured_state": "committed"`**（docstring 也这么写）。所以 14/14 只证明「画布 → 契约 → 画布」这条闭路；真台账那一侧没被走到。
   我改从**真台账**取快照（生产的 `_page_ao_records` ＋ `_view_ao_record` ＋ `_stable_snapshot_watermark`，读 `/tmp/sb-influence-r8c/ledgers/<session_id>`）跑同一套生产解析器：**14/14 除一个字段外全等**——`captured_state`：**1634/1634 条证据 ref**，画布写 `committed`（`sb_influence_extraction.py` 的 `_evidence()` 里是**常数**），台账行里实际是 `live`（`AORange`… 见 `ao_ledger.py:412` `CAPTURED_STATE_LIVE`；920 行全是 `live`）。两个值都在 `CAPTURED_STATES = {"committed","live"}` 里、视图侧只做 `_require_str`、不校验词表 ⇒ 不是缺陷，但**必须如实报出来**，不许再用画布合成快照把它盖住。
2. **token 数取不到**：`_run_completion` 只传 `messages` ＋ `max_tokens`、**不传 tools**，而两个生产后端在这个形状下返回**裸字符串**（`litellm_vlm.py:488-490`、`openai_vlm.py:383-386`：`if tools: return VLMResponse(...)` 否则返回清理后的 str）⇒ 响应上没有 `usage`，`_account` 取到 0。**但用量其实记在句柄上**：`VLMBase.__init__` 有 `self._token_tracker`，后端在返回前先 `_update_token_usage_from_response(...)`（`litellm_vlm.py:~486`），且三个类（`VLMBase`／`FailoverVLM`／`MultiCredentialVLM`）都有公开的 `token_tracker` 属性与 `get_token_usage()`（`base.py:320/324/754/1139`）⇒ 真跑时必须能报出**真实** prompt／completion tokens。

## 1. 跑分件：`--snapshot-source {canvas,ledger}`（默认 `canvas`，`--mode fake` 两种都要能跑）

- `ledger`：用**生产**钩子函数（`_page_ao_records`／`_view_ao_record`／`_stable_snapshot_watermark`）读 `<ledgers_dir>/<session_id>` 建快照，`--ledgers` 默认 `/tmp/sb-influence-r8c/ledgers`；**目录/文件不存在就带人话失败**，绝不静默退回 canvas。
- 报告里写清 `snapshot_source`，并且**逐字段**给出两列结果。`ledger` 列必须把 `captured_state` 的差异**显式报出来**（形如 `captured_state_delta: {"canvas": "committed", "ledger_rows": "live", "refs": 1634}`）——**不许**把它塞进忽略表里了事，也不许为了让两列相等去改生产推导。
- `canvas` 列的 `semantic_diff` 语义不变（仍是四段 payload 的递归比对），但报告里要**明写** 14/14 是「画布 → 契约 → 画布」的闭路结论，**不**覆盖真台账。
- 我的探针（可参考写法，但**结论要你自己复算**）：`/tmp/probes/r9_mine_roundtrip.py`、`/tmp/probes/r9_ledger_fidelity.py`、`/tmp/probes/r9_my_encoder.py`。**不要 import 我的探针文件**，也不要让仓库依赖 `/tmp` 里我写的东西（`--ledgers` 默认值可以指向那个目录，但路径要能被 `--ledgers` 覆盖）。

## 2. 生产模块：响应没有 usage 时，从**句柄**的用量计数器取差值

- `extraction_contract.py`：`_SnapshotExtractionProvider` 在每次调用前后读一次句柄的用量（优先 `get_token_usage()`，回退 `token_tracker.to_dict()`；两者都没有就跳过，**不许**因此抛错），响应自带 usage 时仍以响应为准。
- 报告里加 `usage_source`：`response`／`handle_tracker`／`unavailable`，以及逐 episode 与合计 tokens（拿不到就明写 `unavailable`，**不许**把 0 当成「没花钱」）。
- 上限判据不变：`MAX_TOKENS_PER_CALL`／`MAX_TOTAL_TOKENS` 仍冻结在前、触上限即抛；句柄取到的差值只用于**记账与报告**，不改上限语义。
- 测试：两个 stub 句柄——(a) `get_completion_async` 返回**裸字符串**、但实现 `get_token_usage()`（用两个不同数值证差值被算对）；(b) 只实现 `get_completion_async`（返回字符串、无任何用量接口）⇒ 必须落 `unavailable` 且不抛错。既有 44 个测试**一行不改**。

## 3. 硬约束

- 只动 `benchmark/causal_memory/r9_model_extraction.py`、`openviking/session/extraction_contract.py`、`tests/test_extraction_contract.py`。**其它文件 0 行 diff**（尤其 `trajectory_index_hook.py`／`session.py`／`session_service.py`／`trajectory_index.py`／`extraction_write.py`／`influence_view.py` 与既有三个测试文件）。
- 零模型调用；不读配置；不建 `ov.conf`；不 push；不加依赖；`ruff check` ＋ `ruff format --check` 对新改动全过（既有漂移不许顺手修）。
- **不许**为了让「台账列」全等而改生产侧的推导规则（`captured_state` 就按台账行来；差异如实报）。

## 4. 门检

1. `--mode fake --snapshot-source canvas`：与 `22ccf40f1` 的报告**逐字节相同**（SHA256 不变，`29b8f36e…`）。
2. `--mode fake --snapshot-source ledger`：14/14 能跑完，报告含 `captured_state_delta`（refs 数要与真实 refs 数一致：1634）与「该列不覆盖画布写入值」的说明；`--ledgers` 指向不存在的目录时非零退出。
3. stub 句柄 (a)：`usage_source=handle_tracker` 且 tokens ＝ 两次读数之差；(b)：`usage_source=unavailable` 且不抛。
4. 三处改动之外的 `git diff --stat 22ccf40f1..HEAD` 为空；`pytest` 既有 44 项＋新增项全绿（给数）。
