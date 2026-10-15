# E1：Memory→Diagnosis→Memory 评测循环最小真实跑通（评审 Major #15、ADR-0012、CONSENSUS #58）

仓库：/home/zhoujie22/river2_0/OpenViking（分支 feat/fork-node-foundation，已检出）

## 背景与设计依据
EvaluationOrchestrator 目前只有状态机+守卫，"模块不创建 DiagnosisBrief、不 deliver envelope、不 commit_provisional、不投递 Memory Hint"（评审 #15 点名）。目标：在进程内、协作方全部注入（stub LLM 即可）的前提下把闭环真实跑通。真实 LLM / HTTP 路由 / 常驻 daemon 仍是后续集成，不在本切片范围。

## 目标契约
1. 新模块 openviking/session/evaluation_loop.py：MinimalEvaluationLoop，组合既有组件：
   - 状态机：复用 EvaluationOrchestrator（不得绕过其守卫，含 F2e 迁移证据与 G5 已并入的席位校验）；
   - 诊断交接：进入诊断阶段时构造 DiagnosisBrief 并经 handoff_envelope 的 deliver（幂等键 iteration_id + handoff_kind + input_manifest_hash）投递；
   - 诊断执行：调用注入的 `diagnosis_fn(brief_view) -> 结构化 ForkDraft 提案列表`（stub 即可，但字段须符合 causal_experiences 追加 API 的入参契约）；
   - fork 提交：提案经 causal_experiences 的追加 API 提交 provisional（禁止直写 validated/invalidated；幂等键复用，重复提交返回原结果）；
   - 记忆回写：调用注入的 `hint_composer(fork_revisions) -> MemoryHint payload` 组装 MemoryHint，经 memory_hints 投递（带 task_lineage_id），并在 citation_ledger 记录对应 exposure/citation 事件；
   - 停止：沿用 orchestrator 既有停止条件，不新造。
2. 事件 payload_hash 占位替换为内容寻址真实哈希（canonical JSON 的 sha256，风格与 handoff envelope 一致）。
3. 幂等：同一 evaluation iteration 重放整个循环，不产生第二份 brief envelope / provisional fork / hint 投递 / citation 事件（依赖各 store 幂等键，逐层验证并断言）。
4. 每次状态迁移都携带 F2e 要求的迁移证据。

## 允许修改的文件
openviking/session/evaluation_orchestrator.py（仅限 payload_hash 与必要挂钩）、新文件 openviking/session/evaluation_loop.py；
新文件 tests/test_evaluation_loop.py（可少量扩展 tests/test_evaluation_orchestrator.py）。
其他模块只读引用，不得修改。

## 验收
新测试：注入 stub 协作方完整跑一轮——断言恰好 1 个 brief envelope、≥1 个 provisional fork、hint 已投递（带 lineage）、citation 事件已记、状态到达停止态；同 iteration 重放不产生第二份。
`cd /home/zhoujie22/river2_0/OpenViking && python -m pytest tests/test_evaluation_loop.py tests/test_evaluation_orchestrator.py -q` 全绿，粘贴输出。

【硬约束】禁止执行任何 git 命令；只改允许文件；不得绕过/放宽任何既有守卫（状态机、幂等、ACL、席位）。
