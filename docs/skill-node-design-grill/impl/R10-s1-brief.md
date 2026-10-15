# R10-S1 派发件：16 个有记忆 test 任务 × 3 臂（cold／our／placebo）

**上游**：`R10-design.md`（测量设计＋§8 跑法）／`R10-brief.md`（接口清单）／#182（探路波）／#183（本轮模型 `DeepSeek`）／#184（规模裁定）／**`R10-s0-verdict.md`＋`R10-s0-findings.md`（S0 验收；本件 §0 的五条协议修正全部来自它，违反即交回重做）**。

**本件形状**：S0 已证明接缝通且**五道门全过**（真适配层 → 生产读路径 → `--- recalled memory` 进提示 → 官方 verifier 出数 → `build_report` 能算），但 S0 的**数值不是测量**（n=1＋warm 判词被两臂共享）。S1 把同一套东西放到 **16 个有记忆的 test 任务**上跑三臂，拿**方向**。

## 0. 与 S0 的五条协议修正（**必须遵守**）

1. **先预热 16 个镜像，再跑任何臂**。跑 episode 前对 16 个 task_id 调 `POST /prebuild`；**用 3 个并发请求打散**（`ThreadingHTTPServer`，每请求内部串行；并发建不同镜像安全），逐个记录镜像名与构建耗时。
   理由（S0 实测）：未预热时首次 `POST /env` 同步 `docker build` **10–12 分钟**，Pi 客户端 fetch 超时是 **300 s** ⇒ 首轮工具调用连吃 `fetch failed`、第一回合整体报废，且**只有先跑的臂付这个代价**＝系统性偏袒。现状：16 个镜像里**只有 1 个**（`grid-dispatch-operator`）在位，其余 15 个要建；预热时段不消耗模型 token。
2. **逐臂各起一个侧车，端口不同，三个都活到判分结束**：`cold→8731`、`our→8735`、`placebo→8736`。
   理由：侧车 env key＝`task_id@<episodeDir 末三段>`，两臂的 workdir 都是 `work-warm/episodes/0001-<episode>` ⇒ **同名**，单侧车的 `episodes` 字典 first-call-wins ⇒ **placebo 会拿到 our 的容器**（S0 实测：placebo 的 `cat /root/solve.py` 读到 our 的解并直接执行，两臂的判词**结构上不可能各出一份**）。
   ⇒ extension **必须逐臂生成**（`skillsbench_extension_gen.py --env-url` 指向该臂自己的侧车），runner 的 `--sidecar-url` 同步换。
3. **一臂跑完就停，等我把这一臂判分完（`/verify` 会把容器拆掉）再跑下一臂**。判分顺序＝`cold 段 → 我判 cold → our 段 → 我判 our → placebo 段 → 我判 placebo`。标记文件见 §3。
   理由：① 每臂要有**独立**判词（S0 的教训）；② 磁盘封顶（每容器写层 ~770 MB，16 个一波 ≈ 12 GB，现 51 GB 可用）；③ 判完即拆容器，下一臂拿到的容器是干净的（S0 里 placebo 继承了 our 的 `/root`）。
4. **不许用 S0 的 `/tmp/r10-s0/run_arm.sh`**：它的 `pkill -f 'skillsbench_env_server.py --port 8731'` **永不匹配真实 cmdline**（参数在 `--port` 之前），S0 里 4 次侧车启动只有 1 次绑上端口、其余 `EADDRINUSE` 即死，而 readiness 探活探的是老进程 ⇒ 脚本打印的 "sidecar up" 是假阳性。**本波 3 个端口互不冲突，不需要任何 pkill**；真要停某个侧车就按 PID 停并在日志写明。
5. **逐集登记工具面与答案面触碰（审计产物，不许省）**：对每集转录统计 `toolCall.name` 计数、宿主机路径读取（`bash`/`read` 的 `arguments` 里出现 `tasks/*/oracle`、`verifier/`、`vendor/` 等）、以及容器内 `/verifier` 触碰（`run_command` 的 command 里出现 `/verifier`）。
   理由（S0 实测）：**oracle 在宿主机可读**（our 臂真读了 `tasks/grid-dispatch-operator/oracle/solve.sh`，全文进了转录）、**`/verifier` 在容器内可读**（placebo 臂真读了 `test_outputs.py` 并自己跑了一遍）。可用性三臂相同、**使用行为不同** ⇒ 这是**偏向暖臂**的读数污染。见 §6 的先登记判读规则。

## 1. 硬约束（与 S0 相同）

- **不改 harness**：`evol_bench/`（含 `SkillsBench/`）、`memory_graph_evolving/` 一行都不改；`OpenViking/` 只只读 import。
- **不 push、不建 `ov.conf`、不加依赖**；凭据只从环境文件读、不进 argv、不打印。
- **不许动**：端口 `18888／1933／8789／8732／8733`、`coforge-openviking-prototype-1`、共享 `coforge` DB、以及**正在跑的 118 个 `sb-*` 容器**。本件用 **8731／8735／8736／8741**。
- **不许判分**（判分键由我按）：不要 `--shutdown-after`、不要 `kill` 侧车、不要 `docker rm`、不要 `docker rmi`。
- **磁盘**：每个检查点记 `df -h /`；**可用低于 15 GB 就停下报卡点**（现约 51 GB）。不要清任何东西。
- **上限 48 集**（16 任务 × 3 臂）＋重试不超过 6 次（重试必须在报告里逐条写明是哪一集、为什么）。
- **单集 30 分钟没产出就停下报卡点**（`--episode-timeout 30m`；建镜像的时间先预热掉，不算 agent 的）。
- **三个侧车的日志分开写**（`--log /tmp/r10-s1/lifecycle-<arm>.jsonl`），别让它们互相覆盖。

## 2. 任务集（**照抄，16 个，不许增删**）

来自 `data/sb-full.jsonl` 里 `split=test` 且落在三个有记忆 family 的全部任务（这是**覆盖面事实**：45 个 test 任务里只有这 16 个能被我们的记忆服务，其余 29 个在别的 family，`our` 会静默退化成 cold）：

| family | 任务（16） |
|---|---|
| `sb_cybersecurity` | `dapt-intrusion-detection`／`fix-erlang-ssh-cve`／`suricata-custom-exfil`／`syzkaller-ppdev-syzlang` |
| `sb_finance-economics` | `financial-modeling-qa`／`invoice-fraud-detection`／`sec-financial-report`／`shock-analysis-demand`／`shock-analysis-supply` |
| `sb_industrial-physical-systems` | `3d-scan-calc`／`ada-bathroom-plan-repair`／`drone-planning-control`／`grid-dispatch-operator`／`manufacturing-codebook-normalization`／`manufacturing-fjsp-optimization`／`r2r-mpc-control` |

**记忆覆盖已由我核实**（`views-r9m45` 实例化 `RetrievalBackend`）：compliant 修订 cyber 3／finance 3／industrial 4；三个家族的真实空间 id 各召回 7／8／8 张投影卡、`filter_reason=ok`。

**manifest**：把这 16 行从 `data/sb-full.jsonl` **原样筛出**写成 `impl/r10_memory_plane/manifest-s1.jsonl`（每行自带 `converter_version`／`upstream`／`selection` 等元数据 ⇒ 直接筛行即满足判分器 formal 校验；**别手写**）。

## 3. 三段握手与每段的产物

标记目录 `/tmp/r10-s1/`。作者脚本按序执行，**每段结束打印检查点摘要后等待标记文件**（每次最多等 60 分钟，超时停下报卡点）：

```
段 0  预热：3 并发 POST /prebuild（16 个 task_id 分摊）→ docker images 核对 16 个都在 → 打印 CHECKPOINT-PREBUILD → 等 /tmp/r10-s1/go-cold.ok
段 1  cold 臂（侧车 8731）   → CHECKPOINT-cold      → 等 /tmp/r10-s1/go-our.ok      （我在中间判 cold）
段 2  our 臂（侧车 8735，plane 切 R10_PLANE_MODE=our）    → CHECKPOINT-our → 等 /tmp/r10-s1/go-placebo.ok（我在中间判 our）
段 3  placebo 臂（侧车 8736，plane 切 R10_PLANE_MODE=placebo）→ CHECKPOINT-placebo → 结束（三个侧车都别 kill）
```

每个 `CHECKPOINT-<x>` 摘要必须含：`df -h /` 一行、该臂 episode 数、`attempts.jsonl` 行数、**`docker ps --format '{{.Names}}' | grep -c '^sb-'` 与这 16 个新容器的名字**、该臂侧车 lifecycle 尾部 5 行、该臂 extension 的 SHA256。

**三次 runner 调用**（除 `--arms`／`--out-dir`／`--extension-file`／`--sidecar-url` 外参数完全相同）：

```bash
/tmp/bench-runner \
  --manifest  <PLANE>/manifest-s1.jsonl \
  --gms-url   http://127.0.0.1:8741 --gms-token "$TOKEN" \
  --pi-binary /home/zhoujie22/pi-0851/node_modules/.bin/pi \
  --provider  lenovo-deepseek-v4-flash --model DeepSeek \
  --pi-env    HOME,PATH,NODE_EXTRA_CA_CERTS \
  --arms      cold          # 段1；段2/3 都写 warm（our 与 placebo 都只能跑 warm）
  --seed      1 \
  --evaluation-id r10-s1-dsv4flash \
  --episode-timeout 30m \
  --out-dir   <SB>/results/r10-s1-cold     # 段2 → r10-s1-our；段3 → r10-s1-placebo
  --refs-root data/staging \
  --extension-file /tmp/r10-s1/skillsbench-extension-<arm>.mjs   # 逐臂生成，env-url 指该臂侧车
  --sidecar-url http://127.0.0.1:8731      # 段2 → 8735；段3 → 8736
```

（`--batch-parallelism` 用默认 4，别改。）

**plane**：只重启 plane（8741），**绝不动任何侧车**。`our`／`placebo` 是两次独立 runner 调用、各需对应模式的 plane 进程；重启后用**模式自证**再开跑：`curl -s -X POST http://127.0.0.1:8741/v1/recalls …` 打一枪，确认响应/日志里的 `plane_mode` 是该臂模式（S0 就吃过「plane 起错模式却探活通过」的亏）。

**视图源冻结**：仍用 `impl/r10_memory_plane/views-r9m45/`（S0 已复制的 R9M 合规视图），**不许换、不许重抽、不许画布兜底**；报告里给出该目录与 `retrieval_backend.py` 的 SHA256。

## 4. 每段的硬门（作者逐条给证据；**过就是过、没过就是没过**）

**段 1（cold）**：① 每集转录首条 user 含 `Context snapshot: no recalled evidence (state=empty).`（16 集逐集给布尔）；② 适配层日志里该臂的 `space_ids` 全部是逐 episode 隔离空间（`space-*-test-N-shared`）且**零命中**；③ 16 集全部有容器（`docker ps` 名字＋lifecycle `env_created`）；④ 该臂侧车 lifecycle 里**没有** `verify_started`（判分是我按的）。

**段 2（our）**：① 逐集给「`--- recalled memory` 段数」（**哪几集是 0 条必须点名**）；② 命中 family 与任务 family **一致**（cross-family 命中 = bug，逐条列出；判据只能用 plane 日志的 `retrieve_family`，**不要用提示里的 `source=` 字符串**——它对 placebo 也写请求方空间）；③ `retrieve_elapsed_ms` 的中位／最大与 `deadline_ms=500` 的超时计数；④ `channel_counts`（fork／projection／fact；**subgraph 结构性为 0**）。

**段 3（placebo）**：① 形状门：逐集给「our 卡片数 vs placebo 卡片数 vs `placebo_donor_family`」对照表，证明**同形同数、供货 family 是另一个**；② 抽样 1–2 集的卡片正文对照（our 的 industrial 卡片 vs placebo 的 cyber 卡片），证明内容真的错配；③ 逐集确认**没有**任何一集出现「our 与 placebo 容器同名／placebo 容器里已有 our 的文件」——本波三个侧车独立，若仍出现共享即报卡点。

**段 4（审计，三臂都要，对应 §0.5）**：逐集给 `toolCall.name` 计数表 ＋ **四个布尔**：`host_oracle_call`（宿主机工具的命令/路径里出现 oracle，＝**尝试**）／`host_oracle_content`（**判据行**：配对的 toolResult 里真的匹配到磁盘 oracle 原文的行，len≥45）／`host_read_vendor_or_taskmd`／`container_read_verifier`（容器内命令出现 `/verifier`），外加原始命中片段（命令或路径）。
判据脚本可直接用我写的（已在 S0 三集上验过真值）：`python3 /tmp/probes/r10_audit.py --results <dir> --out <audit.jsonl>`。

**不许读成（进报告）**：`HybridRetrievalFacade.retrieve()` 只有 fork／projection／fact 三条车道，`retrieve_historical_subgraphs` 是**按 subgraph_id 点名的诊断查询**、不在查询召回路径上 ⇒ **R9M 的 10 个子图产物不进检索面**；S1 测的是「投影（＋fork）车道」。任何「我们的图都进去了」的说法都是错的。

## 5. 交回

1. 三个 `CHECKPOINT-<x>` 摘要（含 df、容器名、lifecycle 尾部、extension SHA256）；
2. §4 每段的逐条硬门结果（证据路径＋原文片段，0 条命中的集单独列出）；
3. 三条 runner 调用命令（原样）＋**预热耗时表**（16 个镜像逐个）＋视图源与 `retrieval_backend.py` 的 SHA256；
4. **我该跑的判分命令**（`--attempts` 用哪个文件、`--manifest`、`--sidecar-url` 该指哪个端口），以及**当前活着的三个侧车/plane 的 PID 与端口**、每个臂的容器名清单；
5. 卡点清单（现象／证据／根因／最小解法／是否要裁定）与**未能回答项**（不许猜）；
6. **不许**给出任何「记忆有用/没用」的结论（判分不在你手里）。

## 6. 判读规则（先冻结，跑完才打分）

- 三臂同一任务集、同一模型（`DeepSeek`）、同一 `--seed 1`、同一超时；**本轮与 9 月 campaign 的数值不可比**（模型 id 被网关下线，见 #183）。
- 判分：官方 `skillsbench_grading.py`，**逐臂各自判**（`--sidecar-url` 指该臂端口），三臂的冷基线只用 cold 一份；`our − cold > 0` **且** `our − placebo > 0` 才算「影响图记忆有用」；`our ≈ placebo > cold` ＝上下文有用、不是我们的图；`our ≤ cold` ＝负结果照报。
- **先登记后读（审计门；规则在 2026-10-01 16:55 定稿，早于任何 S1 读数产生）**。两条泄漏**性质不同，分开处理**：
  - **宿主机 oracle 泄漏＝臂间不对称**（可用性三臂相同、**使用行为不同**；S0 里只有 our 真把原文读进了上下文）⇒ 判据行 `host_oracle_content`。定义 `clean`＝**该集三臂都没有 `host_oracle_content`**。分析时**同时给**全样本 16 集与 `clean` 子集两组数；**若 `clean` < 12 集，S1 只给「污染下不可判读」并等用户裁定**。
  - **容器内 `/verifier` 可读＝水平效应**（三臂都读、机会相同；S0 三集 3/3 都读了）⇒ 单独报 `container_read_verifier` 计数，并**在报告里写明它把各臂通过率一起抬高、从而把臂间差压向 0（天花板压缩）**，不把它算进 `clean`。
  - 另加一条**来源集口径**（`R10-s0-findings.md` 事实 12）：我们记忆的 10 个合规来源集里 5 个是在读过 oracle 的上下文里跑出来的；**投递到模型的卡片文本对 1527 条 oracle 行命中 0/5（无逐字泄漏）**。⇒ S1 的结论只能写成「**经验迁移的效力**」，不能写成「干净条件下习得的经验」。
- 被超时杀／被基础设施问题杀（`no_env_created`、`verifier_exit≠0`）的 episode **单独计数**，不与 `reward=0` 混算。
- **n=16、单模型、无种子重复** ⇒ S1 只能给方向，不是结论。
