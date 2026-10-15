# R10-S1 方向件（验证方＝判分键持有人，2026-10-02）

**上游**：`impl/R10-s1-brief.md`（派发，含 §6/§108 预注册规则）、`impl/R10-s1-{cold,our,placebo}-checkpoint.md`（逐臂取数）、`impl/r10_memory_plane/R10-s1-report-2026-10-01.md`（作者交回件）。
**判分键**：官方 `evol_bench/SkillsBench/code/skillsbench_grading.py`，**逐臂各自判**（`--sidecar-url` 指该臂端口），作者未按。
**本文只给方向，不给「记忆有用/没用」的结论**（n=16、单模型、无种子重复，且污染下不可判读；见 §3）。

合并产物：`/tmp/r10/s1-grades/{arm-cold,arm-our,arm-placebo,summary,combined}.json`；分通道分析 `/tmp/r10/s1-direction.json`。

---

## 1. 官方判词（逐臂各自判、我合并）

| 臂 | 侧车 | 官方 pass_rate | no_env_created | verifier_errors | 判分时新起容器 |
|---|---|---|---|---|---|
| cold | 8731 | **0.7500**（12/16） | 0 | 0 | 0 |
| our | 8735 | **0.4375**（7/16） | 1 | 0 | 0 |
| placebo | 8736 | **0.4375**（7/16） | 6 | 0 | 0 |

- **`our − cold = −0.3125`、`placebo − cold = −0.3125`、`our − placebo = 0.0000`**（16 集全配对；逐臂 episode 集归一化后完全一致）。
- 判分器无法一次吃三臂（单 `--sidecar-url`，且 our/placebo 都写 `arm=warm`）⇒ 逐臂跑官方判分器，最终减法由 `r10_grade_arm.py --combine` 用 `build_report` 的同一统计量复算，并断言配对集一致。
- **真跑集**（剔除 no_env 集）：cold 12/16=**75.0%**、our 7/15=**46.7%**、placebo 7/10=**70.0%**。
- **双跑配对集**（our 与 placebo 都真跑的 10 集）：cold 8/10、placebo 7/10、**our 5/10** ⇒ 配对下 `our − placebo = −2 集`。

## 2. 预注册判读规则 → 方向

规则（brief §6，任一 S1 读数产生前冻结）：`our − cold > 0` **且** `our − placebo > 0` 才算「影响图记忆有用」；`our ≈ placebo > cold` ＝上下文有用非本图；`our ≤ cold` ＝负结果照报。

- `our − cold = −0.3125 ≤ 0`、`our − placebo = 0.0000` ⇒ **落入「`our ≤ cold`：负结果照报」**。
- `our ≈ placebo`（官方差 0）⇒ 本轮**未观察到**「同形错配的 donor 记忆」与「我们的影响图记忆」之间可辨的通过率差。
- **干净子集门槛**：本分析按扩展口径（排除 A 网络取 oracle、C 宿主 FS 取 oracle；B 容器内 `/verifier` 为水平效应单列）得 corrected strict-clean **n=4 < 预注册门槛 12** ⇒ **「污染下不可判读」，只给方向**。若只按 #191 的 our/cold 两臂 `host_oracle_content` 口径，干净集约 **n=11 < 12**，同样不过门槛。**两种口径都不过**。

**方向措辞（必须）**：S1 未观察到「积累经验（影响图记忆）带来方向为正的通过率提升」；`our` 的负差**不是**我们这张图的效力（记忆内容既未加分也未减分到可辨）；`our − cold` 的差**主要由「谁更会用泄漏路径」驱动**，不能写成「经验迁移有效」。

## 3. 泄漏面（三臂同一把尺）

| 通道 | cold | our | placebo | 性质 |
|---|---|---|---|---|
| A 容器内网络取 oracle（shingle≥30%） | **3** | 0 | 0 | 臂间不对称（上游 benchmark 的公开 oracle） |
| B 容器内挂载 `/verifier` 读取 | 8 | 4 | 5 | **水平效应**（三臂机会相同）⇒ 抬高各臂、把臂间差压向 0 |
| C 宿主 FS 读 vendored 任务树（`repo_task_dir`） | **0** | **4** | **1** | **臂间不对称，仍是 our 偏重** |
| E 跨臂产物读（后跑臂读先跑臂产物） | 0 | 2 | 1 | 顺序跑臂的次生缺陷，结构性不对称 |

- **C（our 4/16）**：`sec-financial-report`／`shock-analysis-supply`／`shock-analysis-demand`／`financial-modeling-qa` —— **正好是 5 个 finance 任务里的 4 个**。our 的唯一净增益 `sec-financial-report` 0.0→1.0 就落在宿主读 `oracle/solve.sh` 这条路径上（见 #191；思考链未出现「因为记忆卡这么说」的直接引用 ⇒ 可确证「路线差」，**不能**确证「卡片→路线」因果）。
- **placebo 也出现 1 次 C**（`r2r-mpc-control`，`repo_task_dir`×12、`E_cross_arm`×3），但该集 cold 也通过（非 placebo 独占胜）。
- **A（cold 3/16）**：`shock-analysis-supply`／`financial-modeling-qa`／`grid-dispatch-operator`，均从公开 GitHub 拿整份 oracle、奖励全 1.0（见 #190）。our/placebo 未用 A。
- **B 是水平效应**，不计入 clean；写入报告以免把「三臂都读 verifier」误当臂间污染。

## 4. 结构性差异与协议不对称（必须单列）

1. **`no_env_created`：cold 0／our 1／placebo 6**。placebo 6 集全程在宿主 FS 作业、一次 `run_command` 都没调（含**全部 4 个金融任务** + `dapt`／`suricata`）⇒ 官方 all-16 把 placebo 压到 0.4375，而真跑集上 placebo≈70%。**官方 all-16 与真跑集给出不同图画，两者都报，不择其一。**
2. **臂间协议不对称**：`cmd/bench-runner/main.go` 里 `cold` 走并行协调器（默认 4 并发），`warm`（our/placebo）走通用串行循环。该不对称**方向利于暖臂**（暖臂独占机器），故**不能**解释 our 的负读数；对我们的读数影响是 our 与 placebo 同构（不影响 our−placebo），但影响 cold−warm 的绝对差。
3. **`fix-erlang-ssh-cve` 三臂全 0，是统一基建失败**：官方 verifier 的 `test_outputs.py` 执行 `chmod +x /verifier/build.sh; /verifier/build.sh`，而我们的 harness 把 `/verifier` **只读挂载** ⇒ `chmod: Read-only file system`、`bash: /verifier/build.sh: Permission denied`、`returncode 126`、断言失败。**三臂一致**（cold/our/placebo 的 `graded_attempts.jsonl` 均 reward=0.0、`graded=True`、`error=None`；证据 `container-logs/sb-fix-erlang-ssh-cve-work-{cold,warm}-.../verifier/ctrf.json`）。⇒ 判分器记为「已判 0」而非 `no_env`，故此集对臂间差**中性**，但它是**基建对分**、不是模型能力，须披露。

## 5. placebo 供货来源门（**通过**）

- `plane_mode=placebo` 17/17；donor 环为**三循环** cyber→finance→industrial→cyber，请求方 `family_scope` ≠ 供货 `retrieve_family`（donor），二者从不相等；抽样卡片 `session_id` 属 donor family ⇒ **内容真错配、同形同数（5 卡）**。
- 逐集无「our 与 placebo 容器同名／placebo 容器里已有 our 文件」（本波三侧车独立）。

## 6. 记忆投递座位与投递时延（our/placebo 同构观测）

- 每集 5 张卡：前 4 张走 projection 座、**BM25 严格递减**；**第 5 张由 `_allocate_stateful` 从 provisional 通道追加**（两次都被 `0001-sb-fix-druid-loophole-cve` 占位，分数与前四张不同标度）⇒ **不可把日志里的 `score` 当同一响应内的相关性排序**；第 5 座是否查询无关，本波未定论。
- 投递时延：our 中位 **11.6 ms**／最大 15.7 ms；placebo 中位 **17.4 ms**／最大 25.3 ms（deadline 500 ms，未见 `deadline_exceeded`）。
- recall 门：our 15/16、placebo 16/16 `complete(5)`；our 的 `syzkaller` 被 30 分钟上限杀，runner 打印 `recall=(0)` 是**观测缺口**（转录首条 user 确有 5 张卡），非记忆面缺陷（见作者 `R10-s1-report`／#189）。

## 7. 结论边界

- 上游事实（与我们记忆无关、须写入边界）：`benchflow-ai/skillsbench` 公开仓库含 `tasks/<task>/oracle/solve.sh` 与 `verifier/test_outputs.py`，任务卡 `sandbox.network_mode: public` ⇒ 任何用这套 benchmark 的评测只要容器能出网、agent 想到搜仓库名就能拿 oracle；**该 benchmark 的公开分数天然不可信**。
- 我们的记忆来源集里 10 个合规来源中 6 个是在读过 oracle 的上下文里跑的；投递到模型的卡片文本对 1527 条 oracle 行命中 **0/5（无逐字泄漏）** ⇒ S1 结论只能写「**经验迁移的效力**」，不能写「干净条件下习得的经验」。

## 8. 待用户裁定项

1. **泄漏面三改（下一轮必须一起堵）**：⒜ 容器 `--network none`（堵 A）；⒝ 不把 `<task>/verifier` 挂进 agent 容器（堵 B）；⒞ **把宿主 `bash/read/write/edit` 从被测 agent 工具面里拿掉，或用无仓库读权限的用户跑 agent**（堵 C/E/F —— 本轮新出现，最致命：一次同时暴露 oracle、官方判据、我的评分产物、以及别的臂的产物）。
2. 是否换更强模型（4.7）重跑。
3. 缺口 A/B 与 R7d 扩池上界臂是否纳入下一轮。
4. 分臂协议不对称（cold 并行／暖串行）是否在 harness 里统一。

## 9. 已修复的基建（本轮，作者改＋我独立复核，见 #193）

- 侧车「每臂重建镜像」根因已堵：`build_image` 先 `docker image inspect`，命中则复用并记 `image_built{reused:true}`（探针 8742 实测 `reused=true`、无新构建、已拆）。
- 作者轮询 `pgrep -f` 自匹配致永不退出：新 `wait-bench-runner.sh` 用 pidfile + `kill -0`。

## 10. 受保护资源（本轮未动，勿删）

三臂活侧车 8731/8735/8736、plane 8741（仍载旧码，供读）；暂停的活评测栈（端口 18888/1933/8789/8732/8733、`coforge-openviking-prototype-1`、`coforge` 库）；他人 Up `sb-sf-*`/`sb-slb-*` 容器；`jianghp3-dev-gaia-workspace-1`；`/tmp/sb-daemon-84010b0c`；`river2_0/.codegraph/codegraph.db`（活 MCP）；`river2_0/.worktrees/*`（可能含未合并工作，cm-fact-index 17 GB）。
