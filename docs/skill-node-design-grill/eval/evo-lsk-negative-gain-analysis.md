先读进度、设计和评测产物，确认 warm/cold 实际差在哪，再按产品、harness、统计三层下结论。进度已确认 offer=0 与 workspace 已删。接下来对照 attempts、判分和 harness，核对 warm/cold 实际输入差。并行读 REPORT、harness 与 attempts 结构，并抽配对翻转题核对产品链路与统计。子代理结论需用源码和判分文件复核，并计算 bootstrap CI。接下来核对 Evo 的 family 粒度，以及基线是否真的按题簇分 workspace。用只读脚本算配对、翻转和 bootstrap CI，并抽几条 attempts 看任务 agent 实际收到了什么。翻转里大量是「最后一条 ACK 覆盖了代码」。再核对错交接、任务 agent 站立指令，以及基线官方 family 语义。# 为什么 LSK 分支 EvoAgentBench 的 warm−cold 是负增益

**先给结论（按证据强度）**

1. **这次评测没有测到 LearnedSkill 的消费闭环。** 结构化投递（`memory_offer` → `memory_offer_deliveries` → 任务 agent 带 provenance 的 offer）全量为 0。warm 臂测到的是「入库→蒸馏→63 insights / 1 skill + 频道 `@task` 闲聊交接」，不是 CONSENSUS 叙述 #53 的 `memory@` Hint / Disposition，也不是叙述 #18 的权威提交评估编排。
2. **点估计 −2.5pp 的 16 次翻转，几乎全部是交卷/收口伪影，不是「记忆让代码变差」。** 9 次 cold 独胜里：6 次是 warm 已经写出可判代码、又补了一条 ACK，harness 取**最后一条**任务消息，LCB 抽不出代码（`code_source=none`）；3 次是 warm leak/timeout 没交卷。7 次 warm 独胜里对称地有 3 次 cold ACK、3 次 cold leak。真正的代码对错翻转只剩 `abc335_c`。
3. **−2.5pp 与基线 +7.0pp 的差距，在 95% 置信下都还没超出噪声。** LSK gain 的 bootstrap 95% CI 是 **[−12.5pp, +7.5pp]**，覆盖 0；McNemar 双侧 p≈0.80。基线 +7.0pp 的 CI 是 **[−1.2pp, +15.1pp]**，McNemar p≈0.18。两套 gain 之差的 CI 也覆盖 0。

下面按产品 / harness / 统计展开。配对口径：manifest test 顺序前 80 题（`3423` … `arc186_d`），与用户给出的 52/80 vs 54/80、7/9/45/19 一致。cold 仍在跑，缺最后 6 题（`arc186_e` … `arc195_d`）。未重判。

数据文件：

- warm attempts：`/home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval/benchmark/evolbench-collab/result/evo-lsk1-attempts.jsonl`
- cold attempts：`…/evo-lsk1-cold-attempts.jsonl`（当时 81 行）
- warm 判分：`…/evo-lsk1-graded/graded_attempts.jsonl`
- cold 部分判分：`/tmp/evo-lsk-partial-grade/graded_attempts.jsonl`
- 基线：`…/cursor-ov-cm-impl/…/evo-code-full-collab-1-dedup.jsonl` 与 `grade-evo-collab-1/graded_attempts.jsonl`
- manifest：`/home/zhoujie22/river2_0/evol_bench/EvoAgentBench/data/evo-code-implementation.jsonl`

---

## 1. 产品层：记忆有没有送达任务 agent

### 1.1 结构化路径：没有（证据强）

| 观测 | 值 | 出处 |
|---|---|---|
| offer deliveries | 0 / 268 | `eval/REPORT.md`「Offer deliveries = 0」；warm 日志每集 `citations=0`（`eval/evo-warm-lsk1.log`） |
| `recall_citations` | 全 0 | attempts 字段；`latestOffer` 只读 `memory_offer_deliveries`（`benchmark/lsk-memory/host.ts` 162–182 行） |
| `mechanism=ok` | 0 | 有最终消息则一律 `no_offer`（`leak.ts` 12 行） |
| shadow gate | 空转，不拦截 | `eval/REPORT.md` 表；`PROGRESS.md` 05:56Z offer-root |
| demo 那条 offer | 脚本直调 `publishMemoryOffer` | `eval/REPORT.md` 97 行；`NEXT.md` 50–58 行 |

蒸馏本身是真的：日志 `episodes=268 distilled=268 insights=63 skills=1`（`PROGRESS.md` 00:38Z；warm 日志从第 5 集起 insights 从 0 爬到 4）。产品设计是：**蒸馏/proposer 不投递**，只有模型调用 `memory_offer` 才写 delivery（`REPORT.md` 95 行）。

站立指令把两条路拆开（`packages/daemon/src/code-agent/agent-instructions.ts` `buildMemoryExplorerSection` 595–608 行）：

- 有人问了团队记忆 → `memory_start` / explore → **频道回答**
- 队友**没问**、但探索到 insight/skill → 才 `memory_offer`

Harness 每集都是 `@memory ${prompt}`（`eval-qa.ts` `episodePrompt` 16–27 行），等于「问了」。模型走频道 `@task`，不走 offer。reminder 还要求 `memory_offer`（`benchmarks.ts` 15–16 行 `MEMORY_HANDOFF`），和站立指令打架。evo-lsk1 当时的 reminder **没有** `conversation_id` / `target_agent_id`（这两项是 09-27 05:56Z 之后才补的，`REPORT.md` 117 行；正在跑的 cold bun 仍是旧模块）。

所以：**CONSENSUS 叙述 #18 解释不了 offer=0**（那是 fork-node 权威提交后的评估编排，决策总账 #27；`REPORT.md` 98 行已写「张冠李戴」）。offer=0 是产品工具选择 + harness 定向提问 + 收口不等 offer，三件事叠在一起。

### 1.2 非正式路径：频道 `@task` / `<@agent>` 有送达（证据中强）

任务 agent 的站立角色写的是「读 Memory Offer，再执行」（`workspace.ts` `TASK_AGENT_DESCRIPTION` 23–30 行）。实际唤醒是 Memory Agent 的频道消息，不是 offer 行。

证据：

- 冒烟 `1883_C`：Memory 用 `send_channel_message`，正文以 `@task` 开头；offer 行 0（`REPORT.md` 46–55 行）。
- 配对 80 里，warm 有 5 条 `final_output` 含 `<@agent:768c3a36-…>`（这是 warm Memory Agent id，见 `evo-warm-lsk1.log` 第 2 行）。文案是「Thanks / offer matches / already posted」，说明任务 agent **看见了** Memory 的交接，并当成「offer」回了一句。
- `arc186_c`（warm 过、cold leak）：任务 agent 写「handoff referenced a paper-folding task that does not match — answered the human prompt」。这是跨题污染的直接证据：Memory 把**别的题**的蒸馏内容递过来了。任务 agent 丢掉它、按本题做，仍判对。
- cold 侧也有「Thanks — approach matched / Memory held nothing」类回执（如 `abc336_b`、`abc374_c`）。cold 的活 workspace 上 exploration `found=false`（`REPORT.md` 109 行），空 substrate 上检索在动、找不到东西。

**warm 与 cold 对任务 agent 的输入差，因此只有这几层：**

| 层 | warm | cold | 是否进入 LCB 分数 |
|---|---|---|---|
| 本集 `@memory` 题面 + 代码 reminder | 相同 | 相同 | 间接（模型行为） |
| 结构化 `memory_offer` / Hint / Disposition | 无 | 无 | 无 |
| Memory 检索 substrate | 268 集累积的 63 insights / 1 skill | 每集空 workspace | 只经频道闲聊，无 provenance |
| 频道 `@task` 交接正文 | 可能含错题回忆（`arc186_c`） | 多为「没有先验」 | 有时触发第二条 ACK，见下 |
| 任务沙箱 `work_dir` | **268 集共用 1 个目录**，残留 112 个文件 / 82 个 `.py` | 每集新目录 | 可能干扰实现，未直接入分 |
| 模型 session | 每集 `episodeClosure` stop→清 `currentSessionId`→restart（`run.ts` 149–171 行） | 新 workspace | 不跨集带模型上下文 |

Harness **不**把检索 JSON 注入任务 agent。`final_output` 只取本集 prompt 之后任务 agent 的**最后一条**频道消息（`eval-qa.ts` 121–140 行）。

### 1.3 频道累积有没有干扰（证据中：收口伪影强，效用伤害弱）

**收口伪影（强，直接解释翻转）**

判分器吃 `final_output`。任务 agent 先贴代码，Memory 再交接，任务再回「offer matches, already posted」——最后一条没有 \`\`\`python\`\`\`，`grading.code_source=none`，记 0 分。

配对 80 失败分解：

| | 无最终消息 | 有输出但抽不出代码 | 抽出代码但未全对 |
|---|---|---|---|
| warm | 16（leak 13 + timeout 3） | **6** | 6 |
| cold | 14（leak 13 + timeout 1） | **4** | 8 |

6 个 warm「抽不出代码」里，5 个是 cold 独胜（`abc328_b`, `abc358_a`, `abc365_a`, `abc387_b`, `abc394_a`, `abc400_b` 这一组；`abc365_a` 输出仅 14 字符）。cold 对题有完整代码且 `passed=total`。

对称地，warm 独胜里 `abc320_a` / `abc325_e` / `abc379_b` 是 cold 最后一条 ACK、`code_source=none`。

`task_message_count≥2`：warm 7 集（6 失败），cold 11 集（3 失败）。多一条任务消息本身不稀有；**warm 更常把 ACK 留在最后一条**。

`memory_leak_count` 几乎每集都是 1（warm 72/80、cold 76/80）。LSK 把含 `@task` 的 Memory 消息排除出 leak（`eval-qa.ts` 144–148 行）；leakc=1 表示 Memory 还发过**不含字面 `@task`** 的消息（常见是 `<@agent:uuid>`）。mechanism 只在「任务没交卷」时才标 `leak`。所以 leakc 不能读成「Memory 乱说话导致做错题」。

**跨题交接（中，存在但本题仍过）**

`arc186_c` 错题 handoff 是实锤。warm workspace 已从 DB 删掉（`destroyEvalWorkspace`，`REPORT.md` 111 行），频道全文无法再 SQL。磁盘上只剩任务沙箱：

`/tmp/evol-daemon-e76f35f7/workspaces/e76f35f7-0c46-45e7-8f73-e8d8aa0f50df/agents/cd44ae69-91b4-48ec-b440-3a6fd2b19062`

里面是 `sol_*.py`、`brute_*.py`、`arc189c.py` 等残留，**没有** channel/transcript。无法逐集复盘 Memory 正文。

**时长 / leak 后段升高（弱～中，和 test 难度混杂）**

配对 80：warm 均时 254.6s vs cold 233.6s，中位数都是 ~140s。warm 全量按 manifest 四分位：Q1 leak 0 / 均时 142s → Q4 leak 12 / 均时 277s。但 test 从 index 182 才开始，Q3–Q4 基本是更难的 ABC/ARC，和「频道变脏」分不开。train leak 仅 5/182，test 16/86。配对 80 前 40 vs 后 40：warm leak 6 vs 7，cold leak 3 vs 10——**后半段 cold leak 更多**，不像「warm 频道越积越糟」的单因子故事。

---

## 2. Harness 移植混杂

### 2.1 「单一 workspace 268 集」vs「按 family 分 workspace」

**对 Evo 这套数据，LSK 和基线 harness 一样，都是一个 family、一个 warm workspace 跑满 268。** 不是 LSK 独有的混杂。

- Manifest **没有** `family_id`，`domain` 全是 `code_implementation`（268/268）。
- 两边 `parseManifestLine` 都是 `familyId = family_id || domain`（LSK/基线 `manifest.ts` 46 行）。
- warm 日志第一行：`families=code_implementation`。
- 两边 attempts 的 `family_id` 都是 `code_implementation`。
- 题干 stem（`abc320` / `arc186` / `1883`）有 208 个，train∩test 同 stem 仅 24 个——**官方题簇从未被当成 family**。

Harness **架构**是「每 family 一个 warm workspace」（`run.ts` 259–268 行；`brief-e2e-eval.md` 86 行）。Evo 只有一个 domain，所以退化成全程累积。基线同样退化。

**对 warm−cold 的方向：** 跨题 substrate + 共享沙箱，给 Memory 错交接、任务目录脏文件提供了条件（`arc186_c`、82 个残留 `.py`）。这会**压低** warm 的「干净执行」，理论上对 gain 为负向。但它解释不了「6 条 ACK 覆盖代码」——那是收口规则，cold 也会中招。

### 2.2 settle / leak / mechanism 被改过

| 项 | LSK（evo-lsk1 所用） | 基线 | 对 warm−cold 的方向 |
|---|---|---|---|
| settle | 任务消息安静 `settleMs`（120s）就收口，**不等 offer**（`eval-qa.ts` 162–167 行；`PROGRESS.md` 08:16Z，全量前已改） | 必须 `offerMessageId ≠ null` 且任务安静；否则骑满 timeout（基线 `eval-qa.ts` 162–170 行） | LSK **系统性地截掉**「任务已答、Memory 还想 offer」的窗口。两臂都变成 `no_offer`，gain 被推向 0，而不是推向负。基线 cold 仍有 65/86 `recall_citations>0`、54 个 `mechanism=ok`，是因为 cold 也必须等到 offer。 |
| leak 计数 | `@task` 交接不算 leak | Memory 除 offer 外全算 leak | 只改 mechanism 标签，不直接改 LCB。LSK 成功集约 90% 仍 `leakc≥1`。 |
| mechanism | 有最终消息 → 先 `no_offer`；无最终消息才 `leak`/`timeout` | 先 leak，再 no_offer | LSK 的 `citations=0` / `no_offer` **不能**读成「没检索」。PCM 冒烟已是 16 条 exploration citation、0 offer（`REPORT.md` 107 行）。evo-lsk1 日志还没有 `explore_cites=`（事后才加）。 |
| reminder | `MEMORY_HANDOFF` 命令 Memory 做 `memory_offer` + `@task` | 只提醒任务 agent 贴代码块 | LSK 两臂都多一段协作契约；不制造 warm 相对 cold 的不对称。 |
| 蒸馏 drain | 仅 warm：`admitQuietChannel` + `sweepMemoryDistillation`（`ingest.ts`） | 仅 warm：OV drain | 这是 warm 臂唯一「应该」有的处理效应。LSK 上它停在 artifact，没有 offer。 |

### 2.3 cold 臂是否与基线等价

**结构等价，机制不等价。**

两边 cold 都是：只跑 `split=test`，每集新 workspace，不 drain，跑完 destroy（LSK `run.ts` 269–278 行；基线 283–291 行）。LSK cold 脚本注释也写明 fresh workspace（`eval/bin/lsk-evo-cold.sh` 2–3 行）。

仍启用 `enableEvalGroupMemory` + 蒸馏模型配置，但无累积、substrate 空。**不是**「关掉 Memory、只留任务 agent」。基线 cold 同样是双 agent + OV 空账号。

不等价点（都会让跨分支 gain **不可比**，但不让 LSK 自己的 warm−cold 变成「冷臂更强的记忆」）：

1. LSK settle 不等 offer → 两臂都提前收口；基线 cold 反而 citation 最多。
2. 工具面不同：`memory-explorer` vs `openviking` fence。
3. LSK leak/`@task` 豁免、mechanism 口径不同。
4. 正在跑的 LSK cold 加载的是**改 reminder/keepWorkspace 之前**的模块（`REPORT.md` 117 行）；与已写完的 evo-lsk1 warm 同一套旧收口，二者内部可比。

---

## 3. 统计层

复算配对 80（manifest test ∩ 两边已有 grade）：

- warm 52/80 = 65.0%，cold 54/80 = 67.5%，gain **−2.5pp**
- 7 / 9 / 45 / 19
- 无最终消息：warm 16，cold 14（和 success 66 vs 66 的差一致：64 vs 66 有输出）

**Bootstrap**（对 80 对有放回，B=20000，配对差均值）：

- LSK gain 均值 ≈ −2.4pp，**95% CI [−12.5pp, +7.5pp]**
- 16 次 discordant 上 McNemar 精确双侧（7 vs 9）**p ≈ 0.80**

基线 test 全集 n=86：53/86=61.6% vs 47/86=54.7%，**+7.0pp**，10/4/43/29（与用户一致）。同一 80 题子集上基线是 53/80 vs 47/80 = **+7.5pp**（10/4）。

- 基线 gain 95% CI **[−1.2pp, +15.1pp]**（刚擦到 0）
- McNemar（10 vs 4 / 14）**p ≈ 0.18**
- 独立 bootstrap：LSK_gain − BASE_gain 均值 ≈ −9.5pp，**95% CI [−22.7pp, +3.7pp]**，覆盖 0

**不能说「LSK 相对基线少了 9.5pp 已超出噪声」。** 也不能说 LSK 的 −2.5pp 显著为负。剩余 6 题是 ARC 尾部，点估计还会动。

翻转清单（便于编排者转述）：

**warm 独胜 7：** `abc320_a`, `abc325_e`, `abc335_c`（唯一双方都抽出代码、cold 0/1）, `abc372_f`（cold leak+timeout）, `abc379_b`, `arc186_c`（cold leak；warm 丢掉错 handoff）, `arc186_d`（cold leak）

**cold 独胜 9：** `abc327_d` / `abc361_f` / `abc376_g`（warm leak+timeout）；`abc328_b`, `abc358_a`, `abc365_a`, `abc387_b`, `abc394_a`, `abc400_b`（warm 最后一条 ACK / 无代码）

把 16 次翻转拆开：ACK/抽不出代码净贡献 cold +3；leak/timeout 3 对 3；代码对错净 warm +1。**−2 题 / 80 = −2.5pp，账能对上。**

绝对水平上 LSK warm 52/80 与基线 warm 53/80 几乎一样；LSK cold 54 高于基线 cold 47。负增益主要是 **LSK cold 比基线 cold 高、LSK warm 没再高上去**，不是 LSK warm 崩了（全集 test warm 54/86=62.8% vs 基线 53/86=61.6%）。

基线机制也 internally 不干净：warm test `cited` 仅 24、`empty` 62；cold 反而 `cited` 65。基线 +7pp **同样不能**读成「warm 召回更多所以赢」。跨分支比 gain，混的是后端（Group Memory vs OV）+ settle 契约 + 模型工具，不是单一处理效应。

---

## 4. 结论：解释排序，以及还缺什么才能测到 loop

### 4.1 负增益最可能的解释（强→弱）

1. **这次 warm−cold 测的不是 LearnedSkill 效用（产品缺陷 + 评测契约）。** 蒸馏发生了，投递没有发生。任务 agent 最多收到无 provenance 的频道闲聊。把 −2.5pp 解释成「loop 有害」或「loop 无效」都过界——**消费端没接通**。证据：offer=0、citations=0、站立指令 vs `@memory`、settle 不等 offer。`CONSENSUS.md` 叙述 #18 / 决策 #27、叙述 #53 / 决策 #61。
2. **Harms 主要来自 harness 收口，不是记忆内容。** 最后一条 ACK 覆盖代码，净让 warm 少过 3 题；再叠加对称的 leak/timeout。这是移植后 settle「有任务消息就收」+ 任务 agent 爱回执的交互。证据：翻转表、`code_source=none`、`eval-qa.ts` 取 `taskMessages.at(-1)`。
3. **采样噪声。** −2.5pp 的 CI 很宽；与基线 +7pp 之差也不显著。n=80 部分配对、16 次翻转，任何再解读都要等 cold 跑完 86。
4. **累积干扰存在，但是次要。** 错题 handoff（`arc186_c`）、共享 `work_dir` 82 个 `.py`、后段 leak 升高（与 test 难度混杂）。它们证明 warm 臂不干净，但在翻转账里不是主项。
5. **「基线按 family 分 workspace、LSK 合成一个」不是 Evo 上的真实差异。** 两边都是 `code_implementation` 单 family。若拿官方题簇（208 stem）当 family，那是**两边都没做**的设计债，不能用来解释 LSK 相对基线的 gain 差。

### 4.2 要让本分支评测评到 LearnedSkill loop，还缺什么

对照 CONSENSUS（编号以**叙述条**为准，决策总账粒度不同）：

**叙述 #53 / 决策 #61（Memory Hint 定向投递）——当前评测的缺口，优先级最高**

设计：Memory 经 `memory@target_agent` 发 Hint；任务 agent 对每条已处理 Hint 出 `MemoryDisposition(adopt|reject|defer)`；超时无回执只算 exposure。

现状：只有 `memory_offer` 工具 + delivery 表；Evo 全量 0 行；没有 Hint / Disposition 状态机（LSK worktree 无 `EvaluationOrchestrator` / `MemoryDisposition` / 字面 `memory@`）。频道 `@task` 不是这条契约。

要接上至少需要：

1. **投递不能只靠模型在「被 @memory 提问」时自觉改选 `memory_offer`。** 现在站立指令明确把提问路径赶到频道。可选（评测侧，不必先改产品）：harness 在蒸馏后**确定性** `publishMemoryOffer`（demo 已证明表通）；或改评测提问，使 Memory 处于「队友没问」分支；或改站立指令让定向提问也必须 offer。evo-lsk1 不要为抬 offer 率重跑（`NEXT.md` 48 行）。
2. **reminder 带上 `conversation_id` / `target_agent_id`**（已写入后续进程，未进入 evo-lsk1 / 当前 cold）。
3. **settle 必须等到 offer 或明确的「memory 声明无物」**，否则任务先贴代码就会关掉 offer 窗口。同时 **final_output 应取最后一条含代码块的任务消息**，不要取 ACK。否则一接通 offer，ACK 覆盖会更严重。
4. **机制指标分开记：** `memory_offer_deliveries`、`memory_exploration_citations`、频道 `@task` 交接、Disposition。evo 的 `citations=0` 现在只表示「没有 offer 行」。

**叙述 #18 / 决策 #27（权威提交触发评估编排）——另一条 OV fork-node 线，本分支 Evo 路径上未接线**

设计：fork 权威提交成功后，daemon 七步 replay，ineligible 走 guidance；evaluator 只审 proposal。

现状：Evo harness 是 `runEpisode` → `drainEpisodeToMemory`（quiet-window ingest + distill）。没有 fork 提交、没有 replay 判定、没有 EvaluationOrchestrator（叙述 #58 / 决策 #65 的 Memory→Diagnosis→Memory 状态机也没有）。`REPORT.md` 116 行：OV fork-node（S1–S15）停在库级。

**不要用 #18 解释 offer=0，也不要用「接线 #18」当作让 Evo gain 转正的下一步。** 要测的是 LearnedSkill loop（ingest→distill→insight/skill→**投递**→shadow gate），不是 fork 评估编排。#18 要另开 OV 路径评测。

**审计与隔离（harness，已部分补）**

- 保留 warm workspace + `group-memory-snapshot`（事后已改；evo-lsk1 的 63/1/0 无法再 SQL）。
- 日志 `explore_cites=`（事后已改）。
- warm 即使共用记忆，任务沙箱也应每集隔离，避免 82 个 `.py` 残留。
- 若要对齐「官方 family」，应把 stem/题簇写进 `family_id`，而不是继续用 domain；这是新实验，不是对 evo-lsk1 的补丁。

**一句话给编排者**

LSK 的 −2.5pp 最合理的读法是：**消费端没接通，分数差是 ACK/leak 伪影加噪声；不要写成「LearnedSkill 负增益」。** 基线 +7.0pp 也不能当「OV 记忆有效、LSK 无效」的对照——两边 family 粒度相同，settle/citation 契约不同，且基线自己的 warm citation 比 cold 更少。要测 loop，先让 Hint/offer 真的到达任务 agent 并被 Disposition 记账，再谈 warm−cold。