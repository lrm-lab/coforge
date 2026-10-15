任务：实现 causal-experiences 命名空间、fork node 数据模型与 ForkNodeUpsert 服务端校验（切片 S5/6）。

工作目录：/home/zhoujie22/river2_0/OpenViking（已 cd，git 分支 feat/fork-node-foundation；S1-S4 已提交）

背景（必读）：
1. /home/zhoujie22/river2_0/skill-node-design-grill/CONSENSUS.md：第 20 条（fork node 三种锚点、稳定身份、revision 追加）、第 24 条（九字段 provenance）、第 25 条（双字段 hindsight 隔离）、第 28 行决策（评估编排触发点）、round-04-questions.md 的 Q25/Q26（权威存储 + 受控写入 + 幂等键）、round-05-questions.md 的 Q29（contemporaneous_basis_ao_ids / hindsight_attribution_ao_ids）
2. /home/zhoujie22/river2_0/skill-node-design-grill/docs/adr/0001 与 0003
3. openviking/session/ao_ledger.py（AORecord / ao_id 形态）

实现要求（新文件 openviking/session/causal_experiences.py；纯文件级实现，不接 viking:// URI 层，目录布局按 `<root>/causal-experiences/`，本切片 root 由调用方传目录）：

1. **锚点（判别式 union，用 dict + kind 字段实现）**：
   - `ao`: {"anchor_kind": "ao", "ao_id": str, "source_session_id": str}
   - `session_state`: {"anchor_kind": "session_state", "session_id": str, "ledger_snapshot_watermark": str, "live_ao_upper_bound": int, "anchored_at": str}
   - `interaction_edge`: {"anchor_kind": "interaction_edge", "channel_id": str, "interaction_event_id": str, "from_segment_id": str, "to_segment_id": str, "dag_snapshot_watermark": str}
   - 校验函数 `validate_anchor(anchor: dict) -> dict`：kind 必须三选一，逐 kind 校验必填字段与类型，非法抛 ValueError。

2. **证据引用（九字段 provenance）**：dataclass `EvidenceRef`：ao_id、source_session_id、source_archive_id（str|None）、archive_commit_watermark（str|None）、source_sequence（int）、source_read_snapshot_watermark（str）、evidence_role（Literal: contemporaneous_basis | hindsight_attribution | branch_basis | guidance_basis）、evidence_content_hash（str）、captured_state（committed|live）。`validate_evidence_ref`。

3. **ForkNodeRevision（不可变 dataclass）**：
   - 字段：fork_node_id（str，uuid）、workspace_id、anchor（dict，经 validate_anchor）、revision_id（uuid）、supersedes_revision_id（str|None）、seven_sections（dict，七段键必须齐全：session_title、current_state、task_and_goals、key_facts_and_decisions、files_and_context、errors_and_corrections、open_issues；值为 str，校验非空）、contemporaneous_basis（list[EvidenceRef]）、hindsight_attribution（list[EvidenceRef]）、used_skills（list[dict]，每项必须含 skill_uri 与 revision_hash，可选 invocation_id，按调用顺序）、branches（list[dict]，v1 允许空；每项含 branch_id、evidence_status: real|imagined_synthetic|imagined_unverified、ao_sequence（list[str]）、guidance（dict|None））、diagnosis_run_id、created_at、content_hash（对除自身外全部字段 canonical json 的 sha256）、model_version。
   - **causal context 硬隔离校验**（Q29）：contemporaneous_basis 中每条 ref 的 source_sequence 必须严格小于锚点对应 sequence（仅当 anchor_kind=="ao" 时锚点 sequence 可从 EvidenceRef 推不出——所以额外要求 anchor 中带 anchor_sequence 字段（int，ao 锚点必填）；校验 contemporaneous 全部 < anchor_sequence）；hindsight 无此限制。anchor 中没有 ao 锚点时跳过该校验。
   - to_dict / from_dict / recompute_content_hash（加载后校验 hash 一致性，不一致抛 ValueError）。

4. **causal-experiences 存储（CausalExperiencesStore）**：
   - 目录布局：`<root>/causal-experiences/forks/<fork_node_id>/revisions/<revision_id>.json` + `index.jsonl`（追加：每行 {fork_node_id, revision_id, anchor_key, created_at}）。
   - `upsert_fork_node(payload: dict, *, idempotency_key: str) -> dict`（Q26 服务端校验的最小版）：
     a. 解析 payload → ForkNodeRevision（全部校验）；
     b. 幂等：`<root>/causal-experiences/.idempotency/<sha256(idempotency_key)>.json` 存在且内容 hash 一致 → 直接返回已存结果（标记 deduplicated: true）；不一致 → ValueError（幂等键冲突）；
     c. 稳定锚点复用：canonical_anchor_key = 稳定序列化 anchor（排序键）；在 index.jsonl 里找同 {workspace_id, canonical_anchor_key} 的既有 fork_node_id：有 → 复用该 id（payload 里传入的 fork_node_id 若非 None 且不同则报错）；无 → 用 payload 的（或新 uuid）；同一 fork_node_id 下**禁止重复 revision_id**；
     d. 原子写：先写 revisions/<id>.json（临时文件 + rename），再追加 index.jsonl，最后写幂等记录；
     e. 返回 {"fork_node_id", "revision_id", "deduplicated", "created"}。
   - `get_fork_node(fork_node_id) -> dict | None`（最新 revision + 全部 revision 列表）；`get_revision(fork_node_id, revision_id)`。
   - 写操作需要 causal 模式：构造时传 config 或在 upsert 里检查 is_causal_mode_enabled，legacy 下抛 PermissionError（注明 evaluator/orchestration 触发语义在后续切片）。

5. 测试（tests/test_causal_experiences.py）：
   1. 三种锚点各一例合法 + 各至少一例非法（缺字段/kind 错）。
   2. 七段缺一段 → ValueError；contemporaneous 引用 sequence ≥ anchor_sequence → ValueError；hindsight 可以 ≥。
   3. used_skills 缺 revision_hash → ValueError。
   4. upsert 新锚点 → created=true、目录与 index 落盘；**同 idempotency_key 重放 → deduplicated=true 且不新增文件**；不同内容同 idempotency_key → ValueError。
   5. 同锚点第二次 upsert（不同 diagnosis_run_id）→ 复用 fork_node_id、新 revision_id、两个 revision 文件。
   6. from_dict 后 content_hash 校验通过；篡改一个字段后 recompute 不一致。
   7. legacy 模式（构造 config 为 legacy）upsert 抛 PermissionError。

约束：SPDX 头；无新依赖；不修改任何现有文件；import 限 stdlib + openviking.session.ao_ledger*（可复用工具）+ memory_config 的 is_causal_mode_enabled。

验收标准（结尾逐条报告）：
1. `python3 -m pytest tests/test_causal_experiences.py tests/test_ao_ledger_reader.py tests/test_ao_ledger_recorder.py tests/test_ao_ledger.py tests/test_skill_trajectory_mode.py -q` 全绿。
2. `git status --short` 仅两个新文件。
3. 报告：目录布局、幂等实现、canonical_anchor_key 的序列化方案、七段键名清单。
