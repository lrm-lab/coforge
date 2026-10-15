# 对照协议：如何让 LearnedSkill 分支的评测真正可比（v1，2026-09-27）

> 本文是下一阶段的权威执行协议。来源：evo-lsk-negative-gain-analysis.md 的结论。
> 原则：跨分支直接比分数没有意义（后端、契约、工具面全不同）；有意义的对照是**同一 harness 契约下的处理效应**。

## A. 先修测量（所有臂共用同一契约，修完才允许任何重跑）

1. `final_output` 取任务 agent **最后一条含代码块的消息**（不取 ACK）。修复项必须配一个回归用例：warm/cold 各抽 3 条曾因 ACK 记 0 的翻转题，修后应能抽出代码。
2. settle：等 offer、或 memory agent 明确声明无物、或任务安静后固定宽限期（三选一，两臂一致，写入 REPRO）。
3. 任务沙箱每集隔离（禁止 268 集共用目录残留 82 个 .py 的做法）。
4. 机制指标分列记账：`memory_offer_deliveries`、exploration citations、频道 `@task` 交接数、（实现后）Disposition。
5. warm workspace 保留 + 蒸馏后快照（已在做，确认覆盖全臂）。

## B. 再修投递（处理效应必须真实流动，不许靠模型自觉）

评测侧确定性投递：蒸馏完成后 harness 直接 `publishMemoryOffer`（demo 已验证 delivery 表是通的），reminder 带 conversation/target UUID。产品侧 Disposition/Hint 状态机（CONSENSUS #53）留作产品任务，不阻塞评测。

**有效性门槛（预注册，不达标该 run 作废，不得用于结论）：**
- warm 臂 offer 投递率 ≥ 80% episodes
- 两臂 final_output 代码抽出率差 ≤ 5pp
- 两臂 leak/timeout 率差 ≤ 10pp（超出需归因后才能解读）
- 两臂 episode prompt 逐字节一致（抽样 diff）

## C. 分臂设计（同分支内测处理效应）

| 臂 | 定义 | 测什么 |
|---|---|---|
| cold | 空 substrate，双 agent | 对照 |
| warm-loop | ingest→distill→**确定性 offer**→任务 agent | loop 全链路效应（主对照） |
| warm-channel | 频道累积但关闭蒸馏/offer（可选消融） | 分离"频道闲聊"与"loop 效应" |

跨分支问题（OV fence vs group-memory）只有在两边都跑通各自 warm-loop/cold 且契约一致后，才允许比"增益的增益"，并须声明残余混杂。

## D. 统计与功效

- 主指标：配对 win/loss（McNemar 精确检验）+ bootstrap 95% CI（B=20000）。
- 功效：86 题 ±10pp 的 CI 不足以支撑结论 → **每臂 3 个 seed**（run_id 已含 seed），258 个配对/臂；报告按 seed 分层 + 合并两口径。
- 次级指标：机制门槛通过率、offer→outcome 转化（有 disposition 后）。
- 先跑 20 题试点验证 B 的门槛，通过后再放全量；不通过回 B 修，不进全量。

## E. 执行顺序（给下一个 cursor 会话）

1. 等 evo-lsk1-cold 跑完（不重启），出全集数字 → 归档为"修正前基线"。
2. 实现 A1-A4 + B（不重跑 evo-lsk1）。
3. 20 题试点（warm-loop vs cold，seed 1）验证门槛。
4. 全量：evo warm-loop×3seeds + cold×3seeds；随后 SLB/SF/skillsbench/LoCoMo 按 C 的臂设计各跑（LoCoMo 为每问题配对）。
5. REPORT.md 增加"对照协议 v1"章节：门槛通过情况、分臂配对表、与修正前 evo-lsk1 的差异归因。
