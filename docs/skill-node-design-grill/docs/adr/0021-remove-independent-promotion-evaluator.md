# 移除独立 promotion Evaluator，Diagnosis proposal 自动进入 Agent Evolution

Q11-C 推翻旧的 Proposal→独立 Evaluator approval→Agent Evolution 尾门。Causal Diagnosis 在冻结 ReaderReport 后生成的 proposal，经服务端仅限 schema、ACL、provenance、content hash 与幂等的完整性校验后，自动进入 Agent Evolution；不再存在独立模型或人工角色作 promotion approval。Agent Evolution 仍是 executable skill 的唯一发布/更新通道，Diagnosis 仍无 skill 直写权。

该决定不删除 AIG Critic、Evidence Reader、ForkRevision provisional/validated/invalidated 生命周期、四维适用性与反例检查、replay/continuation ControlContract、客观 outcome 或异步 utility aggregation；生成方自报成功仍不构成效用或对照证据。后续 Q13-C/ADR-0022 已明确 Agent Evolution 的后置状态：完整性校验与幂等判定成功后，同一原子 transition 产生不可变的 `published_active_skill_revision`，立即具备适用 scope 内的在线检索与执行资格。active 不是质量批准，不代表已有正效用、必然高排名或绕过常规 ACL、安全、兼容性与撤销硬门；后续客观 outcome 与异步 utility 仍独立记账。

本 ADR supersede ADR-0001、ADR-0007 与 ADR-0012 中要求独立 Evaluator 批准 skill promotion 的部分；这些 ADR 的事实/因果验证、Evolution 唯一写入、对照与审计约束继续有效。
