# 任务简报：在 feat/learned-skill 分支上用五个基准评测 LearnedSkill loop（skill-node-design-grill）

> 你（cursor agent）全权执行本任务。编排者（ZCode）只读进度并向用户同步，不会替你执行。
> 本简报自包含：读完本文件 + 「必读文档」后直接开工，不要等待进一步指示。
> 每完成一个阶段，在 `eval/PROGRESS.md` 追加一行：`YYYY-MM-DDTHH:MM:SSZ | 阶段 | 一句话结论`。

## 0. 目标

在 coforge 仓库 `feat/learned-skill` 分支（+ OpenViking `feat/fork-node-foundation` 侧地基）上，把已有的五个群聊多 agent 协作基准跑通并出对照结果，评测该分支新增/修改的功能（核心是 LearnedSkill loop：group memory substrate、distillation、skill artifacts/proposals、exploration、offers、shadow gate，以及 fenced memory-explorer runtime / memory API wire / memory sweeps RPC）。

五个基准（ harness 全部在 worktree `/home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl/benchmark/` 下，**未提交**）：

| 基准 | harness 目录 | 基线参照（跑在另一分支上，仅作参考，不是对照） |
|---|---|---|
| LoCoMo 群聊 QA | `benchmark/public-channel-memory/`（LoCoMo 部分）+ longmemeval-collab | 10 样本均值 ~85% |
| EvoAgentBench | `benchmark/evolbench-collab/`（manifest `evol_bench/EvoAgentBench/data/evo-code-implementation.jsonl`） | warm 61.6% vs cold 54.7%（+7.0pp，n=86 配对） |
| SkillLearnBench | 同上 runner，manifest `evol_bench/SkillLearnBench/data/slb-full.jsonl` | 配对集零效应 |
| SkillFlow | 同上 runner，manifest `benchmark/evolbench-collab/data/skillflow.jsonl` | warm 11 胜 0 负（配对） |
| SkillsBench | `benchmark/skillsbench-collab/` | 跑批中 |

对照设计：**在本分支内自建 warm/cold 对照**（与 harness 的 arms 设计一致），不要拿基线参照做跨分支比较。

## 1. 必读文档（按序）

1. `/home/zhoujie22/river2_0/skill-node-design-grill/CONSENSUS.md` — 设计共识（85 条决策；重点：#18 评估编排、#28-40 Round 9 Memory/Diagnosis 共享检索、#53-60 Hint/Disposition/引用强度/评测状态机、#72-85 Round 10）。
2. `/home/zhoujie22/river2_0/skill-node-design-grill/impl/HANDOFF.md` — 实施交接（OV 侧 S1-S15+F1/F2 全是**库级**实现：无 HTTP 路由/daemon/viking:// 命名空间；已知限制第 4/5 条说明评估编排未接线）。
3. coforge `feat/learned-skill` 的关键提交：`5b5e9ecd`（LearnedSkill loop 主体）、`1692ca19`（memory sweeps 接 RPC hook + architecture.md 文档）、`07cd99af`（fenced memory-explorer runtime + memory API wire）、`60810201`（agent-facing offer op）、`7b2e4d42`（memory-first standing instructions）。读 `apps/web/src/server/group-memory/` 全目录 + `apps/web/architecture.md` 相应章节。
4. `/home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl/benchmark/public-channel-memory/HANDOFF.md` — 评测侧已挖出的全部产品/接线坑（多 agent fence 403、session env 覆盖、OV keys 文件、managed reset 丢 fence 等 8 项根因，**你大概率会全部重新遇到**）。
5. 本文件附录 A（跑批操作手册要点）。

## 2. 分支/仓库现状（已核实，直接采信）

- coforge 主克隆 `/home/zhoujie22/river2_0/coforge` 在 `feat/learned-skill`（勿动它的工作区）。
- worktree `/home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl` 在 `feat/ov-cm-implementation`，与 learned-skill 已分叉：learned-skill 领先 18 个提交（LearnedSkill loop 等），ov-cm-impl 领先 47 个（后来删掉 Causal Memory 的重构 b2d78698/643b9c4a/f891f8e5）。**两分支的 memory 栈不同**。
- 五个基准 harness + 配套产品修复全部**未提交**在 ov-cm-impl worktree 上。`packages/agent/src/runner.ts` 里有两处未提交修复必须随 harness 一起移植（见附录 A.1）。
- OpenViking 仓库 `/home/zhoujie22/river2_0/OpenViking` 在 `feat/fork-node-foundation`（库级，无行为面）。**评测不改 OV 仓库**；若发现非要改 OV 才能评测，停下来写进 PROGRESS.md 等人拍板。

## 3. 工程步骤

### 3.1 独立环境（最高优先级 —— 正在跑的基线评测共用这套基础设施）

机器上**正在运行**另一分支的跑批（web 18888、OV 本地 1933、OV prototype 容器、sidecar 8732/8733、共享 postgres 的 coforge 库、redis 16379）。你必须完全隔离：

1. **新 worktree**：`git -C /home/zhoujie22/river2_0/coforge worktree add /home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval feat/learned-skill`。
2. **移植 harness**：从 ov-cm-impl worktree 复制 `benchmark/`（整个目录，未提交）+ `packages/agent/src/runner.ts` 的两处修复（diff 对比后以 patch 方式打上；learned-skill 的 runner.ts 基线不同，手工合入 `localProxyUrl/proxyContextToken/postLocalProxy` session-env 闭包与 `coerceNumericToolParams`）。API 有漂移就修 harness，**不要改 learned-skill 的产品行为**（除非是让评测能跑的接线，需在 PROGRESS.md 记录每一处）。
3. **独立数据库**：learned-skill 带 500+ 行 schema 迁移，**绝不**对共享 `coforge` 库跑迁移（会毁掉正在跑的评测）。在同一 postgres 实例 `createdb coforge_lsk_eval`，然后 `DATABASE_URL` 指向它跑 `prisma migrate deploy`（或 `prisma db push`，以 learned-skill 的迁移目录为准）。
4. **独立 redis**：用同一实例的不同 DB 号（如 `/1`），确认应用支持；不行就 docker 起一个独立 redis。
5. **独立端口**：web（**必须 bun 起**，node 无法 import 'bun'）如 18889；centrifugo 如 8790（如果应用需要自己的 centrifugo，评估后决定，绝不动 8789）；OV 本地服务如 1934（若需要独立 OV 实例）；sidecar 8734/8735。
6. **OV prototype 容器**：评估 learned-skill 的 group-memory 是否依赖 OV prototype；若依赖，起**新的** OV 容器（`--cpuset-cpus` 至少留 0-1 给现有容器；docker build 需要代理 build-arg，见附录 A.6）。OV 账号 key 文件：**所有评测必须写 `/tmp/pcm-eval-ov-keys.json`**（web 应用读它做 resolveAuthorization，两分支共用该文件是安全的——按 accountId 隔离）。
7. **workspace slug/评测 id 前缀**：全部用 `lsk-` 前缀（如 `lsk-collab-*`、eval id `*-lsk1`），result 目录放 `benchmark/*-collab/result/` 下但 eval id 带后缀。

### 3.2 摸清 LearnedSkill loop 的激活面（先于任何跑批）

回答并记入报告：loop 在 workspace 级怎么开（`workspace-model-configuration.server.ts`、shadow gate 的判定）？评测 harness 建的 workspace 需要哪些配置行才能让 loop 参与（ingestion→distillation→artifacts→proposer→offers）？产出哪些可观测行（表/日志）？loop 是否与 memory agent 的 ov_* fence 检索并行共存、还是取代？——这些答案决定 warm 臂里 loop 是否真的在工作，**跑批前必须能用一个手工 workspace 演示 loop 的完整链路**（消息进来→substrate 入库→（可选）distillation 产出→offer 出现）。

### 3.3 五个基准：smoke → 全量

每个基准先 1-3 集 smoke（判定机制指标：memory offer 发生、citation>0、任务 agent 收到 offer、判分链路通），全部通过后起全量。跑批模式沿用 harness 已有的：evolbench 系（evo/SLB/SF）用 `/tmp/evol-shard.sh` 模式（families/mod 分片 + patient watchdog + resume）；skillsbench 用 lane 模式（`COFORGE_EVAL_TASKS` 必传！）；LoCoMo 用 marathon。附录 A 有坑清单。资源与在跑的基线评测共享——先 `pgrep -af 'collab/src'` 看负载，全量批次错峰上（基线预计 1-2 天内排空）。

### 3.4 可复现性交付（用户点名要求）

出一份 `eval/REPRO.md`：两仓 git SHA + 未提交 diff 快照（`git -C ... rev-parse HEAD`、`diff > eval/uncommitted-<repo>.patch`）；数据库/迁移版本；manifest 路径与 sha256；eval id/seed 约定；sidecar 镜像 id；模型端点名（**不写 key**）；每个基准的重跑命令（自包含脚本，不依赖 /tmp 里现存的脚本——把它们复制进 `eval/bin/`）。结果文件（attempts/graded/report）路径清单。

### 3.5 最终报告

`eval/REPORT.md`：五基准 warm/cold 配对结果 + 机制指标（offer 率/citation/no_reply/leak）+ LearnedSkill loop 参与度证据（表行数/日志摘录）+ 与 CONSENSUS 设计预期的差距 + 未被评测覆盖的设计面（如 OV fork-node 库级部分）。

## 4. 硬约束

1. **不 commit、不 push**（任何仓库）；改动留在工作区。
2. **不碰在跑的评测**：不 pkill 宽模式（多个同名 runner 并存）；不用共享库跑迁移；不动 18888/1933/8789/8732/8733/`coforge-openviking-prototype-1`；删 workspace 行只能带 `lsk-` 前缀的 LIKE。
3. **密钥纪律**：`/tmp/pcm-cursor-api-key.env`、`/tmp/pcm-eval-ov-keys.json`、`~/.pi/agent/models.json`、两仓 .env 里的密钥**永不**进日志/报告/argv（source 进环境用）。
4. OpenViking 仓库只读；coforge 主克隆工作区只读（要改就改新 worktree）。
5. 产品行为问题（fence 丢预算、budget 不退还等已知问题）记录进报告，不顺手改产品代码——除非是附录 A.1 列出的、已确认必要的两处 runner.ts 修复移植。
6. 遇到必须人拍板的分叉（如必须改 OV、必须动共享设施），写 `eval/BLOCKED.md` 并继续做其他不依赖该决定的部分。

## 附录 A：跑批操作手册要点（全部是踩过的坑）

### A.1 必须移植的 runner.ts 修复
`localProxyUrl(path, env?)` / `proxyContextToken(env?)` / `postLocalProxy`：从 **session env** 读 endpoint/token 回落 Bun.env（Pi session 跑在 Daemon 进程内，第二个 agent 启动会覆写 `Bun.env.COFORGE_AGENT_CONTEXT` → fence 403）；`createSession` 把 `defaultMemoryProxy(environment)` 传给 `createMemoryFenceTools`。`coerceNumericToolParams`：模型常发字符串 limit/"5"、裸 `viking://` URI，需在 client 侧矫正。

### A.2 fence/链路
fence 随 AgentStart intent 走（managed reset-session 会重建无 fence intent → 会话内绝不用 reset-session，用 stop→清 currentSessionId→startAgent(memory,fence)→startAgent(task)）；warm 臂闭包：每集 stop 两 agent→currentSessionId=null→fenced 重启。频道消息 @mention 生成 deliveries 精确唤醒。quiet-window 入库（harness 用 5s quietAfterMs；产品默认 15min）。OV 账号 `provisionDisposableAccount` per workspace；keys 一律写 `/tmp/pcm-eval-ov-keys.json`。

### A.3 evolbench 系
manifest 行 schema `{benchmark, episode_id, task_id, family_id, split, role, order, turns[0].prompt, grader{kind,...}, stage_files}`；attempts 按 run_id `${evaluationId}:${episodeId}:${seed}:${arm}` resume 去重（O_APPEND 并发安全；重复行最后一条为准）；warm=每 family 一个 workspace 顺序累积，cold=每集全新 workspace+账号。sidecar（`evol_bench/SkillsBench/code/skillsbench_env_server.py`）**必须**同时传 `COFORGE_EVAL_ENV_NOTE`（含 %TASK_ID%/%EPISODE_ID% 替换的 bind/execute 指令）和 `COFORGE_EVAL_VERIFY_SIDECAR`——漏传会产生无验证的废行（已发生过一次，109 行全废）。docker build 需 `--build-arg http_proxy/https_proxy/no_proxy`（host 代理 172.17.0.1:7893）。watchdog：静默阈值放宽到 15 分钟（provisioning 静默期长），用 setsid 进程组 + `kill -9 -- -PGID`。

### A.4 skillsbench
`COFORGE_EVAL_TASKS=<task>` 必传，否则只跑第一个任务（已发生过 89 次重复的事故）；lane 完成检测 grep `\"taskName\":\"$TASK\"`（JSON.stringify 无空格）；verify pytest 900s 超时；skill 入库后 `deleteMany` 频道行防 task agent 从频道历史翻出 skill。

### A.5 evo 离线判分（learned-skill 上复用）
09-09 冻结判分环境 `/tmp/evo-grading-0909/`（若失，按 `evol_bench/EvoAgentBench/REPRODUCE.md` §3 重建）：`PYTHONPATH=/tmp/evo-grading-0909 python3 -m memory_bench.grading --attempts <dedup.jsonl> --manifest <evo manifest> --lcb-python <lcb-venv>/bin/python --bridge /tmp/evo-grading-0909/graders/lcb_grade.py --output-dir <dir>`。attempts 先按 (arm, episode_id) 去重保最后。全集口径（failure/no-code 记 0）+ graded-only 口径都报。

### A.6 基础设施
web 必须 `bun node_modules/.bin/vite dev`（worktree `apps/web` 下）；OV prototype 容器 `--cpuset-cpus=0-1`；prisma 写后 `$disconnect` 挂起是已知问题（父脚本 grep 到 "wrote" 再 kill）；判定脚本超时 >900s 的任务 deadline 要 ≥4500s。

### A.7 模型
端点与 key 在 `~/.pi/agent/models.json`（lenovo-deepseek-v4-flash / DeepSeek-V4-Flash-0731）+ `/tmp/pcm-cursor-api-key.env`；CA bundle `~/.pi/lenovo-ca-bundle.pem`（NODE_EXTRA_CA_CERTS）。评测 provider/model 与基线保持同名同版本，保证可比。

## 附录 B：进度与产物路径约定

- 进度：`/home/zhoujie22/river2_0/skill-node-design-grill/eval/PROGRESS.md`（追加式）
- 阻塞：`.../eval/BLOCKED.md`；原始流：`.../eval/cursor-e2e-raw.log`
- 结果：各 harness `result/` 目录，eval id 后缀 `-lsk1`
- 报告：`.../eval/REPORT.md`、`.../eval/REPRO.md`

## 追加（2026-09-26T17:35Z 重派说明）

你是接续前一个会话的新会话：已完成的阶段以 `eval/PROGRESS.md` 为准，不要重做。特别地：
- `eval/bin/lsk-evo-warm.sh`（evo-lsk1 warm 全量）已在后台运行，**先看它的日志/attempts 进度再决定下一步，绝不重复启动**；它跑完 warm 后按简报继续 cold 臂与其余四个基准。
- 观测情报：今天 12:00–17:00Z 期间共享的 lenovo 模型端点被基线评测打满（QUOTA_EXCEEDED），基线侧已减压（只剩 2 个 shard）。你的 evo-lsk 运行全程 0 配额错误——保持你现有的模型端点配置；启动新的全量批次前先 `pgrep -af 'collab/src'` 评估当前负载并错峰。
- 前会话在 08:16Z 后进程消失（原因不明，产物完好）。若你完成本会话仍有余下工作，把剩余工作写成 `eval/NEXT.md` 供下一次接续。

## 追加（2026-09-27T05:55Z 第三次派发）

- 接续依据：`eval/NEXT.md`（上一个会话的交接）+ `eval/PROGRESS.md`。已发生：evo-lsk1 warm 268/268 完成并离线判分（test 全集 54/86=62.8%）；cold 已由 lsk-after-warm.sh 自动拉起，正在跑。
- **必查问题（优先级最高）**：warm 全量的机制统计显示 `offer deliveries 0` 且 `citations 0`——LearnedSkill loop 蒸馏出 63 insights / 1 skill，但没有任何 offer 投递到任务 agent。这直接决定评测是否真的覆盖了"修改的功能"。查清原因（shadow gate 默认拦截？offer 触发条件没满足？workspace 配置？），把结论和（如属 harness 配置问题的）修复写进 PROGRESS.md；若属产品设计使然（如 shadow gate 按 CONSENSUS #18 需要权威提交后才投递），在 REPORT.md 里明确说明 warm 臂实际测到的是什么。
- 基线侧情报：lenovo 端点昨夜起 ECONNRESET（sf3/sf4 已全停，探活脚本 /tmp/sf-endpoint-watch.sh 恢复后会自动重启基线 shard）。你的 lsk 运行一直 0 配额错误——继续用你现有端点配置；如果它其实是同一端点，注意错峰。

## 追加（2026-09-27T07:0Z 第四阶段指令）

- 负增益分析已完成并归档：`eval/evo-lsk-negative-gain-analysis.md`（结论：收口伪影+噪声+消费端未接通）。
- **下一阶段按 `eval/brief-comparison-protocol.md` 执行**（对照协议 v1：修测量→修投递→分臂→门槛→多 seed）。它优先级高于简报正文的剩余顺序；与其冲突时以协议为准。
- evo-lsk1 与 evo-lsk1-cold 跑完即归档为"修正前基线"，不重跑。

---

## 派发增补 4（2026-09-27 14:20Z）：用户指令 —— 现在开始 SLB（SkillLearnBench）

用户已下令启动 SLB。本增补优先级最高：高于简报正文剩余顺序，也高于对照协议 E 节「evo 归档/20 题试点」的前置。evo-lsk1 两臂已完结（warm 62.8% vs cold 64.0%），**不重跑、不归档重算**，挂起等用户。

已核实的 SLB 结构（编排者 14:00Z 查证，直接采信）：
- manifest `/home/zhoujie22/river2_0/evol_bench/SkillLearnBench/data/slb-full.jsonl`，95 集 = 19 个 skill family ×（1 train + 2~5 test），grader 全部 `skilllearnbench_verifier`。
- 基线参照（另一分支、不做跨分支比较）：`/home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl/benchmark/evolbench-collab/result/slb-full-collab-1-attempts.jsonl`，171 行 = warm 95（全 split 顺序累积）+ cold 76（仅 test、每集新 workspace），配对零效应——那正是「offer 只靠模型自觉」契约下的预期伪零，本增补就是修掉它再测。

执行顺序：
1. 先落对照协议 `eval/brief-comparison-protocol.md` 的 A1-A4 与 B 于 harness：A1 final_output 取任务 agent 最后一条**含代码块**的消息（不取 ACK）；A2 settle 三选一、两臂一致并写入 REPRO；A3 任务沙箱每集隔离；A4 机制指标分列记账（offer deliveries / exploration citations / 频道 @task 交接数）；B 蒸馏 drain 完成后 harness **确定性 `publishMemoryOffer`**（operationKey 前缀 `lsk-loop-offer-slb-`，reminder 带 conversation/target UUID）。每处改动记 PROGRESS.md 与 REPRO.md。不重跑 evo-lsk1。
2. smoke：挑 1 大 1 小两个 family，warm-loop 跑通 train + 前 2 个 test、cold 跑 2 集。门槛（协议 B 预注册，不达标该 run 作废）：warm 臂 offer 投递率 ≥80% episodes、两臂 final_output 代码抽出率差 ≤5pp、两臂 leak/timeout 率差 ≤10pp、判分链路通。不达标回第 1 步修，不进全量。
3. 全量：eval id `slb-lsk1`（warm-loop，95 集按 family 顺序累积；watchdog/resume 沿用 eval/bin/lsk-evo-warm.sh 模式，改 manifest/eval id）→ summary 后自动接 `slb-lsk1-cold`（76 集 test-only，沿用 lsk-after-warm 模式）。SLB verifier 若需容器/环境，沿用基线 harness 起法（docker build 代理参数见附录 A.3/A.6）。
4. seed：先 seed1 两臂全量出配对结果；协议 D 的 ×3 seeds 视基线排空与机器负载再排，决定写进 PROGRESS.md。
5. 判分+统计按协议 D：McNemar 精确 + bootstrap 95% CI（B=20000），全集/graded-only 两口径；**按 19 个 family 分层的 win/loss 也报**（SLB 的迁移语义在 family 粒度）。

环境与延续：
- 隔离栈已核实在线（web 18889 / centrifugo 18001 / coforge_lsk_eval / lsk-web-watch 60086）。
- 不动基线：18888/8789/1933/sidecar 8732-8733/共享 coforge 库/在跑 runner；全量与基线错峰。
- 上一会话（首发，PID 2290650）挂死 30h、已由编排者清理；本会话从本增补接续，PROGRESS.md 继续追加，不要重做 evo 已完成阶段。

---

## 派发增补 5（2026-09-28 01:50Z）：SLB smoke 门检结果 —— 修复 B 生效，但判分链路与任务交付失败，先诊断再重 smoke

上一会话 14:32Z 结束后，smoke-watch 独立跑完了 smoke（17:20Z），门检结果在 `eval/logs/slb-lsk1-smoke-gate.json`：**pass=false**。

已确认的事实（直接采信）：
- **B 修复生效**：warm 6/6 集投递率 100%（`memory_offer_deliveries=1`/集），pass_offer=true。确定性 publishMemoryOffer 链路通了。
- 三个失败面：
  1. `pass_sidecar=false`（sidecar_graded=false）：`sidecar-slb-8734.log` 0 字节——skilllearnbench_verifier 的判分链路根本没跑（环境服务器没起或没被调用）。
  2. 两臂 `code_extract_rate=0.0`（10/10 集）：A1「取最后一条含代码块消息」在 SLB 上抽出率为零——court-form-filling / fix-security-bug 的交付形态可能不是 ``` 围栏代码。对照 `skilllearnbench_verifier` 期望的 final_output 形态，确认 A1 对 SLB 是否语义错配，若是则按 verifier 契约取交付物（文件路径/JSON/纯文本答案），并把该取法写进 REPRO。
  3. 10/10 集 `mechanism=leak`、`succeeded=0`：任务 agent 全都没产出最终交付就收口了。查 smoke attempts 的 recall_state/消息数、settle 契约（A2 的 offer_or_memory_empty_or_task_quiet 是否提前收口）、环境绑定（ENV_NOTE/bind 是否像 SF 那样必传）与任务提示词。
- 温馨提示：smoke 的 attempts/summary 在 `.../result/lsk1-smoke/slb-lsk1-smoke-*`；gate 的口径代码在 `eval/bin/lsk-slb-gate.py`。把门检结果补记一行进 PROGRESS.md（watch 没写）。

任务（按序）：
1. 诊断上述三个失败面，修 harness（不碰产品；每处改动记 PROGRESS/REPRO）。
2. 重跑同两个 family 的 smoke，门槛仍按协议 B（offer ≥80%、代码抽出率差 ≤5pp——若改了抽取语义则两臂按新语义算、leak/timeout 差 ≤10pp、判分通）。不达标继续修，不进全量。
3. 门槛过了 → 起 `slb-lsk1` 全量（eval/bin/lsk-slb-warm.sh / lsk-slb-full.sh 已就位，watchdog/resume 模式）→ cold 接续 → 判分+按 19 family 分层配对（增补 4 第 5 条）。

环境变更（编排者 09-28 01:40Z 处理，与你无关但须知）：基线 OV prototype 容器 unhealthy 已重启恢复（1933 healthy），基线 SF runner 与 sb 3 条车道已恢复跑批。lsk 栈（18889/18001/coforge_lsk_eval）不变、在线。不要动基线（18888/1933/8789/sidecar 8732-8733/共享库/在跑 runner）。harness A1-A4+B 已落地且带回归用例，**不要重做**，只做本增补列出的修复。
