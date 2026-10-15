任务：实现 AO 台账读取 API（list_ao_ledger / get_ao_evidence）（切片 S4/6）。

工作目录：/home/zhoujie22/river2_0/OpenViking（已 cd，git 分支 feat/fork-node-foundation；S1-S3 已提交：ao_ledger.py、ao_ledger_recorder.py（含 ao-attribution.jsonl）、skill_trajectory_mode 开关均存在）

背景（必读）：
1. openviking/session/ao_ledger.py 与 ao_ledger_recorder.py（含 ATTRIBUTION_FILENAME、collect_attributed_ao_ids）
2. /home/zhoujie22/river2_0/skill-node-design-grill/CONSENSUS.md 决策总账第 21 行（全局 ao_id、watermark 冻结 archive 集合 + live 上界、include_live 显式）与第 24 行（两层只读 API、二次 ACL、诊断审计）
3. /home/zhoujie22/river2_0/skill-node-design-grill/round-04-questions.md 的 Q28 原文（API 契约原型）

实现要求（新文件 openviking/session/ao_ledger_reader.py）：

1. **LedgerSnapshot（watermark）**：
   - dataclass：`watermark: str`（不透明 token，实现为对冻结状态做 base64(json) 或 hash 签名均可，但要能从 token 还原冻结状态）、`ledger_line_count: int`（签发时台账行数上界）、`archive_ids: tuple[str, ...]`（签发时已存在的 archive 目录名集合）、`issued_at: str`、`session_id: str`。
   - `issue_snapshot(session_dir, session_id) -> LedgerSnapshot`。
   - `encode()/decode()`：watermark 字符串往返。
   - 冻结语义：后续用该 watermark 分页时，**只读台账前 ledger_line_count 行**；期间新 append 的行、新出现的 archive 一律不进本次分页。

2. **list_ao_ledger(...)**：
   ```python
   def list_ao_ledger(
       session_dir: Path | str,
       session_id: str,
       *,
       cursor: str | None = None,
       limit: int = 50,
       snapshot_watermark: str | None = None,
       include_live: bool = False,
   ) -> LedgerPage
   ```
   - `LedgerPage` dataclass：`items: list[dict]`（每项 = AORecord.to_dict() + `archive_id`（从归属解析；未归属为 None）+ `committed: bool`）、`next_cursor: str | None`、`snapshot_watermark: str`、`total_in_snapshot: int`、`live_included: bool`。
   - 首次调用（无 watermark）：先 issue snapshot。带 cursor 调用必须带同一 watermark，不一致抛 ValueError。
   - **默认 include_live=False：只返回已归属（committed）的 AO**；include_live=True 时返回冻结范围内的全部 AO 并标 `committed` 布尔。live_included 字段如实反映。
   - limit 服务端上限 200（超过抛 ValueError 或截断——选截断并记录，报告里说明选择）。cursor 用 sequence 编码（如 "seq:42"）。
   - 排序按 sequence 升序。

3. **get_ao_evidence(...)**：
   ```python
   def get_ao_evidence(
       session_dir: Path | str,
       ao_id: str,
       *,
       acl_check: Callable[[str, dict], bool] | None = None,
   ) -> dict | None
   ```
   - 返回 `{"record": AORecord.to_dict(), "attribution": AOAttribution.to_dict() | None}`。
   - `acl_check(source_session_id, record_dict) -> bool` 回调：提供即调用，返回 False 抛 PermissionError（设计要求"来源 session ACL 为权威"；本切片只留钩子，默认 None = 允许，docstring 注明后续切片接真实 ACL）。
   - ao_id 不存在返回 None。

4. 不修改任何现有文件。import 限制：stdlib + openviking.session.ao_ledger + openviking.session.ao_ledger_recorder（复用 collect_attributed_ao_ids 等，别重写归属解析）。

测试（tests/test_ao_ledger_reader.py，tmp_path）：
1. 快照冻结：append 3 条 → issue snapshot → 再 append 2 条 → 无 watermark 分页看到 3 条；新调用（重新 issue）看到 5 条。
2. cursor 分页：limit=2 翻完 5 条，next_cursor 链正确、无重无漏；cursor 与不同 watermark 组合抛 ValueError。
3. committed 语义：3 条中 2 条已归属（手工在 history/archive_001/ 写 ao-attribution.jsonl）→ include_live=False 只回 2 条且 archive_id 非空；include_live=True 回 3 条，未归属那条 archive_id=None、committed=False。
4. get_ao_evidence：已归属/未归属/不存在三例；acl_check 返回 False 时抛 PermissionError。
5. watermark encode/decode 往返一致。

约束：SPDX 头；无新依赖；风格对齐；对 limit 越界、损坏 attribution 行等边界不抛异常（容错跳过）。

验收标准（结尾逐条报告）：
1. `python3 -m pytest tests/test_ao_ledger_reader.py tests/test_ao_ledger_recorder.py tests/test_ao_ledger.py -q` 全绿。
2. `git status --short` 仅新增两个文件。
3. 报告：watermark 的编码方案、limit 越界策略选择、ACL 钩子形态。
