# LearnedSkill loop 评测报告

EvoAgentBench warm 臂已跑完 268/268 并离线判分（test 全集 54/86=62.8%）。cold 臂进行中（05:55Z 为 80/268），配对表还要等它跑完。最高优先级的 offer=0 已查清：见下文「Offer deliveries = 0」。下面是机制数字、冒烟，以及和 CONSENSUS 的差距。

## 激活面

Group memory 的开关是 `memory_agent_designations` 一行。蒸馏和 proposer 还要 `workspace_model_configurations`（purpose：`group_memory_distillation`、`group_memory_proposer`），日预算 10000，模型与 Memory Agent 相同（`lenovo-deepseek-v4-flash` / `DeepSeek`）。没有这行配置时检索仍可进行，蒸馏暂停。

Shadow gate（`runShadowGateSweep`）不调用模型：它读 offer delivery 和之后的 episode outcome，把活分 ≤0 的 revision 退休。它不是特性开关。

产品静默窗 30 分钟、入库扫描 5 分钟、蒸馏扫描 10 分钟。Harness 在 episode 结束后直接调用 `ingestQuietWindow`（`quietWindowMs=5000`）和 `sweepMemoryDistillation`。

本分支没有 `ov_*` fence。Memory Agent 的工具面是 `memory_start` / `memory_explore` / `memory_redirect` / `memory_submit` / `memory_offer`，外加 `send_channel_message`、`message_check`、`message_read`。`toolProfile.kind = "memory-explorer"` 写在 agent 的 runtimeConfig 上，AgentControl 把它抄进 Start。OpenViking fork-node（S1–S15）停在库级，不在这条评测路径上，因此没有第二套 OV 容器。

定向提问（`@memory`）的站立指令要求先探索再在频道里回答。`memory_offer` 用于把 insight 或 skill 交给没有发问的队友。模型在 Evo 冒烟里用 `send_channel_message` 写了 `@task` 交接，没有写 `MemoryOfferDelivery` 行。

## 手工链路

Workspace `lsk-loop-demo-979e5d89`（`d2681a48-42a2-4b54-9a19-14c690a821b8`）：

- 5 条 quiet-window episode 全部 `distilledAt` 非空
- 8 条 insight，1 条 active skill revision
- 第一条 proposal 被拒，原因 `ls-artifact-branch-instructions`；五段之后的 proposal `status=bound`
- `publishMemoryOffer` 写出 insight offer，`messageId=cfd56ff9-0005-422a-86bf-ed90d59e2817`

单段 episode 的 outcome 被标成 failure（对话停在互相确认，没有执行证据）。Critique 要累计 5 段蒸馏才跑，所以单段不会产出 insight。

## 冒烟

### LoCoMo（conv-26，只入库 session 15–19，1 题）

结果文件：`benchmark/public-channel-memory/result/lsk1-smoke/attempts-2026-09-26T075548170Z.jsonl`

| 项 | 值 |
|---|---|
| 问题 | When did Caroline go to the LGBTQ support group? |
| 蒸馏 | episodes=5 distilled=5 insights=4 skills=1 |
| 机制 | `ok` |
| exploration citations | 16 |
| 工具 | `memory_start`、`memory_explore`、`memory_submit` |
| offer 行 | 无（定向提问走频道回答） |
| 裁判 | `WRONG`（金标 7 May 2023；回复称记忆里没有该事件。证据多半在未入库的更早 session） |

判分链路已通。这道题不能代表 10 样本通过率。

### EvoAgentBench（1 条 train episode `1883_C`，warm）

结果文件：`benchmark/evolbench-collab/result/lsk1-smoke/evo-lsk1-smoke-attempts.jsonl`

| 项 | 值 |
|---|---|
| 时长 | 621 秒 |
| Memory Agent | `memory_start` / `memory_redirect` / `memory_submit`，然后 `send_channel_message`，正文以 `@task` 开头 |
| offer 行 | 0 |
| exploration citations | 0（family 里还没有已蒸馏记忆） |
| Task Agent | 13 次工具调用，末段是 bash 与 write；频道最终消息 1622 字 |
| 行内状态 | `status=success`，同时 `error=episode timeout`，`mechanism=leak` |

`mechanism=leak` 和 timeout 来自当时的收尾规则：没有 offer 行时，任务消息安静超过 abort 窗口仍记超时，且交接消息被算进 leak。后续 runner 已改成：任务频道消息安静达到 settle 就收口；只有任务方没有最终消息时，memory 的额外频道消息才记 leak。这一行是改规则之前的冒烟，不能并进全量通过率。收口后的蒸馏是 episodes=1 distilled=1 skills=1。

## 与设计预期的差距

- 定向问答的引用在 `memory_exploration_citations`，不在 `memory_offer_deliveries`。Offer 率不能单独代表 LoCoMo 的回忆是否发生。
- 模型把交接写成频道 `@task`，没有调用 `memory_offer`。Shadow gate 因此在冒烟里没有 delivery 信号。
- 首条 skill proposal 会因 artifact schema（`ls-artifact-branch-instructions`）被拒；多段蒸馏之后可以 `bound` 出 active revision。
- 开发态页面 `/en/messages` 返回 500。Agent API 与 `/api/jwks` 可用。Harness 的就绪探测改为 `/api/jwks`。
- CONSENSUS 里 Memory/Diagnosis 共享检索和 OV fork-node 编排没有接到 coforge 的这条运行时，本次评测覆盖不到。

## Evo warm 全量（2026-09-27T00:37Z，268/268 已写完）

eval id `evo-lsk1`，workspace `e76f35f7-0c46-45e7-8f73-e8d8aa0f50df`（slug `lsk-evol-warm-code-implementation-9c1a1b07`）。attempts：`benchmark/evolbench-collab/result/evo-lsk1-attempts.jsonl`。summary：同目录 `evo-lsk1-summary.txt`。日志末行 `episodes=268 distilled=268 insights=63 skills=1`。

| 口径 | success（写出最终消息） | no_offer | leak | timeout | recall_citations>0 | mechanism=ok |
|---|---|---|---|---|---|---|
| 全部 268（train 182 + test 86） | 242 | 242 | 21 | 5 | 0 | 0 |
| 配对用的 test 86 | 66 | 66 | 16 | 4 | 0 | 0 |

`status=success` 只表示任务频道里有最终消息。离线判分（LiveCodeBench `check_correctness`，全对记 1）已写入 `benchmark/evolbench-collab/result/evo-lsk1-graded/`。

| 口径 | test 86 | train 182 | 全部 268 |
|---|---|---|---|
| 全集通过率（无最终消息 / 抽不出代码记 0） | 54/86 = 62.8% | 156/182 = 85.7% | 210/268 = 78.4% |
| 只看写出最终消息的子集 | 54/66 = 81.8% | 156/176 = 88.6% | 210/242 = 86.8% |

Test 集里未通过的 32 集：20 集没有最终消息（16 leak + 4 timeout），6 集抽不出代码，6 集代码未全对。

## Offer deliveries = 0：根因（2026-09-27 复查）

结论先说：**不是 shadow gate 默认拦截，也不是 workspace 没开 loop。** Warm 臂实际测到的是「ingestion → distillation → insight/skill artifact → proposer」，**没有**测到「模型调用 `memory_offer` → 任务 agent 收到带 provenance 的 offer → shadow gate 记分」。CONSENSUS 叙述 #18（fork node 权威提交后才触发评估编排）是 OV fork-node 路径，**没有接到这条 coforge 运行时**，不能用来解释 offer=0。

| 假设 | 判定 | 证据 |
|---|---|---|
| Shadow gate 默认拦住投递 | **否** | `runShadowGateSweep` 是 LLM-free 的事后扫描：只读**已经投递的 skill offer**，按后续 episode outcome 给 revision ±1，活分 ≤0 才退休。它不发布、不拦截 offer。没有 delivery 时它是空转。 |
| Workspace 没开 loop / 缺 model config | **否** | 跑批当时日志：`episodes=268 distilled=268 insights=63 skills=1`。Harness 对每个 workspace `enableEvalGroupMemory` + `configureEvalDistillationModel`（日预算 10000）。 |
| Distillation 之后系统应自动 offer | **否，产品设计** | `publishMemoryOffer` 只挂在 Memory Agent 的 `memory_offer` 工具 / `/api/agent/v1/memory` `op=offer`。蒸馏和 proposer 只写 insight / skill revision / proposal ledger，不投递。 |
| 模型调用了但 API 失败 | **未见** | 全库 `memory_offer_deliveries` 只有 demo 的 1 行。没有失败重试留下的 delivery。Warm 268 集 mechanism 全是 `no_offer`（或 leak/timeout），citations 列只数 offer 行。 |
| Demo 证明模型会 offer | **否** | `benchmark/lsk-memory/demo-loop.ts` **进程内直接调用** `publishMemoryOffer`。那只能证明表和路由通，不能证明模型会选这个工具。 |
| CONSENSUS #18 要求权威提交后才投递 | **张冠李戴** | 叙述 #18 / 决策总账 #27 是 fork node 权威提交 → daemon replay 判定 → evaluator 审 proposal。LearnedSkill 的 shadow gate（ADR 0052-D）是另一条线。 |

产品站立指令（`buildMemoryExplorerSection`）把两条路分开：

- 有人 **问了** 团队记忆：`memory_start` → explore → **频道回答**。
- 探索到 insight/skill、且队友 **没问**：才 `memory_offer`。

Evo harness 把每集写成 `@memory ${prompt}`（定向提问），reminder 却要求 `memory_offer`。模型走站立指令的定向路径：`send_channel_message` 写 `@task` 交接。`memory_offer` 还要 `conversation_id`、`target_agent_id`、已存在的 insight/skill UUID；站立指令只注入 Memory Agent 自己的 agentId，不注入频道 UUID 和 task agent UUID，工具比 `@task` 难用一个数量级。

Evo 的 `latestOffer` **只数 `memory_offer_deliveries`**。PCM 才把 `memory_exploration_citations` 并进 citation。所以 Evo 的 `citations=0` **不能**读成「没做检索」——只能读成「没有结构化 offer 行」。LoCoMo 冒烟已经是 16 条 exploration citation、0 条 offer。

正在跑的 cold 活 workspace（`lsk-evol-cold-code-implementation-e0c48f9f`，2026-09-27T05:55Z）有 2 个 `memory_exploration_sessions`，均 `found=false`、citation=0、offer=0：检索工具在动，空 substrate 上找不到东西，也没有 offer。Cold 80 集同样 citations=0 / 几乎全 `no_offer`。

Warm workspace 在 family 结束后被 `destroyEvalWorkspace` 级联删掉，268 集的 substrate **现在库里已经不在**（只剩 demo + 当前 cold）。跑批当时的 63 insights / 1 skill / 0 offers 以日志为准，无法再 SQL 复核。这是 harness 问题，不是产品问题。

**Warm 臂覆盖了什么 / 没覆盖什么**

- 已覆盖：quiet-window 入库、蒸馏、insight 头、proposer→1 条 skill、频道 `@task` 交接、任务 agent 写最终消息、离线 LCB 判分（test 62.8%）。
- 未覆盖：`memory_offer` 投递、任务 agent 收到带 provenance 的 offer、shadow gate 记分/退休、CONSENSUS #53 `memory@` Hint / Disposition、OV fork-node 评估编排。
- 未改产品代码。Harness 事后只做了三件不改变 evo-lsk1 已写结果的事（正在跑的 cold bun 进程已加载旧模块）：warm family 结束不再删 workspace；release 前打 `group-memory-snapshot`；后续新进程的 reminder 带上 `conversation_id` / `target_agent_id`，并另打 `explore_cites=`。evo-lsk1 的 mechanism 口径保持「只认 offer 行」。

## Evo cold（进行中）

eval id `evo-lsk1-cold`，`eval/bin/lsk-evo-cold.sh` 自 00:37Z 起，未重启。2026-09-27T05:55Z：80/268，success 66 / leak 13 / timeout 1，citations 全 0。日志 `eval/logs/evo-cold-lsk1.log`。`lsk-after-cold.sh` 会在 summary 后离线判分到 `result/evo-lsk1-cold-graded/`。配对差值要等 cold 跑完。

## 尚未形成配对表的基准

SkillLearnBench、SkillFlow、SkillsBench、LongMemEval、LoCoMo 全样本，以及 Evo cold 的判分，都还没有配对通过率。SLB / SF sidecar 用 8734 / 8735。SkillsBench 必须设置 `COFORGE_EVAL_TASKS`。其余脚本见 `eval/REPRO.md` 与 `eval/NEXT.md`。
