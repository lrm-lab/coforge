任务：实现 skill_trajectory_mode 行为开关（legacy | causal）（切片 S3/6）。

工作目录：/home/zhoujie22/river2_0/OpenViking（已 cd，git 分支 feat/fork-node-foundation，S1 已提交：openviking/session/ao_ledger.py 存在）

背景（必读）：
1. /home/zhoujie22/river2_0/skill-node-design-grill/CONSENSUS.md 第 4 条与第 28 条（决策 16）
2. /home/zhoujie22/river2_0/skill-node-design-grill/docs/adr/0004-legacy-causal-mode-switch.md
3. 仓库现有配置结构：openviking/session/memory_policy.py、openviking/config/ 目录——先读它们，弄清 memory.* 配置的既有定义与解析方式，把新开关放进**同一套机制**里，不要另造配置系统。

实现要求：

1. 新枚举/常量：`SKILL_TRAJECTORY_MODE_LEGACY = "legacy"`、`SKILL_TRAJECTORY_MODE_CAUSAL = "causal"`。
2. 在既有 memory 配置体系中新增 `skill_trajectory_mode` 字段（找到 memory_policy.py 或对应 config dataclass 的正确位置），默认 `"legacy"`，取值校验仅允许两值，非法值报错。
3. 提供解析/判定入口（放在配置所在模块或 ao_ledger.py，你判断哪个更合适）：
   - `resolve_skill_trajectory_mode(...) -> str`：接受配置来源（按仓库现有配置读取习惯），返回 legacy 或 causal；
   - `is_causal_mode_enabled(...) -> bool`。
   本切片只做**全局默认**作用域（workspace 覆盖与 session 固化是后续切片，函数签名留出扩展空间并在 docstring 注明）。
4. 不改动任何现有行为：默认 legacy 下，所有现有代码路径零变化（新增字段只被新代码读取）。
5. 若 memory 配置有 YAML/JSON 序列化测试或 schema 测试，确认新增字段兼容（可缺省）。

测试（tests/test_skill_trajectory_mode.py，或在配置既有测试文件旁新增文件）：
1. 默认值为 legacy。
2. 显式设 causal 时 resolve 返回 causal、is_causal_mode_enabled 为 True。
3. 非法值（如 "fast"）被拒绝并抛错。
4. 字段可缺省（老配置不带该字段时解析成功且为 legacy）。
5. ao_ledger 模块在 legacy 下不因此报错（import 层面无循环依赖）。

约束：遵循仓库现有代码风格与 SPDX 头；不引入新依赖；除配置文件外新增文件不超过 2 个；对现有文件的修改最小化（只加字段与解析，不改既有字段语义）。

验收标准（结尾逐条报告）：
1. 新测试全绿：`python3 -m pytest tests/test_skill_trajectory_mode.py -q`。
2. 既有相关测试不回归：跑配置模块对应的既有测试文件（找到并运行，报告结果）。
3. `git status --short` 列出全部改动文件与新增文件。
4. 说明：新字段加在哪个文件哪一行附近、resolve 函数签名、扩展点在哪。
