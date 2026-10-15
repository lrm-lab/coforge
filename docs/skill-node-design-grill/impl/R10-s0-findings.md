# R10 S0 验证侧中途发现（2026-10-01 16:40，作者交回件尚未到）

**性质**：这是**验证方（我）自己跑出来的一手事实**，不是采信作者报告。等作者交回后并入 `R10-s0-verification.md`。

## 事实 1（决定性）：镜像未预热 ⇒ 首轮工具调用被客户端超时打断

**证据链**：

| 环节 | 事实 | 来源 |
|---|---|---|
| Pi 的全局 fetch 超时 | `DEFAULT_HTTP_IDLE_TIMEOUT_MS=3e5`（**300 s**），被 `configureHttpDispatcher()` 装成 `undici.EnvHttpProxyAgent` 全局 dispatcher | `pi-0851/…/bundle/chunks/chunk-JVUZSMYM.js` |
| 首次 `/env` 触发 `build_image` | `ensure()` → `build_image()` → `docker build`（`skillsbench_env_server.py:251,308`） | 源码 |
| 构建耗时 | `image_built` 记录 `t=1790872387.427` = **16:33:07**；agent 首个 `run_command` 在 16:21 前后 ⇒ 构建 **约 10–12 分钟 ≫ 300 s** | `/tmp/r10-s0/lifecycle-cold.jsonl` |
| 客户端表现 | 转录里 `run_command` **连续三次**返回 `fetch failed`（`{"text": "fetch failed"}`，`isError: true`），第四次调用才落到 `/env` 并等到构建完成 | `results/r10-s0-cold/work-cold/episodes/0001-sb-grid-dispatch-operator/2026-10-01T16-19-42-356Z_*.jsonl` 第 5/7/9 行 |
| 侧车侧表现 | `image_built` × 3（三次重试共用/串行于同一次构建，完成时刻相差 33 ms）＋ `env_created` 仅 1 条（后到者的 `docker run` 撞同名容器） | 同上 lifecycle |
| 代价 | 第 1 回合（16:19:41–约 16:29）全部报废；容器 16:33:08 才起，episode 的 30 min 预算（`limits.agent_timeout=1800`）已被吃掉约 13 分钟 | 时间戳 |

**不是我们适配层的问题**：适配层从未被访问（`recalls-cold.jsonl` 只有 runner 自己那次 turn-0 召回）。**根因在 harness 的取镜像路径**。

**对 S1 的直接影响（必须改）**：三臂若按 cold→our→placebo 顺序跑，**只有先跑的臂**为每个未建镜像的任务付 10–12 分钟 + 一整回合报废的代价，后跑的臂吃缓存 ⇒ **系统性偏袒**。修法：**跑任何臂之前先 `POST /prebuild {"task_ids":[16 个任务]}`**（侧车自带该端点，`skillsbench_env_server.py:499`），把 16 个镜像全部建好并记录各自耗时；构建期间不消耗模型 token。

## 事实 2：侧车归属决定判分方式（我的 brief 有歧义，作者按字面执行）

- `run_arm.sh` 第 19–20 行**无条件 `pkill` 上一个臂的 8731 侧车**，第 24 行 `pkill` plane ⇒ S0 结束时**只有 placebo 臂的侧车活着**。
- 后果：`/verify` 只能由「造出该容器」的侧车进程回答（`episodes` 字典在内存）⇒ cold／our 两臂**官方判分驱动够不到**。
- 任务 `user_simulator` 为 **null** ⇒ runner 永不 `POST /close` ⇒ 没有自动 verify，**判词只在我按键时产生**；也因此**容器不会被提前拆掉**（`docker run -d --rm` 的容器在容器进程活着时一直在）。
- 救援路径（已写好 `/tmp/probes/r10_reseed_verify.py`）：按生命周期日志的 `env_created`（含 `container/image/workdir/limits`）**重新种一个 `EnvServer.episodes` 条目**，调**侧车自己的 `verify()`** —— 判词仍由官方 `test.sh` 在官方容器里产生，只是驱动方换成我；须在报告里披露。
- **S1 必须改成：全波只起一个侧车与一个 plane，跑完不许 kill**（这样官方驱动能覆盖全部三臂，两次配对都能出官方 `memory_gain`）。

## 事实 3：出网与假风险（已排除）

- `grid-dispatch-operator` 的 `verifier/test.sh` **第一行就是 `pip3 install … numpy scipy cvxpy`** ⇒ 判分需公网。
- 侧车没带 `--exec-proxy`，但 `~/.docker/config.json` 的 `proxies.default=http://172.17.0.1:7893` 会在 `docker run`／`exec` 时**自动注入**代理环境变量；我用一次性容器实测：`HTTPS_PROXY=…` 已注入、`python3 urllib` 访问 pypi **返回 200**。⇒ **无假零分风险**。
- 容器内 agent 自己 `pip install numpy scipy` 也成功（exec n=6,7 exit=0）。

## 事实 4（生产读路径的结构性事实，进报告口径）

`HybridRetrievalFacade.retrieve()` 只走 **fork_branch＋projection＋segment_atom(fact)** 三条车道；
`retrieve_historical_subgraphs(view_revision_id, subgraph_id, principal_labels)` 是**按 subgraph_id 点名的诊断查询**（生产只接在 `diagnosis_wiring.py:93` 的故障诊断路径），**不参与查询召回**。
⇒ **R9m 的 10 个子图产物不进检索面**；S0/S1 测到的是「投影（＋fork）车道」。作者适配层里 `channel_counts["subgraph"]` 恒 0 是**结构如此**，不是漏接线，但报告不许写成「我们的图都进去了」。

## 事实 5（我的适配层审读，第一遍）

`retrieval_backend.py` SHA256 `437c9845d1dd0b1a2e675efa5aabba6f1897b1bc949c8f53b28116b1c1ba8c39`（16:18 版，跑批期间可能再变，验收时重取）：
- ✅ 真走生产 `HybridRetrievalFacade` ＋ `ForkBranchAdapter`／`InfluenceProjectionAdapter`／`SegmentAtomAdapter`；`fact_lane_paused=True`；`SegmentAtomAdapter(..., "empty")` ⇒ fact 车道结构上恒空（诚实，但要写进报告）。
- ✅ `space_ids` 作用域：非家庭空间／非 `-shared` 一律 0 条（`_family_shared_scope`／`ISOLATED_SHARED_RE` 与 Go 侧命名 `space-<id>-shared`、`space-<id>-test-N-shared` 对得上）。
- ⚠️ `memory_version` 用 `abs(hash(revision_id)) % (2**31-1)` —— Python 字符串哈希**逐进程随机化**（PYTHONHASHSEED），重启即变，**不是我 brief 要的「我们的修订号（单调）」**；`citation.evidence_batch_id` 放了 `view_revision_id`（可溯源，但语义与字段名不符）。
- ⚠️ `channel_counts["subgraph"]` 硬编码 0（见事实 4）。
- ✅ 16:40:39 作者自行修掉了我探到的 family 命名 bug（Go 侧 `sanitizeID` 出连字符空间 id `space-sb-industrial-physical-systems-shared`，适配层原按裸下划线 family_id 查表 ⇒ 恒 `family_no_memory_coverage`）。新版本见 §事实 11。

## 事实 6：`our` 与 `placebo` **共用同一个容器**（env key 冲突；placebo 因此跑了 our 的解）

- 侧车 env key ＝ `task_id@<episodeDir 末三段>`；两臂的 workdir 都是 `work-warm/episodes/0001-<episode>`（runner 只按 `--arms warm` 命名 `work-warm`）⇒ **key 完全相同**，侧车 `episodes` 字典 first-call-wins ⇒ placebo 拿到 our 的容器。
- **独立取证（三条互证）**：
  1. 容器只有一个：`sb-grid-dispatch-operator-work-warm-episodes-0001-sb-grid-dispatch-operator`，`docker ps` 显示 `Up 6 minutes`——跨 our（16:40:55–16:42:29）与 placebo（16:43:02–16:44:xx）都在。
  2. 容器内 `/root` 同时存在两臂产物：`solve.py`／`make_report.py`（**mtime 16:39**，our 的第一跑）、`report.json`／`sol_*.npy`（**mtime 16:43**，placebo 跑出来的）。
  3. **placebo 转录第 3 个工具调用就是** `cat /root/solve.py; echo '=====MAKE====='; cat /root/make_report.py; …`，随后 `cd /root && python3 solve.py && python3 make_report.py` ⇒ **placebo 的「解」逐字等于 our 的解**（`solve.py` mtime 16:39 早于 placebo 开跑 16:43，placebo 从未写过自己的 solve.py）。
- ⇒ **placebo 臂的 reward 不可归因**；且 `our`／`placebo` 两臂**结构上无法各自独立判分**（见事实 10）。

## 事实 7：`run_arm.sh` 的 `pkill` 模式与实际 cmdline 不匹配 ⇒ **三臂全程共用一个侧车**

- 脚本 `pkill -f 'skillsbench_env_server.py --port 8731'`，真实 cmdline 是 `python3 …/skillsbench_env_server.py --tasks-root … --profile skillsbench --port 8731 …`——`--port` 前还有参数 ⇒ **模式永不匹配**，上一臂的侧车从不被杀。
- 硬证据：`/tmp/r10-s0/sidecar-our.log` 与 `sidecar-placebo.log` **都以 `OSError: [Errno 98] Address already in use` 结束**（新侧车绑不上 8731 直接死），而脚本的 readiness 探活（`curl /verdicts`）**探的是老进程** ⇒ 打印 "sidecar up" 是假阳性。**实际服务三臂的只有 cold 那一个侧车**（pid 1121730，`--log lifecycle-cold.jsonl`）；`lifecycle-our.jsonl`／`lifecycle-placebo.jsonl` 均为 **0 行**。
- plane 那条同理（真实 cmdline 是 `python3 plane_server.py --port 8741`，目录名只在 cwd 里）；作者 16:40:39 已把它改成 `pkill -f 'plane_server.py --port 8741'`，**侧车那条没改**。
- **对事实 2 的更正**：我先前写的「S1 全波只起一个侧车」**不够**——单侧车正是本事实 6 的成因。S1 改为**逐臂各起一个侧车（不同端口）**，见 `R10-s1-brief.md` §0。

## 事实 8：**oracle 在宿主机可读、`/verifier` 在容器内可读**——受测 agent 两面都能拿到答案

- **宿主机面**：`our` 臂转录里有 `bash` 调用 `find … tasks/grid-dispatch-operator/…` 命中 `…/oracle/solve.sh`，紧接着 `read {"path": "…/tasks/grid-dispatch-operator/oracle/solve.sh"}`，**其 `toolResult` 就是 oracle 文件全文**（实测含 `with open('/root/network.json')`／`buses = np.array(data['bus'])`／`pip3 install --break-system-packages numpy==1.26.4 scipy==1.11.4 cvxpy==1.4.2 -q`——`-q` 是 oracle 独有，`verifier/test.sh` 那行没有）。工具面：our＝`{bash:5, read:5, run_command:9, room_send:1}`，**cold＝`{run_command:20}`**（冷臂没碰宿主机工具）。
- **容器面**：`placebo` 转录里有 `cat /verifier/test.sh; echo '=====PY====='; cat /verifier/test_outputs.py`，并自己 `python3 -m pytest /verifier/test_outputs.py -rA -q`。它自己写的 `/logs/verifier/reward.txt` **不影响**侧车 `verify()`（先 unlink 再跑 test.sh）。
- 机制：普通 agent profile（`internal/pi/profile.go:30-41`）`BuiltinToolsEnabled: true, AllowedToolNames: nil` ⇒ 宿主机 `bash`/`read`/`write` 一直在工具面里，容器不是隔离边界。**不是本波引入的**，但它污染的是「记忆是否提升通过率」这个读数本身（见 `R10-s0-verdict.md` §4）。

## 事实 9：镜像缓存有写竞态（同一秒 3 条 `image_built`）

`build_image` 的 `self.lock` 只包住**缓存读**与**构建后写**，构建在锁外 ⇒ 并发首次 `/env` 各自 `docker build` 一遍（S0 lifecycle 16:33:07 同一秒 3 条 `image_built`）。**预热（先 `POST /prebuild`）能规避**；预热用多请求并行安全（`ThreadingHTTPServer`，每请求内部串行）。

## 事实 10：S0 的判分结果与**它的正确读法**

- 官方判分器两配对跑通（`/tmp/r10/grade-s0/`）：pairA(cold+our) 与 pairB(cold+placebo) 均为 `cold 1.0 / warm 1.0 / gain 0.0`，`unjoined_task_ids=[]`、`no_env_created=0`。
- **warm 的那个 1.0 是一次共享 verify**：`verify_started` 计数取证——`before={cold:1}`（作者 16:37:53 那次）→ **pairA 给 work-warm 新增 1 次**（16:44:55，判的是 **placebo 跑完后**的容器，16:45:21 拆容器）→ **pairB 新增 0 次**（命中侧车进程内缓存 `verify_done+verdict`）。
- ⇒ **S0 的数值不是测量**（n=1；warm 那一分由两臂共享；容器状态主要来自 placebo）；它只证明**管道通**：三臂都跑起来、适配层真把卡片送进提示、官方 verifier 真出数、`build_report` 真能算。**`memory_gain=0.0` 不许读成「记忆没用」**。

## 事实 11：作者 16:40:39 的 family 修复（我复核过）

- 新 `_family_from_space`：
  ```python
  def _family_from_space(space_id: str) -> str | None:
      """Runner space ids use hyphens: space-sb-industrial-physical-systems-shared."""
      if not space_id.startswith("space-") or not space_id.endswith("-shared"):
          return None
      inner = space_id.removeprefix("space-").removesuffix("-shared")
      if not inner:
          return None
      if inner.startswith("sb-"):
          return "sb_" + inner.removeprefix("sb-")
      return inner
  ```
- 我**真跑过**三个 family 的真实空间 id（用 `views-r9m45` 实例化 `RetrievalBackend`）：`sb_cybersecurity` 7 条／`sb_finance-economics` 8 条／`sb_industrial-physical-systems` 8 条，`filter_reason=ok`，`channel_counts={fork:0, projection:*}`，耗时 12–20 ms（`deadline_ms=500` 之内）。compliant 修订数＝**3／3／4**。
- 残留口径（进报告）：把 `space-sb-x-shared` 映射回 `sb_x` 是**按约定的启发式**（`"-": "_"` 前缀还原），不是从 Go 侧拿权威 family 表；只要 runner 的 `sanitizeID` 规则或家族命名变化（例如家族名里本来就有连字符：`finance-economics`）它就会错。**唯一稳妥的写法是从 `sb-full.jsonl` 的 `episode_id→family_id` 反查**（同文件已有 `_episode_family_lookup`）——但当前这版能跑，故只记为口径风险，不要求改。

## 事实 12（campaign 级，最严重）：oracle 泄漏不是 S0 独有；**我们记忆的 10 个合规来源集里有 5 个是在"读过 oracle"的上下文里跑出来的**

**扫描口径**（脚本在 `/tmp/probes`，逐条可复算）：`evol_bench/SkillsBench/results/**` 全部 51 份逐集转录（排除 `host-events`／`sb-actions`／`attempts`／`graded_attempts`），对每条 `toolCall` 的 `arguments` 找 oracle 相关路径，取其**配对 `toolResult`（消息级 role，块级 type 是 `text`——我第一版按块级 type 匹配，全落空，假阴性已修）**，并用**磁盘上 oracle 原文的行**（len≥45、非注释）做匹配判定「oracle 原文真的回到了模型上下文」。

**逐 eval 账**（`touch`＝调用里出现 oracle 路径；`content`＝结果里匹配到 oracle 原文）：

| eval | 集数 | touch | **content 确认** |
|---|---|---|---|
| `sb-train-wsb-dsv4flash-r1`（**R9m 语料来源轮**） | 24 | 9 | **7** |
| `sb-smoke-gmsgb-dsv4flash-1` | 6 | 2 | 1 |
| `sb-smoke-local-1` | 6 | 1 | 1 |
| `sb-smoke-par-1` | 6 | 1 | 0 |
| `r10-s0-our`（本波） | 1 | 1 | 1 |
| `r10-s0-cold`／`r10-s0-placebo`／`r10-blockers-*`／`_mechanism` | 8 | 0 | 0 |

- 确认命中样例（原文行回灌）：`sb-train-wsb` 0001 的 `cat tasks/fix-druid-loophole-cve/oracle/solve.sh` → 5611 B 结果含 oracle 原文（10/10 行命中）；0003 `software-dependency-audit` 10527 B；0006 `xlsx-recover-data`；0008 `adaptive-cruise-control`；0011 `hvac-control`；0012 `energy-market-pricing`；0014 `dynamic-object-aware-egomotion`；`sb-smoke-local-1` 0002 `dialogue-parser/oracle/solution.py` 8677 B；`sb-smoke-gmsgb` 0001 `court-form-filling` 5074 B；`r10-s0-our` 0001 7153 B。
- **与我方记忆的关系（决定性交集）**：`views-r9m45/report.json` 的 compliant 集＝**10 集**；其中 **5 集**（`0001-sb-fix-druid-loophole-cve`／`0003-sb-software-dependency-audit`／`0006-sb-xlsx-recover-data`／`0008-sb-adaptive-cruise-control`／`0014-sb-dynamic-object-aware-egomotion`）**有确认的 oracle 原文回灌**；另 1 集（`0004-sb-reserves-at-risk-calc`）**尝试**过读 oracle 但结果里未见原文（0/10 行）。⇒ **我们整条记忆链的"经验"有一半来自读过官方答案的会话**。
- **但卡片正文没有逐字 oracle 内容（我实测）**：S0 our 臂提示里那 5 张卡（179–300 字）对 **1527 条 oracle 行**（10 个合规来源任务的全部 oracle 文件）命中 **0/5**；标识符级（≥8 字符）重叠 14 个，逐一核对**全是领域通用词**（`required`／`commitment`／`constraints`／`feasible`／`operating`）或**任务自身的文件名**（`pred_dyn_masks`／`pred_instructions`，出自该任务 task 描述而非仅 oracle）。⇒ **泄漏发生在"来源集的经历"这一层，不发生在"投递给模型的卡片文本"这一层**；语义级的 oracle 形状（解题套路）无法用词法排除。
- 卡片实际长相（供报告引用，来自 S0 our 臂）：`Agent inspects network data, installs pandapower/pypower, … runs AC OPF … total cost about 565220 $/hr`（另一个电力任务的**数值性经验**）、`Agent gathers commitment, ramp, startup-cost … hits permission issues; confirms run_command as root in /root`（环境怪癖类经验）。**这类内容正是"经验迁移"该有的样子**，也说明卡片确实携带跨任务 know-how。
- **容器侧 `/verifier` 的归属也定了**：不是官方镜像自带（`tasks/*/environment/Dockerfile` 里没有 COPY verifier），而是**我们侧车在 `/env` 时 bind mount**的（`skillsbench_env_server.py:7-8, 320-323`，设计意图是防篡改、副作用是 agent 可读）⇒ 这条要堵只能动 harness。
- **可修性（作者探针，未实测）**：Pi **没有** `unregisterTool`；但 extension 可用 **`pi.setActiveTools(names)`**（`loader.js:331-334` → `agent-session.js:659-672`，下一 turn 生效）把 `bash`/`read`/`write`/`edit` 从活跃面摘掉，或用**同名 `registerTool` 覆盖**（`agent-session.js:2155-2158`，extension 后 set 覆盖 builtin）。现生成器（`skillsbench_extension_gen.py`）**从未**调用 `setActiveTools`；harness 侧 `profile.go:30-40` 的 `BuiltinToolsEnabled: true` 是根因。⇒ **修法 ⒝ 有抓手但不保证**（bench-runner 是否每 turn reload 扩展、`includeAllExtensionTools` 会不会把 builtins 加回，需改生成器后跑 1 集实测）。
