# LearnedSkill 评测复现

隔离栈在 coforge worktree `/home/zhoujie22/river2_0/.worktrees/cursor-lsk-eval`（detached，与主克隆同一提交）。主克隆 `/home/zhoujie22/river2_0/coforge` 的工作区未改。OpenViking 仓库只读，评测路径不启动第二套 OpenViking。

## 版本

| 仓库 | 分支 | SHA |
|---|---|---|
| coforge worktree `cursor-lsk-eval` | detached `feat/learned-skill` | `4a7f2890dafc7957e2530d267c781e4db8f43c73` |
| coforge 主克隆 | `feat/learned-skill` | 同一 SHA |
| OpenViking | `feat/fork-node-foundation` | `9cff88444493380cc30869a8e92b805da23527dd` |

已跟踪改动：`eval/uncommitted-coforge-lsk.patch`（runner 数值矫正、host Pi 注入开关、memory-explorer 跳过 host 技能、centrifugo 允许来源 18889）。OpenViking 工作区无改动（`eval/uncommitted-openviking.patch` 为空）。未跟踪的 harness 在 worktree `benchmark/`，清单见 `eval/uncommitted-coforge-lsk-status.txt`。

数据库 `coforge_lsk_eval`，Prisma 迁移 86 条，止于 `20260920230000_learned_skill_agent`。连接串在 `/tmp/lsk-database-url` 与 worktree `apps/web/.env`（权限 600）。应用 Redis 使用同一实例的 DB `/1`，Centrifugo 使用 DB `/2`。共享库 `coforge` 与 Redis DB 0 未做迁移。

## 进程与端口

| 角色 | 地址 |
|---|---|
| web（bun vite） | `http://127.0.0.1:18889` |
| centrifugo | `:18001`，容器 `coforge-centrifugo-lsk`，镜像 `centrifugo/centrifugo:v6.9.2`，cpuset 2-3 |
| 模型 | provider `lenovo-deepseek-v4-flash`，model id `DeepSeek` |
| 裁判 | `grok-4.6`（Cursor CLI） |
| CA | `~/.pi/lenovo-ca-bundle.pem` |

Web 启动：`eval/bin/lsk-web.sh`（会读 `apps/web/secrets/worker-jwt-private.jwk.json`，不打印）。Centrifugo 环境文件 `/tmp/lsk-centrifugo.env`（权限 600），端点指向 18889，Redis DB 2。就绪检查是 `GET /api/jwks` 返回 200。

评测 id 后缀 `-lsk1`。workspace slug 前缀 `lsk-`。

## Manifest sha256

| 文件 | sha256 |
|---|---|
| `evol_bench/EvoAgentBench/data/evo-code-implementation.jsonl` | `f5015bfa0ca7ca03f99ae3b2b7308a918aca7c639dd1831c40a14ec88c29f42e` |
| `evol_bench/SkillLearnBench/data/slb-full.jsonl` | `b893198057f9ea3dd8a3342995662c246982d6723f2b66802085f695d7dbd22c` |
| `benchmark/evolbench-collab/data/skillflow.jsonl` | `c70629b1a8294ecd636a0a68037c5d405c0eefd5bf33298bfdc33c2de293d8e8` |
| `evol_bench/LoCoMo/data/locomo/locomo10.json` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` |
| LongMemEval | `/home/zhoujie22/river2_0/evol_bench/LongMemEval/data/longmemeval/longmemeval_s.json` |

## 重跑

脚本都在 `eval/bin/`，自行 source `.env` 与 `/tmp/pcm-cursor-api-key.env`，不把密钥写进 argv。

- LoCoMo 单题冒烟：`eval/bin/lsk-pcm-smoke.sh`（`COFORGE_EVAL_QA_LIMIT`、`COFORGE_EVAL_INGEST_FROM_SESSION`）
- LoCoMo 全集 marathon：`eval/bin/lsk-pcm-marathon.sh`（只杀子 PID，不用 `pkill -f`）
- LongMemEval 单样本冒烟：`eval/bin/lsk-lme-smoke.sh`
- Evo 单集冒烟：`eval/bin/lsk-evo-smoke.sh`
- Evo 全量 warm（一个 family、顺序累积、15 分钟静默重启、resume）：`eval/bin/lsk-evo-warm.sh`
- Evo 全量 cold：`eval/bin/lsk-evo-cold.sh`（eval id `evo-lsk1-cold`）。`eval/bin/lsk-after-warm.sh` 等 warm 写出 summary 后再启动
- Evo 离线判分：`eval/bin/lsk-evo-grade.sh <attempts.jsonl> <output-dir>`
- SkillLearnBench 冒烟（2 集，sidecar 8734）：`eval/bin/lsk-slb-smoke.sh`；全量：`eval/bin/lsk-slb-full.sh`
- SkillFlow 冒烟（2 集，sidecar 8735）：`eval/bin/lsk-sf-smoke.sh`；全量：`eval/bin/lsk-sf-full.sh`
- SkillsBench 单任务冒烟：`COFORGE_EVAL_TASKS=<task> eval/bin/lsk-sb-smoke.sh`；分片：`eval/bin/lsk-sb-lane.sh <lane> <lanes>`
- 通用 evol 分片：`eval/bin/lsk-evol-shard.sh <name> <manifest> <evalId> <arms> [families|-] [mod|-]`
- 隔离 sidecar：`eval/bin/lsk-sidecar.sh slb|sf`（8734 / 8735）
- Web：`eval/bin/lsk-web.sh`；看门：`eval/bin/lsk-web-watch.sh`

冒烟 manifest：`eval/manifests/slb-lsk-smoke.jsonl`、`eval/manifests/sf-lsk-smoke.jsonl`。共享环境由 `eval/bin/lsk-common.sh` source，密钥不进 argv。

Loop 手工链：`bun benchmark/lsk-memory/demo-loop.ts`，接着对已有 slug 可再跑 `continue-loop.ts`（五段 episode 后 critique）。演示 slug `lsk-loop-demo-979e5d89`。Demo 的 offer 行是脚本调用 `publishMemoryOffer`，不是模型。

Evo cold 跑完后离线判分：`eval/bin/lsk-evo-grade.sh .../evo-lsk1-cold-attempts.jsonl .../evo-lsk1-cold-graded`。`eval/bin/lsk-after-cold.sh` 会自动做这一步。

2026-09-27 harness 接线（不影响已在跑的 evo-lsk1-cold bun 进程）：warm family 结束保留 workspace；`releaseFamily` 先打 `group-memory-snapshot`；新进程的 episode reminder 带 `conversation_id` / `target_agent_id`，并日志 `explore_cites=`。evo-lsk1 已写 attempts 的 mechanism 口径不变。

## 对照协议 v1（2026-09-27，SLB 起生效；evo-lsk1 不重跑）

两臂共用同一测量契约。实现只在 `cursor-lsk-eval` worktree 的 harness，不改产品 offer/shadow-gate。

| 项 | 约定 |
|---|---|
| A1 `final_output` | **Evo**：任务 agent 最后一条含代码围栏的消息；ACK 不取。回归：`benchmarks.test.ts`「extractFinalOutput A1 ACK flips」（warm `2857`/`2902`/`2917` + cold `abc320_a`/`abc325_e`/`abc379_b`）。**SLB/SF**：verifier 看 sidecar 容器文件，不看围栏。`code_extracted` 表示最后一条非 ACK 列出了 `/root/` 或 `/opt/` 路径（court-form-filling=`/root/sc100-filled.pdf`，fix-security-bug=`/root/patches/`）。无路径时回落最后一条非 ACK 且 `code_extracted=false`。 |
| A2 settle | `offer_or_memory_empty_or_task_quiet`：任务已发言且安静 `settleMs` 后收口。`dead_quiet` 仅在 abortQuietMs>0 **且** 无 offer、无 @task 交接、无任务消息时触发。SLB 脚本设 `COFORGE_EVAL_ABORT_QUIET_MS=0`（docker/Maven 可静默超过 10 分钟）。skilllearnbench 默认 `settleMs=180000`。 |
| A3 沙箱 | 每集 `resetTaskSandbox` → 跑 → `snapshotTaskSandbox`。daemon cwd 仍是 agent 目录；残留文件进 `_episodes/<episodeId>/`，attempts 的 `work_dir` 指向该快照。 |
| A4 机制分列 | `memory_offer_deliveries` / `exploration_citations` / `channel_task_handoffs` / `code_extracted` / `settle_reason`。不再把频道 `@task` 算进 offer。 |
| B 投递 | `COFORGE_EVAL_LOOP_OFFER=1` 时，warm 在 prompt 入频道之后、以及 drain 之后各调一次 `publishEvalLoopOffer` → `publishMemoryOffer`。`operationKey` = `lsk-loop-offer-slb-<evalId>-<episodeId>-pre\|post`。`explicitAsk=true` 以绕过 7 日 cooldown。reminder 与 offer body 带 `conversation_id` / `target_agent_id`。cold 不投递。产品 `CRITIQUE_CADENCE=5` 才写 insight；SLB family 短于此则 harness 从最新 distilled episode **桥一条 insight**（`ensureEvalOfferTargets`），否则投递率为 0。这是评测接线，不是产品改动。 |

### SLB 重跑

- Sidecar：harness 在每集 `runEpisode` **之前** `POST /env`（`bindSidecarEnv`，最长 30 分钟等 docker build），再 `POST /verify`。不再依赖模型自觉 bind。生命周期 JSONL 在 `eval/logs/sidecar-slb-8734-lifecycle.jsonl`（新起的 sidecar；已在跑的 8734 进程仍写旧 `--log`）。
- 协议冒烟（大 `slb_court-form-filling` + 小 `slb_fix-security-bug`，warm 6 / cold 4）：`eval/bin/lsk-slb-smoke-watch.sh`（50 分钟静默才重启；heartbeat 每 120s）。manifest `eval/manifests/slb-lsk-protocol-smoke.jsonl`。门槛：`eval/bin/lsk-slb-gate.py`（warm offer≥80%；两臂 **sidecar 路径抽出率**差≤5pp；leak/timeout 差≤10pp；sidecar `graded=true`）。
- 全量 warm：`eval/bin/lsk-slb-warm.sh`（eval id `slb-lsk1`，seed 1，`COFORGE_EVAL_LOOP_OFFER=1`）。
- 全量 cold：warm summary 后 `eval/bin/lsk-after-slb-warm.sh` 自动起 `eval/bin/lsk-slb-cold.sh`（`slb-lsk1-cold`，76 test）。
- `eval/bin/lsk-slb-full.sh` 现在只拉 warm + after-warm，不再三路并发分片。

seed ×3 未排：等 seed1 两臂出数且基线排空后再写 PROGRESS。
