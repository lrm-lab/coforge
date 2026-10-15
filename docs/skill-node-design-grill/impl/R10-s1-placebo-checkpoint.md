# R10-S1 placebo 臂 checkpoint（编排侧＝验证方记录，2026-10-02）

判分键由我按（`R10-design.md` §8）。本文件只记我**自己复算/自己取到**的读数。

## 1. 波与门

| 项 | 值 | 取证 |
|----|----|------|
| 集数 | **16/16** | `results/r10-s1-placebo/attempts.jsonl` 16 行 |
| 墙钟 | 23:50:53 → 00:45:29（**≈55 分钟**，串行 warm 臂） | `run-placebo.log` + `attempts.jsonl` mtime |
| **recall 门** | **16/16** `recall=complete(5)`（无 `empty(0)`） | 逐行 grep |
| 官方判词 | `pass_rate=0.4375`（7/16）、**`no_env_created=6`**、`verifier_errors=0` | 我跑 `skillsbench_grading.py`（1 次，`/tmp/r10/s1-grades/placebo/`，侧车 8736） |
| 判分时新起容器 | **0**（`new verify_started: cold=0 warm=0`） | 判词全部来自侧车 8736 进程内缓存——我在波中逐集调 `/verify` |
| 我的增量判词条数 | 10（其余 6 集无 env，见 §3） | `/tmp/r10/s1-incremental-verify-placebo.json` |

## 2. 供货来源门（donor ring，**通过**）

`plane_mode=placebo` 17/17。donor 环形**成立**：请求方 family → 供货 family 为**三循环**，绝不等于自身：

| 请求方空间（`family_scope`） | 供货 family（`retrieve_family`=donor） | 抽样卡片 session |
|---|---|---|
| `space-sb-cybersecurity-shared` | `sb_finance-economics` | `0005-sb-weighted-gdp-calc`／`0006-sb-xlsx-recover-data` |
| `space-sb-finance-economics-shared` | `sb_industrial-physical-systems` | `0010-sb-energy-unit-commitment`／`0008-sb-adaptive-cruise-control` |
| `space-sb-industrial-physical-systems-shared` | `sb_cybersecurity` | `0001-sb-fix-druid-loophole-cve` |

（注意：`retrieve_family` 字段写的是 **donor**，不是请求方；请求方只能看 `family_scope`。我核过卡片的 session_id 属于 donor family ⇒ 内容真错配。形状／张数与 our 同形（5 卡）。）

## 3. 六集 `no_env_created`（结构性差异，必须单列）

侧车 `lifecycle-placebo.jsonl` 只有 **10 条 `env_created`**；6 集从未建 env（转录显示 agent 全程在**宿主** FS 上作业、一次 `run_command` 都没调）：
`dapt-intrusion-detection`、`suricata-custom-exfil`、`sec-financial-report`、`shock-analysis-supply`、`shock-analysis-demand`、`financial-modeling-qa`
—— 含**全部 4 个金融任务** + 2 个网络安全任务；日志里这 6 行均为 `output=nil`。官方判分器按 `no_env_created`（infra/行为杀）记 0、不调 `/verify`。
对照：**our 臂仅 1 集** no_env（shock-analysis-supply），cold 0 集。

## 4. 三臂合并（官方判词，逐臂各自判、我合并）

| 臂 | 官方 pass_rate | no_env_created | 真跑集上的通过率 |
|----|----|----|----|
| cold | **0.7500**（12/16） | 0 | 12/16 = 75.0% |
| our | **0.4375**（7/16） | 1 | 7/15 = 46.7% |
| placebo | **0.4375**（7/16） | 6 | 7/10 = **70.0%** |

- `our − cold = −0.3125`
- `placebo − cold = −0.3125`
- **`our − placebo = 0.0000`**

**双跑配对集**（our 与 placebo **都真跑**的 10 集，剔除 6 个任一方 no_env 的集）：cold 8/10、placebo 7/10、**our 5/10** ⇒ 配对下 `our − placebo = −2 集`。（该配对集**不含** our 的唯一独占胜 `sec-financial-report`，故对 our 是保守的。）

## 5. 泄漏扫描（同一把尺子，三臂；工具 `/tmp/probes/r10_host_surface_scan.py`＋`r10_net_oracle.py`）

| 通道 | cold | our | placebo |
|------|------|-----|---------|
| **C 宿主 FS 读 vendored 任务树**（`repo_task_dir`，最强信号） | **0** | **4**（financial-modeling-qa／sec-financial-report／shock-analysis-demand／shock-analysis-supply） | **1**（r2r-mpc-control） |
| C 宿主 FS oracle 关键词（`kw_oracle`） | 1（drone） | 4 | 1（r2r） |
| E 跨臂产物读（`E_cross_arm`） | 0 | 2 | 1（r2r） |
| A 网络取 oracle（容器内，shingle≥30%） | 3 | 0 | **0** |
| B 容器内 `/verifier` 读取 | 8 集 | 4 集 | 5 集 |

⇒ 宿主 FS 取 oracle 这条**记忆臂不对称**通道：our 4 集 vs placebo 1 集 vs cold 0 集，**仍是 our 偏重**（与 #191 一致），但 placebo 也出现过 1 次（r2r-mpc-control，`repo_task_dir x12`、`kw_oracle x4`）。placebo 的 r2r 通过＝cold 也通过（非独占胜）。

## 6. 方向读数（按 brief §108 预注册规则）

规则：`our − cold > 0` **且** `our − placebo > 0` 才算「影响图记忆有用」。

- `our − cold = −0.3125 ≤ 0`，`our − placebo = 0.0` ⇒ 落入 **`our ≤ cold`：负结果照报**。
- 且修正干净集（剔除 A/B/C/E/F 命中）在 earlier our/cold 对照上 n=11 **< 预注册门槛 12** ⇒ **「污染下不可判读」**。
- 结论方向：S1 未观察到「积累经验（影响图记忆）带来方向为正的通过率提升」；our 与 placebo 官方持平，且 our 与 placebo 的**内容差**（同形错配的 donor 记忆）未产生可辨的通过率差。

## 7. 本记录的偏差披露

1. placebo 波串行、our 亦串行，cold 为 4 并发 —— 臂间**协议不对称**（cold 并发/暖臂串行），该不对称方向上**利于**暖臂，故不能解释 our 的负读数。
2. 6 集 no_env 使 placebo 的官方 pass_rate 被 infra 杀压到 0.4375；真跑集上 placebo≈70%、our≈47% —— **官方 all-16 读数与「真跑集」读数给出不同图画**，两者都报，不择其一。
3. 判词由我在波中逐集增量 `/verify` 取得（判分键仍我按；官方判分器只重放：`new verify_started=0`）。
4. 我的宿主面扫描器在下载语料上迭代过 3 版（假阳性史见 `/tmp/r10/s1-verifier-notes.md`）；本轮三臂用**同一版**，可比。

## 8. 后记（2026-10-02，根因分析修正本记录，见 CONSENSUS #195）

**本记录 §5/偏差披露 2 的「6 集 no_env＝全程宿主 FS 作业」是误读，予以修正**：episode 原始日志（`work-warm/episodes/{0002..0009}/host-events.jsonl` + session jsonl）显示这 6 集（连同 invoice 共 8 集）死于 **23:52–00:11 的 provider 空回复/超时窗口**——每次 `pi_agent_start` 后 assistant content 为空数组（转录 `stopReason=error, errorMessage=Request timed out`、usage 全 0），重试 3 次全空后放弃，单集 ≈67s、**工具调用 0 次**。agent 不是「在宿主干活」，是**一个有效动作都没发出**。invoice 第 4 次重试成功故过。剔除故障集 placebo ≈ 12/16 ≈ cold。另 mfg-codebook（147s，窗口外）为第二类截断：有实际作业（49 条记录）但无最终消息即被 turn 结束。行动：同条件重跑 8 故障集＋pi 层加空回复集级重跑规则（用户已批准）。

## 9. 后记二（2026-10-02，故障集重跑，CONSENSUS #197）

7 个故障集已同条件重跑（`results/r10-s1-placebo-rerun7/`，原 seed/manifest/plane/sidecar/扩展，recalls 注入核验正常）：健康门 7/7 全过，判分 **6/7 通过**。修正 placebo 读数 **0.4375 → 0.8125（13/16）**，反超 cold（+0.0625）；shock-demand 仍 0（no_env_created 复发，四臂全 0 的题）。两点披露：① 修正读数的 6 个 pass 里 4 个踩了宿主 vendor 通道（shock-supply 31 次/ sec-fin 11/ dapt 8/ suricata 3）——placebo 臂在 provider 健康时同样宿主狩猎；② §8 的"剔除故障 ≈12/16"预估被实际重跑证明还偏保守。
