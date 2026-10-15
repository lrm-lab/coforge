# G1：时钟注入补全（评审 Minor #17）

仓库：/home/zhoujie22/river2_0/OpenViking（分支 feat/fork-node-foundation，已检出）

## 背景
修复轮评审指出：citation_ledger、trajectory_index、influence_projection、memory_hints、handoff_envelope、evaluation_orchestrator 已接受 clock 注入，但以下位置仍直接调用 `datetime.now(timezone.utc)`，未传时间戳的路径测试不可复现：
- openviking/session/influence_view.py（draft/freeze 时间戳，约 50-51、794 行附近）
- openviking/session/causal_bridges.py（record_judgment/reactivate 时间戳，约 63-64、765 行附近）
- openviking/session/causal_experiences.py（created_at 与幂等/干预史时间戳，约 114-115、1000、1210 行附近）
- openviking/session/ao_ledger.py（记录时间戳，约 37 行附近）

## 目标契约
1. 上述模块统一增加 clock 注入：参数名 `clock: Callable[[], datetime]`（timezone-aware），默认 None；None 时保持现行为（datetime.now(timezone.utc)）。
2. 沿构造链传递：同一对象内部需要时间戳的 helper 也从同一 clock 取时，不允许同一对象一半注入一半直取。
3. 不改变任何已落盘格式（时间戳字段名/精度不变）。
4. 不得放宽 F1a-F2e 已收紧的任何校验。

## 允许修改的文件
openviking/session/influence_view.py、causal_bridges.py、causal_experiences.py、ao_ledger.py、ao_ledger_recorder.py（仅当其含时间戳逻辑）；
tests/test_influence_view.py、test_causal_bridges.py、test_causal_experiences.py、test_ao_ledger.py、test_ao_ledger_recorder.py、test_fork_revision_lifecycle.py。
其他文件一律不动（test_citation_ledger.py 等已含 clock 的模块不需要碰）。

## 验收
- 每个模块至少 1 个新测试：注入固定 clock（返回常量）后，落盘记录的时间戳等于该常量。
- 现有测试全部保持通过：
  `cd /home/zhoujie22/river2_0/OpenViking && python -m pytest tests/test_influence_view.py tests/test_causal_bridges.py tests/test_causal_experiences.py tests/test_ao_ledger.py tests/test_ao_ledger_recorder.py tests/test_fork_revision_lifecycle.py -q`
- 粘贴最终测试输出。

【硬约束】禁止执行任何 git 命令（不 add/commit/branch/checkout）；只改允许文件；完成后自测并粘贴结果。
