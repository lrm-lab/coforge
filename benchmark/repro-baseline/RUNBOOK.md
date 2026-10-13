# 基线线复现手册（2026-09-28/29 跑批）

本目录是报告 [`benchmark/EVALUATION-REPORT-COLLAB-2026-09-28.md`](../EVALUATION-REPORT-COLLAB-2026-09-28.md) **§A 基线线**的持久复现入口。

跑批当天的启动脚本原先只在 `/tmp`（重启即失），现按原样复制到 `bin/`（内容未改，只把 `as-grade-rest.sh` 补进来），并在 `MANIFESTS.sha256` 记录所有输入哈希。

lsk 线（§B）的复现入口在另一处，不在此目录：`/home/zhoujie22/river2_0/skill-node-design-grill/eval/REPRO.md` + `eval/bin/`。

---

## 0. 版本锚点

| 组件 | 位置 | 版本 |
|---|---|---|
| coforge（基线） | `/home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl` | 分支 `feat/ov-cm-implementation`；**跑批启动于 `98d24e64`**，当前 worktree HEAD `aca5fbf89b`（此后 4 个提交只含产品修复 + ADR + 本报告，见报告 §A.5） |
| coforge（主克隆，仅取 `.env`/secrets） | `/home/zhoujie22/river2_0/coforge` | 工作区未改动，评测不在此目录跑 |
| OpenViking | 只读引用，评测不启动第二套 | `main @e8a8babf41`；`feat/fork-node-foundation @a16e20a60974`（用户口径引用的 `9cff8844` 已包含在内）；容器镜像 `openviking-prototype:e44ea6e11add1c7b3d4accdbfaf16e900a6049df-local-embed` |
| lsk（对照线） | `/home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval` | detached `feat/learned-skill @4a7f2890da`（详见其 REPRO.md） |

manifest / runner / 判分器哈希：见 `MANIFESTS.sha256`（7 个 manifest + 3 个 runner 源文件 + 3 个官方判分器 + OV compose）。

## 1. 基础设施（跑批期间形态）

| 角色 | 入口 | 备注 |
|---|---|---|
| web | `http://127.0.0.1:18888` | `bin/web-start.sh`：bun vite，从 `/home/zhoujie22/river2_0/coforge/apps/web/.env` 读 5 个变量（不打印） |
| web 看门 | — | `bin/web-watch.sh` |
| OpenViking prototype | `http://127.0.0.1:1933` | `docker compose -f infra/docker-compose.yml -f infra/compose.openviking-prototype.yml up -d openviking-prototype`（compose 来自本 worktree `infra/`；健康检查 `GET /health` = 200） |
| postgres | `127.0.0.1:5432` | 容器 `coforge-postgres-1`，库 `coforge`（与 lsk 线共享实例，不同库） |
| redis | `127.0.0.1:16379` | 容器 `coforge-redis-1`，应用用 **DB 0** |
| centrifugo | 容器 `coforge-centrifugo-host` | 地址/密钥来自 `coforge/apps/web/.env` 的 `COFORGE_CENTRIFUGO_API_URL` / `_API_KEY` |
| sidecar 8732 | `http://127.0.0.1:8732` | `bin/slb-sidecar-start.sh`，profile `skilllearnbench`，tasks-root = `SkillLearnBench/code/vendor/skilllearnbench-official` |
| sidecar 8733 | `http://127.0.0.1:8733` | `bin/sf-sidecar-start.sh`，profile `skillflow`，tasks-root = `SkillFlow/data/SkillFlow-Task/test_tasks` |
| OV account 池 | `/tmp/pcm-eval-ov-keys.json` | 经 `COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE` 传入；文件内容不打印、不进 argv |
| 冻结判分环境 | `/tmp/evo-grading-0909` | 09-09 快照，**重启即失**；重建方法见 `evol_bench/EvoAgentBench/REPRODUCE.md` §3 |

两个 sidecar 都带 `--exec-proxy http://172.17.0.1:7893`（容器内出网代理）。

## 2. 密钥规约（务必遵守）

- 所有密钥只从文件 **source**：`coforge/apps/web/.env`（5 个变量）、`/tmp/pcm-cursor-api-key.env`、`/tmp/pcm-eval-ov-keys.json`、`infra/secrets/openviking_prototype_ov_conf`、`apps/web/secrets/worker-jwt-private.jwk.json`（lsk 线）。
- **不要** `cat`/`echo`/写日志/写进 argv。启动脚本里出现的只有 *文件路径*。
- 复现这一轮时如遇 "缺 key"，先确认文件存在，不要用命令行参数传 key。

## 3. runner 通用机制（evolbench-collab）

- manifest 每行一个 episode：`benchmark` / `episode_id` / `task_id` / `family_id` / `split` / `role` / `order` / `turns[0].prompt` / `grader{kind,...}`。
- `run_id = <evaluationId>:<episodeId>:<seed>:<arm>`；`COFORGE_EVAL_RESUME=1` 时读 attempts 文件里已完成的 run_id 并跳过（崩溃/重启续跑靠这个）。
- **`episodesForArm`（`src/manifest.ts:112-118`）：warm 跑 family 全部 episode，cold 只跑 `split === "test"`。** 这是 SLB/SF/PAST 的 cold 分母小于 warm 的唯一原因——不是漏跑。
- attempts 用 `O_APPEND` 单行原子追加，所以多个分片可并发写同一文件；代价是**极少数并发窗口会产生重复行**（evo cold 出现过 38 行），分析前按 `(arm, episode_id)` 去重取最后一条。
- **完成度只看 attempts 覆盖，不要看 `*-summary.txt`**：进程被看门狗 kill 时 summary 会是空壳（`benchmark=none families=0`）。
- 通用分片启动器：`bin/evol-shard.sh <name> <manifest> <evalId> <arms> [families|-] [mod|-] [extra env...]`，内建 15 分钟静默重启（resume 续跑）。

## 4. 逐基准：跑批 + 判分

### 4.1 LoCoMo（`benchmark/public-channel-memory/src/run.ts`）

```bash
# 单样本（bin/pcm-eval-run.sh 同形）：COFORGE_EVAL_SAMPLE_ID=conv-30 ...
COFORGE_PUBLIC_CHANNEL_MEMORY_EVAL=1 COFORGE_EVAL_ARMS=openviking \
COFORGE_EVAL_QA_LIMIT=250 COFORGE_EVAL_POLL_TIMEOUT_MS=300000 \
COFORGE_EVAL_SAMPLE_ID=conv-30 mise exec -- bun benchmark/public-channel-memory/src/run.ts
# 10 个样本顺序 marathon：bin/pcm-eval-marathon.sh
```

- 判分：harness 内建 LLM judge，结果落在 attempts 行的 `judge` / `judgeReason` / `headlineEligible`。离线"宽松口径"补判是当时的一次性 python（未落盘），`*-rejudged.jsonl` 是那批产物。
- 结果映射（报告 §A.3 用的就是这些文件，行的 `sampleId` 是 conv-XX）：

| 样本 | attempts 文件（`benchmark/public-channel-memory/result/`） |
|---|---|
| conv-26 | `attempts-2026-09-22T155147624Z.jsonl`（152 行） |
| conv-30 | `attempts-2026-09-23T015238156Z.jsonl`（81） |
| conv-41 | `attempts-2026-09-23T164504509Z.jsonl`（152，重跑） |
| conv-42 | `attempts-2026-09-23T053634360Z.jsonl`（199） |
| conv-43 | `attempts-2026-09-23T072202952Z.jsonl`（178） |
| conv-44 | `attempts-2026-09-23T180558222Z.jsonl`（123，重跑） |
| conv-47 | `attempts-2026-09-23T120303121Z.jsonl`（150） |
| conv-48 | `attempts-2026-09-23T135410399Z.jsonl`（191） |
| conv-49 | `attempts-2026-09-23T193908767Z.jsonl`（156） |
| conv-50 | `attempts-2026-09-23T212001516Z.jsonl`（158） |

- 每个样本 fresh OV account（`COFORGE_EVAL_OV_ACCOUNT` 不设即自动开新号）；ingest 用 `COFORGE_EVAL_INGEST_FROM_SESSION`（冒烟用）。

### 4.2 EvoAgentBench（eval id `evo-code-full-collab-1`）

```bash
bin/evo-full-run.sh                       # 单进程 warm,cold 全量 + resume 看门狗
# 或分片：bin/evol-shard.sh evocold1 <manifest> evo-code-full-collab-1 cold - 2:0
```

判分（**必须用 09-09 冻结快照**，现行 `memory_bench/grading.py` 已被 09-18 的"打捞提取器"改动）：

```bash
PYTHONPATH=/tmp/evo-grading-0909 python3 -m memory_bench.grading \
  --attempts benchmark/evolbench-collab/result/evo-code-full-collab-1-dedup.jsonl \
  --manifest /home/zhoujie22/river2_0/evol_bench/EvoAgentBench/data/evo-code-implementation.jsonl \
  --lcb-python /home/zhoujie22/river2_0/evol_bench/EvoAgentBench/code/vendor/lcb-venv/bin/python \
  --bridge /tmp/evo-grading-0909/graders/lcb_grade.py \
  --output-dir benchmark/evolbench-collab/result/grade-evo-collab-1
```

⚠ 该会话的 evo 只提交了 `dedup.jsonl`（392→354 去重后）给判分；原始文件 `evo-code-full-collab-1-attempts.jsonl` 仍在（575KB，354+38 行）。

### 4.3 SkillLearnBench（`slb-full-collab-1`）/ SkillFlow（`sf-full-collab-1`）

```bash
bin/relaunch-shards.sh      # slb1-3 + sf1-4：分 family 分片，带 sidecar env
```

- 每分片必须带 `COFORGE_EVAL_VERIFY_SIDECAR=http://127.0.0.1:8732|8733` 与 `COFORGE_EVAL_ENV_NOTE=$SLBNOTE/$SFNOTE`（即告诉 task agent 走 sidecar 的提示词）。**sfcold 曾在缺这两个 env 的情况下产出 109 条无 sidecar 验证的行，已剔除重跑**——别省。
- `COFORGE_EVAL_EPISODE_TIMEOUT_MS`：SLB 1,500,000 / SF 2,100,000。
- 判分：**官方容器内验证**，由 sidecar `/verify` 执行（官方 verifier 写 `/logs/verifier/reward.txt`），结果回写 attempts 的 `verification.{verified,passed,testScore}`。不需要外部判分步。
- 时序约束：每集先 `POST /env` 绑定（`skillsbench_env_server.py` 首绑优先、进程内按 episode 缓存），再 `/execute`；`/verify` 才开 fresh 容器。

### 4.4 AgentStream（三模式：`as-seq` / `as-int` / `as-iso`）

```bash
bin/evol-shard.sh as-seq1 /home/zhoujie22/river2_0/evol_bench/AgentStream/data/agentstream-sequential-seed1.jsonl as-seq-collab-1 warm,cold
# interleaved / isolated 同理
```

判分（**必须用该基准自带判分器**——EvoAgentBench 的冻结 grader 不认非 evoagentbench 的 manifest，会 graded_runs=0）：

```bash
PYTHONPATH=/tmp/evo-grading-0909 python3 /home/zhoujie22/river2_0/evol_bench/AgentStream/code/agentstream_grading.py \
  --attempts benchmark/evolbench-collab/result/grade-as-<mode>/attempts.jsonl \
  --manifest /home/zhoujie22/river2_0/evol_bench/AgentStream/data/agentstream-<mode>-seed1.jsonl \
  --lcb-python /home/zhoujie22/river2_0/evol_bench/EvoAgentBench/code/vendor/lcb-venv/bin/python \
  --bridge /tmp/evo-grading-0909/graders/lcb_grade.py
```

- 判分器**没有 `--output-dir`**，`graded_attempts.jsonl` / `grading_report.json` 写在 `--attempts` 的同级目录 → 判分前把 attempts 复制到一个独立目录（`result/grade-as-<mode>/attempts.jsonl`），否则会覆盖 PAST 的判分产物。`bin/grade-as-rest.sh` 就是这么做 int/iso 的。
- 补判记录（2026-09-29 02:23/02:25，同一冻结环境）：int warm 86.96% vs cold 81.82%（fc 91.67/81.25、code 81.82/82.35）；iso warm 88.64% vs cold 86.05%（fc 96.0/86.96、code 78.95/85.0）——与报告 §A.3 表逐位一致。
- 已知 warn：BFCL 部分是"keyword-arg AST compare"的简化复刻（非官方 checker）；数据池为自组装池（BFCL v4 live_simple + LCB code）。

### 4.5 PAST-Bench（`past-collab-1`）

```bash
bin/evol-shard.sh past1 /home/zhoujie22/river2_0/evol_bench/PAST-Bench/data/past-notes-memory.jsonl past-collab-1 warm,cold
```

判分：

```bash
PYTHONPATH=/home/zhoujie22/river2_0/evol_bench/PAST-Bench/code python3 -m past_grading \
  --attempts benchmark/evolbench-collab/result/past-collab-1-attempts.jsonl \
  --manifest /home/zhoujie22/river2_0/evol_bench/PAST-Bench/data/past-notes-memory.jsonl
# 输出落在 attempts 同级的 graded_attempts.jsonl + grading_report.json（本目录下的根级文件即 PAST 产物）
```

- 口径：判分器自报 `channel_adapted_partial_non_official`，grounding 在频道协议下不可观测；算的是"Host + graph-memory-service 的系统比较"，不是官方 PAST 持久化缺口测量。
- 配对分析注意：cold 只有 40 集（test），scored-only 与"无分记 0"两个口径方向相反，报告 §A.3 已双列。

### 4.6 SkillsBench（`benchmark/skillsbench-collab/src/run.ts`）

```bash
bin/sb-lane.sh 0 3     # lane 0 of 3；任务按 `ls bench_data/tasks | sort | awk NR%n==l` 静态切分
```

- **坑（曾导致 2 天白跑）**：runner 的任务选择只认 `COFORGE_EVAL_TASKS`（`src/env.ts:55`），没有它就从 `COFORGE_EVAL_TASK_COUNT ?? 1` 回退到 `available.slice(0,1)`——**静默只跑第一个任务**。`bin/sb-lane.sh` 已修。
- 判分：容器内 pytest port（官方测试文件），结果写 attempts 的 `verification.{verified,passed,testScore}`；无外部判分步。
- 可跑任务 = `bench_data/tasks` 的 87 个目录减去该基准 `EXCLUDED_TASKS` 的 10 个 = **86**。
- `ada-bathroom-plan-repair` 永远跑不起来：task.md 10,676 字符 > 频道消息体上限 8,000（`apps/web/src/server/conversations/public-channels.server.ts:1063` → `AppError("INVALID_INPUT")`）。属于产品上限，不是评测 bug。

## 5. 看门狗 / 事故回避

> ⚠ `bin/` 里的脚本是**事发当天的原样拷贝**，内部仍写着 `/tmp/xxx.sh` 与 `/tmp/*.log` 路径（例如 `mine-watch.sh` 调用 `/tmp/evol-shard.sh`）。要真正复跑，先把 `bin/*.sh` 拷进 `/tmp`（或改掉脚本里的路径），别指望直接从仓库路径跑通。

- `bin/mine-watch.sh`：每 300s 巡检，**用 `/proc/<pid>/environ` 里的 `COFORGE_EVALUATION_ID` 识别"本线的"进程**，只补起自己掉的分片（sf2-4、sfcold1-2、as-seq/int/iso/past、sb lane 0-2）。**它没有"全部完成"的退出条件**——本轮全部集跑完后已手工停掉（2026-09-29 02:30 UTC），否则它会每 5 分钟空跑一轮 resume。复跑时若还要它守夜，跑完记得停。
- ⚠ **绝不要 `pkill -f 'evolbench-collab/src/run.ts'`**：lsk 线与本线的 cmdline 完全相同，会连带杀掉对照线。要停只按 PID/进程组。
- 事故清单（都已在报告 §A.5 记录）：sb lane 未传 `COFORGE_EVAL_TASKS`（重复跑同一任务）；sfcold 缺 sidecar env（109 污染行）；evo cold 并发分片重复行（38 行）；OV prototype 容器 unhealthy 两天（只损进度、未污染数据）。

## 6. 产物路径

| 基准 | attempts / 判分产物（均被 `.gitignore` 忽略，不进 git） |
|---|---|
| LoCoMo | `benchmark/public-channel-memory/result/attempts-*.jsonl` + `summary-*.txt` |
| EvoAgentBench | `benchmark/evolbench-collab/result/evo-code-full-collab-1{,-dedup}.jsonl`、`grade-evo-collab-1/` |
| SkillLearnBench | `…/result/slb-full-collab-1-attempts.jsonl` |
| SkillFlow | `…/result/sf-full-collab-1-attempts.jsonl` |
| AgentStream | `…/result/as-{seq,int,iso}-collab-1-attempts.jsonl`、`grade-as-{seq,int,iso}/`（int/iso 于 09-29 补判落盘） |
| PAST | `…/result/past-collab-1-attempts.jsonl`、根级 `graded_attempts.jsonl` + `grading_report.json` |
| SkillsBench | `benchmark/skillsbench-collab/result/attempts-*.jsonl`（85 任务）、`void-mislabeled-20260925/`（归档的错标结果） |

## 7. 未跑 / 缺口

- **EarthBench**：全量 manifest 尚未 emit，未启动。
- **LifelongAgentBench**：数据集未下载。
- **LongMemEval**：只有冒烟（`bin/lme-eval-run.sh`），未进报告口径。
- `ada-bathroom-plan-repair`：产品 8,000 字符上限卡死（见 4.6）。
