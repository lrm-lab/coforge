# coforge 群聊多 agent 协作评测 · 两次跑统一报告

日期：2026-09-28 ｜ 同机并行两套隔离栈，本报告把两次跑放进同一文档、严格分列（§A 第 1 次 / §B 第 2 次），§C 同口径对照。

---

## 0. 两次跑的区分（栈对照）

| 维度 | 第 1 次（基线，§A） | 第 2 次（grill / lsk，§B） |
|---|---|---|
| 评测对象 | coforge `feat/ov-cm-implementation` @ `98d24e64`（CM 移除重构线） | coforge `feat/learned-skill` @ `4a7f2890`（LearnedSkill loop、memory sweeps RPC、fenced memory-explorer、memory-first 站立指令、offer op） |
| worktree | `.worktrees/cursor-ov-cm-impl`（22 个未提交文件：harness + workspace-memory 产品修复） | `.worktrees/cursor-lsk-eval`（detached，仅 5 处接线改动，快照 `eval/uncommitted-coforge-lsk.patch`） |
| **记忆后端（本质差异）** | **OpenViking prototype 容器 @1933**：per-workspace 一次性账号（keys→`/tmp/pcm-eval-ov-keys.json`），memory agent 走 fence + `ov_*` 检索，预算 3 读 + 1 offer、失败不退还 | **应用内 group-memory substrate**：无任何 OV 进程；ingest→蒸馏→insight/skill 工件→proposer→offer→shadow gate；工具面 fenced memory-explorer（`memory_start/explore/redirect/submit/offer`）；OV 仓库只读不在评测路径 |
| harness 契约 | 原始契约：settle 等 offer、final_output 取最后一条任务消息（会吃 ACK）、mechanism/citation 记 offer 与 OV 引用 | A1-A4+B 修复（对基线 202 行 diff，自 09-27 SLB 起生效）：final_output 取最后一条含代码围栏消息（ACK 不取）、settle=offer ∨ memory 明示无物 ∨ 任务安静、每集沙箱隔离、机制分列（offer/exploration/@task）、`COFORGE_EVAL_LOOP_OFFER=1` 蒸馏后确定性 `publishMemoryOffer`（`lsk-loop-offer-*`，cold 不投递） |
| 基础设施 | 共享 postgres `coforge`；redis 16379 DB0；web 18888；centrifugo @18000；OV @1933；sidecar 8732(SLB)/8733(SF) | 独立库 `coforge_lsk_eval`（86 迁移，不碰共享库）；同 redis DB1/DB2；web 18889；centrifugo-lsk @18001（cpuset 2-3）；**无 OV**；sidecar 8734(SLB)/8735(SF) |
| 脚本 / eval id | `/tmp` 散置（evol-shard.sh、sb-lane.sh…）；`*-collab-1` | 固化 `skill-node-design-grill/eval/bin/lsk-*.sh` + `eval/REPRO.md`（manifest sha256）；`*-lsk1`、workspace 前缀 `lsk-` |
| 模型 / manifest / 判分 | lenovo-deepseek-v4-flash/DeepSeek；五个 manifest；`/tmp/evo-grading-0909` 09-09 冻结 LCB 判分 | **完全相同**（manifest sha256 录于其 REPRO.md）→ §C 可比 |

> 跨线注意：两线 `mechanism`/`citation`/`leak` 字段**语义不同**（基线记 OV offer/citation；lsk 只认 `memory_offer_deliveries` 行、leak 旧规则把交接消息计入），机制面数字不可直接横比；可比的是官方判分（LCB / sidecar verifier）与全集通过率。

---

## A. 第 1 次跑（基线 = ov-cm-impl + OpenViking prototype）

### A.1 链路
```
用户 @memory → Memory Agent（ov_* fence，3 读+1 offer 预算，失败不退）
  → 引用式 Memory Offer（@task）→ Task Agent（仅 bash，无预装 skill）→ 频道回复
频道消息 → 静默窗 → Admission → OV 沉淀（warm 跨集累积）
```
warm=每 family 一个 workspace（频道+OV 累积）；cold=每集全新 workspace+全新 OV 账号。

### A.2 总览

| 基准 | 进度 | headline | warm−cold 增益 |
|---|---|---|---|
| LoCoMo（1540 题） | ✅ | **acc 88.8%**（加权 89.0%），0 泄漏 | —（单臂） |
| EvoAgentBench（354 集，官方判分） | ✅ | warm **61.6%** vs cold 54.7% | **+7.0pp**（10胜/4负） |
| SkillLearnBench（171 集） | ✅ | 两臂均 59.4%，0 不一致对 | **0**（零效应） |
| SkillFlow（164 集/臂） | 🔄 cold 剩 ~51 | paired n=109：warm **79.8%** vs cold 74.3% | **+5.5pp**（11胜/5负） |
| SkillsBench（86 任务） | 🔄 77/86 | passed **31.2%**，testScore 0.477 | —（单臂） |

### A.3 详情

**LoCoMo（完结）**：26 88.8% ｜ 30 86.4% ｜ 41 90.8%（重跑）｜ 42 89.4% ｜ 43 89.9% ｜ 44 89.4%（重跑）｜ 47 86.7% ｜ 48 89.0% ｜ 49 85.3% ｜ 50 92.4%。均值 88.8%、加权 89.0%（1370/1540），UNJUDGED 清零，citation 均值 1.87，泄漏 0。离线宽松口径补判普遍上修（conv-43 77.0→89.9）。

**EvoAgentBench（完结+官方判分）**：全集口径（失败/无代码记 0）配对 test n=86——warm 61.6%（53/86）、cold 54.7%（47/86），**+7.0pp**；win/loss 10/4/43双过/29双败；warm:train 92.9%（169/182）。graded-only 两臂均 85.5%（n=62/55）——**增益来自 warm 更多集走到完整解题**（62 vs 55）加 10:4 翻盘。官方对照：归档 +0.081、官方复跑 +0.025。泄漏 0。CI（lsk 线计算）：[−1.2pp, +15.1pp]，McNemar p≈0.18。

**SkillLearnBench（完结）**：配对双判 n=64 两臂均 59.4%、**64/64 逐题一致 → 零效应**；"warm 49% vs cold 62%"破案为覆盖面偏倚。行为学实验排除 sidecar verdict 缓存污染。cold citation 2.33 引的是 OV 新账号自动 abstract 样板。5 family 两臂全 0（难度门控）。泄漏 2/171。

**SkillFlow（97%）**：warm 158 判 pass 75.9%、cold 114 判 75.4%；**配对 n=109 warm 79.8% vs cold 74.3%，+5.5pp**（11/5/76/17），方向同官方（Opus +8.4pp）。泄漏 1/278。

**SkillsBench（77/86）**：citation 均值 2.51、零引用任务 0（**取用链路每次都工作**）；passed 24/77=31.2%，testScore 0.477；机制 ok 50（pass 18）/no_reply 19/**leak 8**。

### A.4 机制面（基线口径）

no_offer：LoCoMo 0.5% ｜ evo warm **49.6%** / cold 24.4% ｜ SLB 8%/0% ｜ SF 20%/18% ｜ sb 0%。**最大杠杆=evo warm no_offer 49.6%**（字符串参数/编造 operationId 烧预算 + 失败不退还）。

### A.5 运行事件与数据完整性
1. **OV prototype unhealthy 两天（09-25 晚～09-28 01:41）拖停基线跑批**：容器 01:41 重启后恢复。切片核查（追加序=时间序）：病窗 no_offer 23% vs 病前 13%、判分覆盖 159/162、error 无异常 → **只损进度未污染数据**。09-28 02:43 全部重启（resume 生效）+ `mine-watch` 自愈看门狗（按 `/proc/environ` 识别本线，不碰 lsk 栈）。
2. 已修复事故：sb lane 未传 `COFORGE_EVAL_TASKS`（2 天重复跑 3d-scan-calc）；sfcold 缺 sidecar env（109 污染行剔除重跑）；evo cold 分片竞态（38 重复行去重）。
3. 产品修复（未 commit，22 文件）：多 agent fence 403（env 串台→session closure）、reset-session 丢 fence、OV keys 统一、参数 coerce。遗留：预算不退还；task agent 可读宿主文件（bwrap 待做）。

---

## B. 第 2 次跑（lsk = feat/learned-skill + 应用内 group-memory substrate）

> 本节数字来自该线自己的产物（`eval/REPORT.md`、`eval/evo-lsk-negative-gain-analysis.md`、`eval/PROGRESS.md`）；cold 判分与 86 题最终配对表为本次补算（同一冻结判分环境）。

### B.1 EvoAgentBench 全量（唯一已完成的基准）

warm 268/268（09-27 00:37Z 写完）+ cold 86/86，同冻结 LCB 判分。**全集口径（无最终消息/抽不出代码记 0）**：

| 口径 | warm | cold |
|---|---|---|
| test 86（最终） | **54/86 = 62.8%** | **55/86 = 64.0%** |
| train 182 | 156/182 = 85.7% | — |
| graded-only test | 54/66 = 81.8% | 55/67 = 82.1% |

**配对 gain = −1.2pp**；win/loss：warm 独胜 9 / cold 独胜 10 / 双过 45 / 双败 22。（其中间分析在 80 题时为 −2.5pp；bootstrap 95% CI [−12.5pp, +7.5pp]，McNemar p≈0.80。）

**负增益破案（其分析）**：19 次翻转里几乎全是交卷/收口伪影——6 次 warm 已写出可判代码后补 ACK、旧规则取最后一条消息致 LCB 抽不出代码；3+3 次双方 leak/timeout 未交卷；**真正的代码对错翻转仅 1 题（abc335_c）**。跨题污染直接证据：`arc186_c`（Memory 把别的题的蒸馏内容递过来，任务 agent 丢弃后仍判对）。

### B.2 offer=0 根因（该线最重要发现）

- **结构化投递闭环全量为 0**：`memory_offer_deliveries` 0/268，shadow gate 空转（它是 LLM-free 事后扫描，不发布不拦截）。warm 实际测到的链路=「入库→蒸馏→**63 insights / 1 skill**→频道 `@task` 交接」，没测到「模型 `memory_offer`→任务 agent 收带 provenance 的 offer→shadow gate 记分」。
- 根因是**产品站立指令与 harness 定向提问错配**：站立指令规定"有人问了→频道回答；队友没问才 `memory_offer`"，而 harness 每集都是 `@memory` 定向提问 → 模型走频道路径。且 `memory_offer` 需要 conversation_id/target_agent_id/已存在 insight UUID（当时 reminder 未注入），比 `@task` 难用一个数量级。
- 09-27 起契约 B 补了确定性 `publishEvalLoopOffer`（SLB 起生效），并给 reminder 注入两个 UUID——**evo-lsk1 不重跑，口径不变**。
- 蒸馏真实发生（268 distilled / 63 insights / 1 skill）；但 warm workspace 在 family 结束后被 harness 删除，substrate 无法 SQL 复核（已修：保留 + `group-memory-snapshot`）。

### B.3 其余基准
LoCoMo 仅 1 题冒烟（conv-26，判 WRONG——证据在未入库的早期 session）；SLB/SF/SkillsBench/LongMemEval **尚未跑全量**（sidecar 8734/8735 就绪，契约 A1-A4+B 已就位）。

---

## C. 两线同口径对照（EvoAgentBench，同 manifest/模型/判分）

| | 基线（OV prototype） | lsk（group-memory） |
|---|---|---|
| warm:test（全集） | 61.6%（53/86） | 62.8%（54/86） |
| cold:test（全集） | 54.7%（47/86） | **64.0%**（55/86） |
| **warm−cold gain** | **+7.0pp**（10胜/4负） | **−1.2pp**（9胜/10负） |
| gain 95% CI | [−1.2, +15.1]（p≈0.18） | [−12.5, +7.5]（p≈0.80） |
| warm:train | 92.9% | 85.7% |
| graded-only test | 85.5% / 85.5% | 81.8% / 82.1% |
| 泄漏（各自口径） | 0 | warm test 16 / cold 16（旧 leak 规则，含交接消息） |

读法：
1. **两线 warm 臂几乎同分**（61.6% vs 62.8%）——不同记忆后端在 evo 上对"有记忆"的表现相近。
2. **差异集中在 cold 臂**（54.7% vs 64.0%）：两线的"cold"定义不同——基线 cold=新 OV 账号+fence 预算（有自动 abstract 干扰 + 24.4% no_offer）；lsk cold=空 substrate 上探索（检索在动、找不到东西、不烧预算）。**基线的 +7.0pp 有相当部分来自 cold 臂自身损耗**（no_offer 24.4% + no_reply 12.8%），lsk 的 cold 更"干净地弱"。
3. **统计上两线 gain 差异不显著**（两 CI 均跨 0，gain 之差的 CI 也跨 0）。方向差异真实存在但样本量不足以判死。
4. 基线 warm 的 no_offer 49.6% 与 lsk 的 offer=0 是**同类问题的两种表现**：记忆侧"交不出来"的损耗都在 warm 臂，只是形态不同（预算烧尽 vs 走错投递路径）。

---

## D. 综合结论

1. **基线栈（OV 外挂记忆）**：evo +7.0pp、SF +5.5pp、LoCoMo 89%、双基准零泄漏——链路成立但增益部分来自 cold 臂损耗；SLB 零效应是真结论；最大杠杆是 warm no_offer 49.6%。
2. **lsk 栈（learned-skill 底座）**：evo 配对 −1.2pp（伪影占翻转大头，真翻转 1 题）；蒸馏/insight 真实产出但**消费闭环（offer→provenance→shadow gate）未被测到**，offer=0 是产品指令与 harness 提问方式错配，已在契约 B 修复（SLB 起生效，待全量验证）。
3. **共同教训**：两条线的失败模式都指向"记忆供给侧交不出来"（预算烧尽 / 投递路径错配），而不是"记忆有害"。
4. 待办：基线 SF 剩 ~51 cold 集、sb 剩 9 任务收尾；lsk 侧 SLB/SF/sb/lme/LoCoMo 全量未跑（契约已就位）；两线代码与产品修复均未 commit。
