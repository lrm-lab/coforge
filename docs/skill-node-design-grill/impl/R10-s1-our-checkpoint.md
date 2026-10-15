# R10-S1 our 臂 checkpoint（编排侧＝验证方记录，2026-10-01/02）

判分键由我按（`R10-design.md` §8）。本文件只记我自己复算／自己取到的读数。cold 臂见 `R10-s1-cold-checkpoint.md`。

## 1. 波与门

| 项 | 值 | 取证 |
|----|----|------|
| 集数 | **16/16** | `results/r10-s1-our/work-warm/episodes/0001..0016` |
| 墙钟 | 21:23:45 → 23:44（**2 小时 20 分**，串行；cold 4 并发 71 分钟） | `run-our.log` 末行 |
| **recall 门（我的判据：读转录，不读 runner 打印）** | **16/16 通过**：每集首条 user 消息 5 张卡、家族空间正确（cyber 4／finance 5／industrial 7 各自 `space-<family>-shared`）、无 `empty` 标记 | `/tmp/probes/r10_recall_gate.py` |
| `recall=empty(0)`（#178 静默退化） | **0 次** | `run-our.log` |
| 官方判词 | **`pass_rate = 0.4375`（7/16）**、`no_env_created = 1`、`verifier_errors = 0` | 我跑 `skillsbench_grading.py`（`/tmp/r10/s1-grades/our/`） |
| **判分时新起容器** | **0**（`new verify_started: cold=0 warm=0`）⇒ 16 条判决全部来自侧车 8735 进程内缓存 | 同上 |
| 我的增量判词 | 15 条（15 集有容器）；第 16 集无容器 ⇒ 官方按 `no_env_created` 记 0.0/`graded=False` | `/tmp/r10/s1-incremental-verify-our.json` |

7 个 1.0：`sec-financial-report`、`financial-modeling-qa`、`invoice-fraud-detection`、`manufacturing-fjsp-optimization`、`grid-dispatch-operator`、`drone-planning-control`、`3d-scan-calc`。
8 个 0.0：`fix-erlang-ssh-cve`、`syzkaller-ppdev-syzlang`、`dapt-intrusion-detection`、`suricata-custom-exfil`、`shock-analysis-demand`、`manufacturing-codebook-normalization`、`ada-bathroom-plan-repair`、`r2r-mpc-control`。
1 条**基建杀**（单列，不并入 0 分）：`shock-analysis-supply` 整集没建容器。

### 1.1 `recall=(0)` 是 harness 观测缺口，不是记忆面缺陷（已证）
`syzkaller-ppdev-syzlang` 的 runner 行是 `recall=(0) output=nil failed (PI_CANCELLED: context deadline exceeded)`。**我直接读该集转录**：首条 user 消息含 5 张卡、`--- recalled memory` 段、`space-sb-cybersecurity-shared` ⇒ 注入正常；被 30 分钟上限杀掉的会话无法回读状态字符串。cold 的同名任务同一现象（`recall_state=""`）。**故门的判据以转录为准。**

## 2. 方向读数（官方判词，两臂配对）

| 子集 | n | cold | our | **our − cold** |
|------|---|------|-----|----------------|
| 全样本 | 16 | 0.7500 | 0.4375 | **−0.3125** |
| 修正干净集（排除 A∪C） | 11 | 0.8182 | 0.3636 | **−0.4545** |

修正干净集 11 题上**五处翻转、全部是「cold 过 → our 不过」**：`dapt-intrusion-detection`、`suricata-custom-exfil`、`syzkaller-ppdev-syzlang`、`manufacturing-codebook-normalization`、`r2r-mpc-control`；另有 `ada-bathroom-plan-repair` 两臂都 0、`fix-erlang-ssh-cve` 两臂都 0。**反方向翻转 0 处**（our 唯一相对 cold 的 1.0 增益 `sec-financial-report` 落在被排除的宿主 oracle 污染集里）。

**协议不对称的方向对本次读数不利**：cold 走 4 并发（资源争用），our 走串行（独占机器）⇒ 若协议有偏，应该偏袒 our；实测 our 更低 ⇒ **负向读数不能由调度协议解释**（这条写进结论边界）。

## 3. 泄漏盘账（our 臂，两把尺子互证）

| 通道 | our | cold | 判据 |
|------|-----|------|------|
| **A 网络取 oracle**（容器出网拉公开仓库） | **0/16** | 3/16 | 40 字 shingle ≥30% |
| **B 容器内读 `/verifier`**（侧车挂载） | 3/16（`fjsp`/`grid-dispatch`/`drone`，ver_frac 0.96–1.00） | 8/16 | 同上 |
| **C 宿主 FS 读仓库 oracle** | **4/16** = `sec-financial-report`/`shock-analysis-supply`/`shock-analysis-demand`/`financial-modeling-qa`，`oracle_frac h=1.00`（整份原文） | 0/18 转录 | 字面串 `vendor/skillsbench-official/tasks` 0/18 vs 4/16 ＋ shingle 内容双证 |
| **E 读别的臂的产物**（顺序跑的次生缺陷） | 2/16：`shock-analysis-supply`、`shock-analysis-demand` 读了 `/tmp/r10-s1/container-logs/…-work-cold-…/verifier/{reward.txt,test-supply_modified.xlsx}` | —（cold 是最先跑的臂，无此面） | 工具入参含 `container-logs/` |

**四个宿主 oracle 集恰是 5 个 finance 任务里的 4 个**，且是 our 唯一的「读答案」路线。

### 3.1 finance 家族逐题（两臂数字相同、构成完全不同）
| 任务 | cold | our | 原因 |
|------|------|-----|------|
| sec-financial-report | 0.0 | **1.0** | 宿主 `cat oracle/solve.sh`（思考链逐字：「the oracle solve.sh is the reference solution… Reading it tells me the exact method」） |
| shock-analysis-supply | 1.0 | **0.0** | 全在宿主干 ⇒ 无容器 ⇒ `no_env_created`（交付物写在宿主 episode 目录） |
| shock-analysis-demand | 0.0 | 0.0 | 宿主 `cp …/oracle/answer_demand.xlsx` 到宿主目录，判据在容器里读不到 |
| financial-modeling-qa | 1.0 | 1.0 | 两臂都 1.0（our 也读了 oracle 与判据） |
| invoice-fraud-detection | 1.0 | 1.0 | our 走容器 `/verifier` |
| **合计** | **3/5** | **3/5** | **our 的 +1 来自宿主读 oracle、−1 来自宿主路线导致无容器** |

⇒ **our−cold 的 finance 差是「泄漏路径差」的产物，不是经验迁移的效力。**

## 4. 预注册规则的结果（须用户知悉）

按 #188/#190 的规则：strict-clean ＝ 没有任何臂用过 A 或 C。实测 A(3) ∪ C(4) = **5 题**（交集 2 题：`shock-analysis-supply`、`financial-modeling-qa`）⇒ strict = **11 题 < 12** ⇒ **按预注册规则，本轮方向「污染下不可判读」，只给方向**。数字照给（见 §2），阈值未过照标。

## 5. 记忆投递座位（附带发现，供下一轮修）

`recalls-our.jsonl` 每集 5 张卡：**前 4 张**是 projection 通道 verified 座、BM25 严格递减；**第 5 张**由 `retrieval_facade.py:1899-1929` 的 `_allocate_stateful` 从 provisional 通道追加在自己后面，**其分数与前四张不同标度**（`shock-analysis-supply` 第 5 座 13.6 > 首座 10.2）。⇒ **不能把日志里的 `score` 读成同一响应内的相关性排序**。投递时延 10.9–15.2 ms（deadline 500 ms）。

## 6. 本记录的偏差披露

1. **磁盘地板口径变更**：15 GB → 8 GB。根因：侧车在每个 episode 首次 `run_command` 时**重建该任务的 `sbbench-<task>` 镜像**（`skillsbench_env_server.py:270` 裸 `docker build`；lifecycle-our 的 `image_built` 与 `env_created` 同刻），重建期间「旧镜像＋新镜像＋build cache」瞬时占 ~3 GB，15 GB 地板会把正常的构建误报成卡点（22:33 触发过一次）。**我只清了自己的资产**：`docker rmi` 掉 our 臂已判完的 4 个镜像（判词已缓存）；**没做**共享清理（`docker system df` 报 97.6 GB reclaimable，绝大多数是别人 campaign 的镜像，删了可能不可重建）。
2. **作者在段执行中改了 `run_segment.sh`**：our 段退出时报 `line 253: unexpected EOF while looking for matching "`，就是运行中被编辑导致的（改后的文件自己 `bash -n` 通过，段尾等待已去掉）。**未影响已启动的 runner 调用**，但属流程违规，已要求下段改在段间改。
3. **我 kill 了作者的三个轮询进程**（2169755／2191727／2487691）：它们的 `pgrep -f '/tmp/bench-runner.*r10-s1-our'` 会匹配到自己的 cmdline（自匹配），runner 结束后永不退出；只影响汇报，不影响波。
4. 我手工建了 1 个一次性探针容器（cold 段，`…/episodes/9999-probe-r10`），已删；未触碰任何臂的容器。
5. **`cursor-agent` CLI 在 23:4x 被自动升级**（`2026.09.28-64d2043` → `2026.10.01-14929f9`），新版不接受 `--use-system-ca`，我改用它接受的 `-p -f` 调用；派发信息不变。

## 7. 机制假设（**推断，未证因果**，留给下一轮）

- our 的 finance 卡片逐字含「怎么找答案」的行为描述：`Agent searches for task assets, recovers from an early fetch failure, reads task/oracle/verifier materials…`／`input: Task prompt and filesystem/tool access`／`Agent validates Answer sheet against verifier expectations.` ⇒ 假设：**卡片把「去宿主找材料」当成经验传给了下一集**。但我在思考链里**找不到「因为记忆卡这么说」的直接引用**，且 cold 臂 agent 同样去找 oracle（走 GitHub）⇒ 可确证的是**路线差**、不能确证「卡片→路线」。
- 负迁移的两个候选机制（都只有线索、未定论）：⒜ 卡片大量是**失败叙事**（cyber 卡：「Agent fails to install/run Trivy…」「fetch failed tool-plane outage」「no /root access」），可能把模型推向「这环境干不成」——与 our 的 cyber 三题（dapt/suricata/syzkaller）全 0、以及 `r2r-mpc-control` 只用 203 s 就失败（cold 用了 1046 s 且通过）相符；⒝ 卡片让 agent 先做「侦察」（卡片里就有 `environment and template reconnaissance`）并在宿主面上消耗预算。**两条都需下一轮用「卡片内容消融」（例如只投递 outcome 不投递 behavior 描述）来分离。**

## 8. 后记（2026-10-02，掉分根因合并分析，见 CONSENSUS #195）

§7 的机制假设经双方独立分析（ZCode + cursor-agent）细化为：our 的 −0.3125 ＝ **宿主路线偏航**（全臂量化：宿主工具均值 13.6 vs cold 1.5、容器内 14.8 vs 39.4；shock-supply 铁证 `bash`×41/`run_command`×0 ⇒ no_env_created 记 0）＋ **三题实质近失**（r2r 6 测过 5 仅挂 `test_linearization_correctness`——203s 是快而自信的错解、非早退；suricata 12 过 11；dapt 37 过 20）＋ our 段 `fetch failed` 30 次 vs cold 3 次的工具面不稳。H2（卡片负迁移）降为弱：our−placebo=0 且思考链无「因卡片而…」引用。§7 的内容消融建议保留为下一轮。报告：`/tmp/r10/{zcode,cursor}-s1-drop-analysis.md`。
