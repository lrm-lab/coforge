任务：在 OpenViking 中实现 AO 台账（action-observation ledger）核心模块（切片 S1/6，不含 session commit 集成）。

工作目录：/home/zhoujie22/river2_0/OpenViking（已 cd，git 分支 feat/fork-node-foundation）

背景（必读，按序）：
1. /home/zhoujie22/river2_0/skill-node-design-grill/CONSENSUS.md —— 设计共识，重点第 1-4 条（AO 台账）与第 21 条（ao_id 全局唯一）
2. /home/zhoujie22/river2_0/skill-node-design-grill/docs/adr/0002-ao-ledger-lazy-fork-construction.md —— 台账决策与后果
3. /home/zhoujie22/river2_0/OpenViking/openviking/session/tool_result_synopsis.py —— 现成的确定性 synopsis 生成器，必须复用其 ToolResultSynopsis 与公开摘要函数（读它找入口）

实现要求：

新建 `openviking/session/ao_ledger.py`：
1. `AORecord`（frozen dataclass，字段）：`ao_id: str`（uuid4 hex，全局唯一、永久不变）、`session_id: str`、`sequence: int`（session 内单调递增，从 1 起）、`action: dict`（至少含 tool 名与参数摘要，禁止存大原文，参数超 2KB 截断并记 truncated 标志）、`observation: dict`（复用 tool_result_synopsis 的输出 dict：kind/title/summary/structure/notable_items/sample；大结果只存外置引用时记 artifact_ref）、`skill_invocations: list[dict]`（必有字段，无 skill 时为空列表 []，禁止省略；v1 由 `extract_skill_invocations` 钩子生成，默认返回 []）、`message_ref: dict | None`（来源消息 id/span）、`created_at: str`（ISO8601 UTC）、`captured_state: str`（恒为 "live"；归档归属不在本记录上）。提供 to_dict/from_dict，JSON 往返无损。
2. `AOAttribution`（frozen dataclass）：`ao_id`、`archive_id: str`、`commit_watermark: str`、`attributed_at: str`。归属是独立追加记录，绝不改写 AORecord（这是 ADR-0002 的硬约束）。
3. `AOLedger` 类：每 session 一个实例，构造参数 (session_dir: Path, session_id: str)。持久化文件为 session 目录下 `ao-ledger.jsonl`（append-only，每行一个 AORecord JSON）。方法：
   - `append(action: dict, observation: dict, skill_invocations: list[dict] | None = None, message_ref: dict | None = None) -> AORecord`：分配 ao_id 与 sequence（threading.Lock 保证并发下 sequence 单调且 ao_id 唯一），立即落盘（open "a" + write + flush）。
   - `records(start_sequence: int | None = None, end_sequence: int | None = None) -> list[AORecord]`：按 sequence 升序读。
   - `get(ao_id: str) -> AORecord | None`。
   - `count() -> int`。
   - `load_existing()`：实例化时自动加载已有 jsonl（容错：跳过损坏行并计数）。
4. `build_observation(tool_result_content: str | dict) -> dict`：内容为 str 时按 text 处理，dict 时尝试 json/yaml；内部调用 tool_result_synopsis 的现有函数生成 synopsis dict。若该模块公开入口不合适，写一个薄适配层，不要复制其实现。
5. `extract_skill_invocations(tool_call: dict) -> list[dict]`：v1 恒返回 []，docstring 注明这是运行时采集钩子，后续切片接真实 skill 调用信息。
6. 文件头加与仓库一致的 SPDX 版权注释（照抄 tool_result_synopsis.py 的头部格式）。类型注解齐全，风格对齐仓库现有代码。

测试 `tests/test_ao_ledger.py`（用 pytest，tmp_path fixture）：
1. ao_id 全局唯一：两个不同 session 的 ledger 各 append 若干条，所有 ao_id 无重复。
2. sequence 每 session 内严格递增；并发 append（threading 两个线程各 50 条）后 sequence 无重复无空洞。
3. AORecord 无 archive 相关可变字段；to_dict/from_dict 往返相等。
4. jsonl 持久化：新建同路径 AOLedger 实例 load_existing 后数据完整；故意写入一行损坏 JSON 后 load 不抛异常且跳过。
5. build_observation：对 JSON 字符串与纯文本各生成含 kind/title 的 synopsis dict。
6. skill_invocations 默认 []，序列化后字段存在。

约束：
- 不修改任何现有文件（包括 __init__.py 可选导出也不动，保持零侵入；本切片独立成模块）。
- 不引入新第三方依赖（stdlib + 已有依赖）。
- 新模块 import 只允许：stdlib、typing、openviking.session.tool_result_synopsis。不得 import openviking 其他重量级模块（保证单测轻）。

验收标准（完成后逐条自查并在结尾报告）：
1. `python3 -m pytest tests/test_ao_ledger.py -q` 全绿（在 /home/zhoujie22/river2_0/OpenViking 下执行）。
2. `git status --short` 显示仅新增上述两个文件。
3. AORecord 不可变且无归档字段；AOAttribution 独立。
4. 结尾输出：新增文件清单、测试结果原文（pass/fail 计数）、你对复用 tool_result_synopsis 的方式说明。
