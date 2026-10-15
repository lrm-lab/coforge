# Agent Evolution 入场原子产生 active skill revision

Q13-C 决定：Causal Diagnosis 在冻结 ReaderReport 后产出的 proposal，经服务端 schema、ACL、provenance、content hash 与幂等完整性校验成功后，自动进入 Agent Evolution；同一原子 transition 产生不可变的 `published_active_skill_revision`。该 revision 立即具备其适用 scope 内的在线检索与执行资格，不再经过独立 promotion Evaluator、candidate 暂存态或 published-inactive 激活步骤。

这里的 active 是资格状态，不是质量结论：它不表示已有正效用、必然高排名、强制被任务选中，也不绕过常规 ACL、provenance integrity、可执行兼容性、撤销或安全硬门。曝光、引用与生成方自报成功均不产生正效用；后续真实 invocation/adoption、followthrough、客观 outcome 与配对对照仍由异步 utility 链路独立记账并影响排序和治理。

## Considered Options

- 完整性校验后原子产生 `published_active_skill_revision`（**选定**）：最短路径获得在线经验，同时把资格、效用和排名分离。
- 先产生 `evolution_candidate`（否决）：重新引入未定义的后置审批或停滞队列，与 Q11-C 自动进入意图不符。
- 先产生 `published_inactive_skill_revision`（否决）：publication 后仍需额外 activation transition，延迟在线反馈且没有已选定的激活责任主体。

## Consequences

- Proposal 与 executable skill namespace 继续分离，Agent Evolution 仍是唯一发布/更新通道，Diagnosis 仍无 skill 直写权。
- 新 revision 会以零或低样本进入在线候选集；冷启动探索、utility 归因、时间衰减、熔断与回滚策略必须另行定义，不能由 active 状态暗示。
- 本 ADR supersede ADR-0001、ADR-0007 与 ADR-0021 中将 Evolution 后置 candidate/publication/activation 状态留作未决的部分；其余证据、完整性、审计与唯一写入约束继续有效。
