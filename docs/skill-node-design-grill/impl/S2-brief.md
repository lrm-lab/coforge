任务：把 AO 台账接入 session 运行时（工具调用采集钩子）与 commit 归属解析（切片 S2/6）。

工作目录：/home/zhoujie22/river2_0/OpenViking（已 cd，git 分支 feat/fork-node-foundation；S1/S3 已提交：ao_ledger.py 与 memory.skill_trajectory_mode 开关均存在）

背景（必读）：
1. openviking/session/ao_ledger.py —— S1 产物：AORecord / AOAttribution / AOLedger / build_observation / extract_skill_invocations
2. openviking_cli/utils/config/memory_config.py —— S3 产物：is_causal_mode_enabled(config=None)
3. /home/zhoujie22/river2_0/skill-node-design-grill/CONSENSUS.md 第 2、3、21 条与决策总账 21 行
4. openviking/session/session.py —— 核心：你要找两个接缝（见下）。此文件很大，先用 grep 定位：
   - 消息追加路径（活会话写入 message/tool 调用与结果的地方；注意 parts 里 toolCall/toolResult 类结构，以及 tool_result_store.py 外置大结果的位置）
   - commit Phase 1 归档路径（创建 history/archive_NNN/、写 messages.jsonl、写 .done 的地方；函数 commit/commit_async 附近，约 1818 行起）

实现要求：

A. **运行时采集钩子**（新文件 openviking/session/ao_ledger_recorder.py，避免大改 session.py）：
   - `AOLedgerRecorder` 类：持有 AOLedger 与 session_id；方法 `record_tool_exchange(tool_call: dict, tool_result, message_ref: dict | None)` → 组装 action（至少 tool 名 + 参数摘要，可复用 ao_ledger 的 _sanitize_action 思路）、observation（用 build_observation；若 tool_result 是大结果且被 tool_result_store 外置，observation dict 加 artifact_ref 键指向外置引用）、skill_invocations（extract_skill_invocations v1 返回 []）、message_ref，然后 ledger.append。
   - 提供模块级便捷函数或在 Session 上的**最小挂点**：在 session.py 消息追加的合适位置（找到所有 tool 调用+结果成对进入的点），加一个不超过 ~15 行的挂钩：causal 模式（is_causal_mode_enabled）且该 session 尚无 recorder 时惰性创建，然后 record_tool_exchange。legacy 模式零开销（一次布尔判断）。session.py 的 diff 必须保持最小，禁止重排/重写无关代码。
   - recorder 对异常必须吞掉并记 warning（台账失败不得影响会话主流程），用仓库现有 logger。

B. **commit 归属解析**：
   - commit Phase 1 写完 archive_NNN 的 messages.jsonl 后（causal 模式下）：把该 session 台账中**尚未归属**的全部 AO 记录，逐条生成 AOAttribution（archive_id 用本次归档名，commit_watermark 用 archive 目录名 + attributed_at 时间戳拼一个稳定字符串，格式 `f"{archive_id}@{iso_ts}"`），追加写入 `history/archive_NNN/ao-attribution.jsonl`（每行一个 AOAttribution JSON）。
   - 硬约束（ADR-0002）：绝不修改 ao-ledger.jsonl 里已写入的行；归属只存在于 attribution 文件。已归属的判定：读该 session 所有历史 archive 的 ao-attribution.jsonl 汇总 ao_id 集合（做一个小工具函数，读不到文件视为空）。
   - .done 语义不变；legacy 模式 commit 行为零变化。
   - 挂点同样最小化：优先把归属逻辑写成独立函数放在 ao_ledger_recorder.py（如 `write_archive_attribution(session_dir, archive_dir) -> int`），session.py 里只在归档落盘处加一小段调用。

C. **测试**（tests/test_ao_ledger_recorder.py + 可选集成测试）：
   1. recorder.record_tool_exchange 正常产出 AORecord（含 tool 名、synopsis observation、[] skill_invocations）；tool_result 为 dict 与 str 两类。
   2. 大结果外置场景：传入带 artifact_ref 信息的调用后 observation dict 含 artifact_ref。
   3. write_archive_attribution：预置 3 条未归属 AO → 归档一次 → attribution 文件有 3 行且 ao_id 对应；再 append 2 条新 AO → 第二次归档 → 只新增 2 行（幂等，不重复归属）。
   4. 归属后 ao-ledger.jsonl 内容逐字节不变（前后 hash 对比）。
   5. 若能以合理成本在现有 session 测试基建上做端到端（参考 tests/test_session_async_commit.py 的构造方式）就做一个：causal 下 commit 后 archive 里有 ao-attribution.jsonl；legacy 下没有且会话目录无 ao-ledger.jsonl。**若现有 session 测试基建需要本环境缺失的资源（如 cluster.json），允许跳过端到端，用 seam 级测试覆盖并在报告中说明**。

约束：SPDX 头；无新第三方依赖；session.py 的 diff ≤ 60 行；不改 .done / WM / 记忆抽取的任何既有行为。

验收标准（结尾逐条报告）：
1. `python3 -m pytest tests/test_ao_ledger_recorder.py tests/test_ao_ledger.py tests/test_skill_trajectory_mode.py -q` 全绿。
2. `git diff --stat` 展示，session.py 改动行数在限内。
3. 报告挂点位置（文件+函数+行号）、端到端做没做及原因。
