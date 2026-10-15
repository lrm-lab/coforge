# Q54 / Q55 / Q61 / Q63 / Q65 / Q90 / Q91 只读证据结案

日期：2026-10-10。只读核对 OpenViking 与 Coforge 当前检出。未改产品源码、测试、配置、锁文件或既有文档，未跑测试。分类只取：已实现、部分、缺失、明确延期。

## Q54 step-reward 前置评测器：部分

- 状态槽：`OpenViking/openviking/session/evaluation_orchestrator.py` 有 `EVENT_SCORE` 与 `OrchestratorState.SCORE`，位于 `TASK_RUN` 与 `FREEZE_BRIEF` 之间。
- 调用：`OpenViking/openviking/session/evaluation_loop.py` 的 `MinimalEvaluationLoop.run` 把调用方已有的 `key_judgment` 与 `evidence_refs` 推进 `EVENT_SCORE`，不计算奖励。
- 缺口：两库均无 step-reward scorer，也无“只产出候选定位信号、不写 fork”的输出类型。fork 仍由注入的 `diagnosis_fn` 经 `commit_provisional` 写入。

## Q55 Memory 群成员与 per-run Diagnosis runtime：部分

- Memory 频道成员（评测脚手架）：`coforge/benchmark/longmemeval-collab/src/workspace.ts`、`coforge/benchmark/skillsbench-collab/src/workspace.ts`、`coforge/benchmark/public-channel-memory/src/workspace.ts`、`coforge/benchmark/evolbench-collab/src/workspace.ts` 将 memory agent 写入 `conversationMember`。
- 产品侧只消费已有成员身份：`coforge/apps/web/src/server/workspace-memory/explicit-memory-answer.ts` 按 `conversationMember.agentId` 处理 `@memory`。身份映射在 `coforge/apps/web/src/server/workspace-memory/runtime-provisioner.ts`。
- 缺口：没有 per-run Diagnosis agent。`OpenViking/openviking/session/diagnosis_wiring.py` 是提交后的服务端回调，不调用模型。`evaluation_loop.py` 的 `diagnosis_fn` 只是注入函数。Coforge 无 Diagnosis runtime。

## Q61 跨任务四维语义重排：缺失

- 在线检索：`OpenViking/openviking/session/retrieval_facade.py` 使用语料内 BM25/混合分，默认 `IdentityRerank`，夹回因果记忆帽。该路径不读 `task_id`，也不按任务/决策类型、锚点状态、失败机制、行动与 skill 角色重排。
- 相邻但不是本合同：`OpenViking/openviking/session/causal_clusters.py` 的 `SimilarityJudgment` 保存四维判定；`submit_similarity_edge` 仅见于 `OpenViking/tests/test_causal_clusters.py`，不是在线 Memory 重排。

## Q63 双 lane：部分

- 已有因果记忆检索通道：`OpenViking/openviking/session/retrieval_facade.py`（文档标明 causal-memory lane；fact lane 暂停）。
- 已有另一组分席：`OpenViking/openviking/session/memory_role_retrieval.py` 把 exact lane 与 discovery 分开，席位不共享。
- 已有桥类型：`OpenViking/openviking/session/causal_bridges.py` 的 HypothesisBridge / EvidenceBridge。
- 缺口：没有 Interaction lane 与 Causal-memory lane 各自独立的候选、跳数和停止条件，也没有并入 `MemoryTaskState`。两库无 `MemoryTaskState` 类。

## Q65 InteractionPathWorker：部分

- 席位账：`OpenViking/openviking/session/evaluation_orchestrator.py` 的 `WorkerSeatPool` 共享 5 席，诊断批量上限 3；满池即 `NoSeatError`，不派发 worker。
- 缺口：两库无 `InteractionPathWorker`，也没有按有界 interaction path 返回 assessed refs、mechanism、applicability、contradictions 与 evidence refs 的编排。

## Q90 权威 task_id 铸造：缺失

- 评测环不铸造：`OpenViking/openviking/session/evaluation_loop.py` 的 `EvaluationIteration.task_id` 只校验调用方传入的非空字符串，replay 不继承原 ID。
- 另一处发号不是本合同：`OpenViking/openviking/session/session.py` 在会话归档时 `task_id = str(uuid4())`，属于 commit 任务号。没有“仅 task/evaluation orchestrator 可铸造、不可变、禁止按文本哈希合并、agent 只能引用”的权威入口。

## Q91 debiased_reference_signal 消费者：缺失

- 两库源码与测试均无 `debiased_reference_signal`。
- 已有的是检索侧标记：`OpenViking/openviking/session/retrieval_facade.py` 的 `selection_mode` 与 `SelectionAudit`（eligible set、propensity、seed、policy version）。`OpenViking/openviking/session/skill_revision_utility.py` 另有同名审计类型，不生成去偏信号，也不喂给下一版 reranker。
- `skill-node-design-grill/impl/G3-exploration.md` 写明该切片只做检索侧标记、不做去偏信号。这是切片边界，不是已定案的延期。`skill-node-design-grill/impl/decision-coverage-audit-20261009.md` 仍把 Q91 列为无实现证据，并要求补证据或延期理由。

实施闸门：保持关闭
