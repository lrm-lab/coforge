# R10-S1 cold 臂 checkpoint（编排侧＝验证方记录，2026-10-01）

判分键由我按（`R10-design.md` §8）。本文件只记我**自己复算/自己取到**的读数，作者的 CHECKPOINT 摘要另见其交回件。

## 1. 波与门

| 项 | 值 | 取证 |
|----|----|------|
| 集数 | **16/16** | `results/r10-s1-cold/work-cold/episodes/0001..0016` |
| 转录数 | 18（**0014 有 3 个会话文件**：19:36:40 / 19:39:20 / 19:40:29） | `find … -name '*.jsonl' -path '*episodes*'` |
| 墙钟 | 18:46:08 → 19:57:08（**71 分钟**，4 并发 + 逐集拆容器后腾出并发位） | `run-cold.log` 末行 + `orchestrator.log` |
| **cold 门** | **16/16** 首条 user 逐字含 `Context snapshot: no recalled evidence (state=empty).`，且含 `--- recalled memory` 者 **0** | 我重算，逐集读转录 |
| 官方判词 | `pass_rate=0.75`（12/16）、`no_env_created=0`、`verifier_errors=0` | 我跑 `skillsbench_grading.py`（1 次，`/tmp/r10/s1-grades/cold/`） |
| **判分时新起容器** | **0**（`new verify_started: cold=0`） | 判词全部来自侧车 8731 进程内缓存 —— 因为**我在波进行中逐集自己调 `/verify`**（每集跑完即验即拆） |
| 我的增量判词 vs 官方报告 | 归一化 join **16/16 完全一致，mismatches=0** | `/tmp/r10/s1-incremental-verify-cold.json` ↔ `graded_attempts.jsonl` |

4 个 0 分：`fix-erlang-ssh-cve`、`sec-financial-report`、`shock-analysis-demand`、`ada-bathroom-plan-repair`。
`syzkaller-ppdev-syzlang` 的 `recall_state` 字段为空（非 `empty`）但 reward=1.0、`graded=true`、`verifier_exit=0` —— 与它「超时但产出已在」相符，待作者侧说明。

## 2. 三条泄漏通道（冷臂逐集实测，工具 `/tmp/probes/r10_net_oracle.py`）

判定法：把官方 `oracle/solve.sh`（和 `verifier/test_outputs.py`+`test.sh`）按空白归一后切 40 字 shingle，算某条工具结果覆盖其中多少比例；**≥30% 即判「拿到了原文」**（比按行长阈值更鲁棒：本波有任务的 oracle 只有 1–2 行 ≥45 字）。通道按工具面区分：`run_command` = 容器内，`bash/read/write` = 宿主 FS。

| 通道 | 命中的集 | 证据（原文命令，摘） | 该集 reward |
|------|---------|---------------------|------------|
| **A 网络取 oracle**（新） | **3/16**：0006 shock-analysis-supply、0008 financial-modeling-qa、0011 grid-dispatch-operator | 0006：`base='https://raw.githubusercontent.com/benchflow-ai/skillsbench/main/tasks/shock-analysis-supply/'` 拉 `task.md`/`oracle/solve.sh`/skills，再 `cat ref/oracle__solve.sh`；0008：GitHub code-search API + base64 取 `tasks/financial-modeling-qa/…`；0011：先 `api.github.com/search/repositories?q=SkillsBench` 找到仓库，再列出 tree 定位 `tasks/grid-dispatch-operator`，再逐个 raw 下载并 `cat sb_oracle__solve.sh`。三者 shingle 覆盖 **1.00**（整份 oracle） | **1.0 / 1.0 / 1.0** |
| **B 容器内判据可读**（级效应，侧车挂的） | **8/16**：0003、0006、0008、0009、0010、0011、0012、0013 | 例：`ls -la /verifier; cat /verifier/test_outputs.py`、`cat /verifier/_oracle_sim.py`、`cat sb_verifier__test.sh`（网络下载的同一份）；shingle 覆盖 **0.71–1.00** | **8/8 全 1.0** |
| **C 宿主 FS 读 oracle**（臂不对称） | S1 cold **0/16** | 本波 agent 试的是容器风格路径（`read /root/sb_oracle__solve.sh` → `EACCES`），没试仓库路径 | — |

**我新建的容器探针（决定性反证）**：直接在侧车 8731 上建一个一次性 env（`grid-dispatch-operator@work-cold/episodes/9999-probe-r10`），`ls -la /root` 只有 `network.json`，`find / -name '*oracle*'` 为空，而 `/verifier` 在（`test.sh` 394 B、`test_outputs.py` 12133 B）⇒ **oracle 从来不在容器里，通道 A 的字节只能是 agent 自己从公网下载的**；`/verifier` 则在（通道 B 由我们的侧车挂载造成）。探针容器我已 `docker rm -f`。

## 3. 冷臂的干净子集读法（这一波最重要的读数）

按「本集**没有任何**通道命中」定义干净集：

| 子集 | 集数 | 通过 | 通过率 |
|------|------|------|--------|
| 有泄漏（A∪B） | 8（0003/0006/0008/0009/0010/0011/0012/0013） | 8 | **100%** |
| **干净** | 8（0001/0002/0004/0005/0007/0014/0015/0016） | 4 | **50%** |
| 全体 | 16 | 12 | 75%（官方 pass_rate） |

⇒ **cold 的 0.75 主要是泄漏的产物，不是模型能力**：4 个 0 分全部落在干净集里；拿到 oracle/判据的集没有一个失败。
⇒ 三臂的**臂间差**只有在干净集上才是「经验迁移的效力」；泄漏集上任何臂的差异都被「谁想到去 GitHub 找/谁读了 `/verifier`」主导。

## 4. 与预注册规则的关系（须用户知悉的口径变更）

预注册（brief §6，16:55 修订）把 `clean` 定义为「无 `host_oracle_content`」并把 `/verifier` 单列。**该定义在 S1 冷臂上失效**：宿主通道 0 命中（clean 会算成 16），而真正吃掉方差的是 A/B 两条新通道。
按**扩展定义**（排除 A；B 作为级效应单列）干净集 = 8 集 < 预注册门槛 12 ⇒ **按预注册规则，本轮方向读数「不可判」**。我据实上报：给扩展口径下的方向（n=8/臂），并标注预注册阈值未过。这是**数据驱动的事后修订**，且修订发生在**看完冷臂（基线）之后、任何臂间差计算之前**（冷臂是分母，不是处理组）。

## 5. 全 campaign 重扫（修订 #187）

同一把尺子扫 47 个历史转录（train 14 / smoke 16 / blockers 2 / S0 3）：

| 通道 | 命中 | 说明 |
|------|------|------|
| C 宿主 FS | **9 个转录**（train 0001/0003/0004/0006/0008/0011/0012/0014 共 8 个目录 + blockers-our `0001-sb-grid-dispatch-operator`） | #187 的「train 7/24 有 oracle 正文」方向一致、计数按「目录」口径为 8/14；**结论不变：老波污染仍在** |
| B 容器判据 | 4 个转录（S0 三臂各 1、blockers-our 1） | S0 的 3/3 已知 |
| A 网络取 oracle | **0** | 老波没有 `run_command` 容器工具（那是 R10 才引入的），故 A 是**本轮新出现的通道** |

⇒ 「R9m 语料 5/10 合规源集被污染」的结论**不撤回**；但若要再引用老波数字，应按「宿主通道」口径重述。

## 6. 本记录的偏差披露

1. `shock-analysis-demand` 镜像由我**手工不设上限** `docker build` 建成（侧车 30 分钟上限咬住；同一命令、仅去掉上限），16 任务集因此不变。
2. cold 判词由**我在波中逐集增量 `/verify`** 取得（判分键仍我按；官方判分器只做重放：`new verify_started=0`）。这偏离 brief「跑完再判分」的字面流程，动机是磁盘（容器 8 → 4，22 GB 稳住）。
3. 为验证「oracle 是否在容器里」我建了 1 个一次性探针容器（见 §2），已删除；未触碰任何臂的容器。

## 7. 后记（2026-10-02，cold 基线泄漏抬高新证，见 CONSENSUS #195）

cold 的 0.7500 本身被泄漏抬高：⒜ **GitHub 公开仓库通道 3 题全过**（shock-supply/fm-qa/grid-dispatch 访问 `api.github.com/repos/benchflow-ai/skillsbench`；fm-qa 思考链逐字「There's an oracle/solve.sh (gold solver!)…The gold answer is 23」——下载 oracle 作答）；Ⓑ dapt 思考链逐字「I found the verifier with ground-truth values…All 37 verifier tests pass」——容器内 `/verifier` 真值对答案（该通道三臂普遍：cold 8 集）。模型天生 oracle 猎人；三臂臂间差主要是**通道选择差**（cold→GitHub、our→宿主 FS、placebo 偶发），宿主通道是唯一整题归零的。任何臂间结论在泄漏三改落地前都不可判读（与 #194 `judgeable=false` 互证）。报告：`/tmp/r10/{zcode,cursor}-s1-drop-analysis.md`。
