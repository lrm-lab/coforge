# R10-S0 验收件（验证方＝我；2026-10-01 16:47）

**一句话**：S0 的**管道三臂跑通、五道门全过**；但 **S0 的数值不是测量**（n=1＋warm 那一分被两臂共享），而且它暴露了**三条必须在 S1 前改掉的协议缺陷**与**一条要用户裁定的读数污染**。

- 上游：`impl/R10-s0-brief.md`（派发件）／`impl/R10-s0-findings.md`（我的 11 条一手事实，本件的事实底座）／#184（规模裁定）。
- 关系：**S0 的五道门证明接缝通，是 S1 的准入门槛；S0 的 `memory_gain` 不进任何结论**。
- 判分键由我按（`R10-design.md` §8）；作者未判分，符合派发件。

## 1. 执行事实（时间线，全部来自 lifecycle 日志与容器实测）

| 时刻 | 事件 | 证据 |
|---|---|---|
| 16:19:41–16:29 | cold 臂第 1 回合报废（`fetch failed` ×3，等镜像构建 10–12 min） | cold 转录第 5/7/9 行；事实 1 |
| 16:33:07 | `sbbench-grid-dispatch-operator` 镜像建成（同一秒 3 条 `image_built`＝缓存写竞态） | `lifecycle-cold.jsonl`；事实 9 |
| 16:33:08 | cold 容器 `…-work-cold-…` 建立 | 同上 |
| 16:37:21 | work-warm 容器建立（our 臂**第一跑**，16:35–16:38） | 同上 |
| 16:37:53→16:38:16→16:38:17 | cold `verify_started→verdict(reward 1.0, graded, verifier_exit 0)→container_removed` | 同上 |
| 16:40:39 | 作者自查并修掉 family 命名 bug（`retrieval_backend.py`）＋改 plane 的 pkill 模式（`run_arm.sh`） | mtime／diff；事实 11 |
| 16:40:55–16:42:29 | our 臂**第二跑**（94 s，`recall=complete(5) output=yes success`） | `run-our.log`／`attempts.jsonl` |
| 16:43:02–16:44:xx | placebo 臂（复用**同一个容器**；读到 our 的 `solve.py` 并执行） | 事实 6 |
| 16:44:55→16:45:20→16:45:21 | 我这轮唯一的 warm `verify_started→verdict(1.0)→container_removed` | lifecycle |

**侧车实况**：4 次侧车启动、**只有第 1 次（cold 的 pid 1121730）绑上 8731**，其余 3 次 `EADDRINUSE` 即死（事实 7）；plane 8741 在 our 修好后按臂重启过。⇒ **三臂实际上共用 cold 那一个侧车**，这是事实 6（容器复用）的前提。

## 2. 五道硬门（我自己取证，逐条给路径）

| 门 | 判据 | 结果 | 证据 |
|---|---|---|---|
| ① cold 空态自证 | 首条 user 含 `Context snapshot: no recalled evidence (state=empty).` 且 0 张卡 | **过** | cold 转录首条 user（len 1711，命中 1 次，`--- recalled memory` 0 次） |
| ② our 非空自证 | 首条 user 含 `--- recalled memory` 段且 family 与任务一致 | **过** | our 转录首条 user（len 4033，`--- recalled memory` **5** 段，全部 `source=space-sb-industrial-physical-systems-shared`＝任务本家族） |
| ③ 三臂都跑完并产出 | 三个 `attempts.jsonl` 各 1 行、`success`、有输出 | **过** | `results/r10-s0-{cold,our,placebo}/attempts.jsonl`；`run-*.log` 尾部 |
| ④ 官方 verifier 出数＋`build_report` 能算 | 官方判分器端到端跑通、`memory_gain` 出得来 | **过（但读数无效，见 §3）** | `/tmp/r10/grade-s0/`：`pairA_cold_our/grading_report.json`、`pairB_cold_placebo/grading_report.json`、`r10-grading-summary.json` |
| ⑤ 形状门（placebo） | 与 our **同形同数**、供货 family 是**另一个** | **过** | our 5 张（`{fork:0,projection:5,subgraph:0}`，family=industrial）；placebo 5 张（同结构，`placebo_donor_family=sb_cybersecurity`，卡片正文含 cyber 语料如 `Agent runs arrow fuzzer…`） |

**一个要写进报告的口径缺陷（不是错，但会被误读）**：适配层给每张卡打的 `source_space_id` 是**请求方的空间**（`family_space`），**不是供货方的** ⇒ placebo 臂的提示里也写着 `source=space-sb-industrial-physical-systems-shared`，而正文来自 cyber。判据：`retrieval_backend.py` 的 `RecallItem(source_space_id=family_space, …)`。**报告不许用提示里的 source 字符串去判断 placebo 的供货 family**，只能用 plane 日志的 `placebo_donor_family`。

## 3. 判分结果与它的正确读法

| 配对 | cold | warm | `memory_gain_warm_minus_cold` |
|---|---|---|---|
| pairA（cold＋our） | 1.0（1 集） | 1.0（1 集） | 0.0 |
| pairB（cold＋placebo） | 1.0（1 集） | 1.0（1 集） | 0.0 |

`unjoined_task_ids=[]`、`no_env_created=0`、`verifier_errors=0`（两配对一致；cold 两次判词逐字相同）。

**为什么这两行不是测量**：
1. **n=1**，且该任务 `difficulty=medium`、官方 oracle 亦满分——天花板效应下 0.0 无信息量（#182 已记过同一现象）。
2. **warm 只有一次真 verify**：`verify_started` 计数 `{cold:1}`（16:37:53，作者）→ **pairA 新增 1 次**（16:44:55）→ **pairB 新增 0 次**（命中进程内 `verify_done+verdict` 缓存）。两臂共享同一容器 ⇒ 结构上不可能各出一分。
3. 那次唯一的 warm verify 判的是**placebo 跑完后的容器状态**（16:45:20 出词），而 placebo 的解来自 our 的文件 ⇒ **这一分既不能归 our 也不能归 placebo**。

**⇒ S0 的交付物是「准入门槛通过」，不是「方向」。** 任何 `记忆有用/没用` 的措辞都不许从 S0 出。

## 4. S1 前置：三条必修（已写进 `R10-s1-brief.md` §0）

1. **逐臂独立侧车（不同端口）**：env key＝`task_id@work-warm/episodes/<seq>-<ep>` 在 `our`/`placebo` 完全同名，单侧车必然让两臂共用容器（事实 6）。改法：cold→8731／our→8735／placebo→8736，各自 extension 的 `--env-url` 与 runner 的 `--sidecar-url` 一起换；**全程 3 个侧车都活着**（判分要用）。
2. **逐臂判分后即拆容器，再跑下一臂**：`/verify` 会 `docker rm -f`；本波把「作者跑臂 → 我判分 → 下一臂」串起来，既拿到**每臂独立**判词，又把容器数封在 16 个以内（磁盘 51 GB 可用，每容器写层 ~770 MB）。
3. **预热 16 个镜像**：`POST /prebuild`，**用 3 个并发请求**（`ThreadingHTTPServer`，每请求内部串行）打散 16 个 task_id；现在只有 1/16 镜像在位（`grid-dispatch-operator`）。**没预热就跑，先跑的臂亏一整回合**（事实 1）。

另：**不许再用 S0 的 `run_arm.sh`**（`pkill` 模式不匹配，事实 7）；`--batch-parallelism` 保持默认 4。

## 5. 要给用户裁定的一条读数污染（不是本波引入）

**受测 agent 能拿到答案的两面**（事实 8）：宿主机侧 `bash`/`read` 可读 `tasks/*/oracle/solve.sh`（our 臂**实测读了**，oracle 全文进了转录）；容器内侧可读 `/verifier/test_outputs.py`（placebo 臂**实测读了还自己跑了一遍**）。

- 影响面：**可用性三臂相同**（同一 profile：`BuiltinToolsEnabled: true`），**使用行为不同**（our 用了宿主机 `bash`/`read`，cold 只用了 `run_command`，placebo 只用了 `run_command`）。⇒ 臂间差会被**污染**，且这一路污染**偏向"翻过环境的那个臂"**（S0 里就是 our）——即**偏向暖臂**。
- **两条泄漏的方向不同，不许混为一谈**（我据审计器实测修正）：⒜ **宿主机 oracle＝臂间不对称**（机会相同、使用不同；S0 只有 our 读了原文）⇒ 会把臂间差推向"读过的那一臂更好"；⒝ **容器内 `/verifier` 可读＝水平效应**（S0 三集 **3/3** 都读了）⇒ 把**各臂通过率一起抬高**，从而把臂间差**压向 0**（天花板压缩）。两者叠加：S1 的臂间差既可能被抬（⒜）也可能被压（⒝），所以必须**先登记后读**、分开报（`R10-s1-brief.md` §6）。
- 我这一轮**不改 harness**（Go 侧 profile 与 vendored 任务目录都不动）。S1 采取**先登记后读**：逐集审计工具面与 oracle/verifier 触碰，报告里给**全样本**与**干净子集**（该集三臂都没碰 oracle/verifier）两组数；若干净子集 <12/16，S1 只给"不可判读"结论并等用户裁定。
- 三条可选修法（**都要用户点头**，我不擅自动）：⒜ 收紧 Pi 的 builtins（Go 侧 profile 的 `BuiltinToolsEnabled`，须改 harness）；⒝ 让 `--extension-file` deny `bash`/`read`/`write`／`edit`（**作者探针已找到抓手**：`pi.setActiveTools(names)` 或同名 `registerTool` 覆盖，见 `R10-s0-findings.md` 事实 12；**未实测**，需改生成器后跑 1 集验证）；⒞ 只做审计不做限制，把「干净子集」当主读数。
- **另加一条 campaign 级的量**（`R10-s0-findings.md` 事实 12）：这不是 S0 才有的——`sb-train-wsb`（我们记忆的语料来源轮）**24 集里 7 集确认 oracle 原文回灌**，`views-r9m45` 的 10 个合规来源集里 **5 个**在其中；**但**投递到模型的卡片文本对 1527 条 oracle 行命中 **0/5**（无逐字泄漏）。⇒ 结论只能写成「**经验迁移的效力**」不能写成「**干净条件下习得的经验**」。

## 6. 不许从 S0 得出的话（进报告口径）

- 不写「记忆无用」：`memory_gain=0.0` 来自 n=1＋天花板＋共享判词（§3）。
- 不写「我们的图都进检索了」：`retrieve()` 只有 fork／projection／fact 三条车道，**子图不在查询召回路径**（`R10-s0-findings.md` 事实 4）。
- 不写「placebo 臂验证了同形同数」以外的行为结论：placebo 的解是 our 的（事实 6）。
- 不把 16:37:53 的 cold 判词说成「本轮判分」：它是作者在 16:38 按的，我这轮两配对都复用了它的缓存（缓存逐字一致，我已断言）。

## 7. 作者交回件逐条核对（`impl/R10-s0-cursor-raw.log`＋`impl/r10_memory_plane/R10-s0-report-2026-10-01.md`）

**它的门 ①②③⑤ 与我的独立取证一致**（our 5 段卡片、cold `state=empty`、`space_ids` 过滤、placebo 供体 `sb_cybersecurity` 各 5 条）。**三处自述与实测不符**（不影响门，但影响 S1 该改什么）：

| # | 它的写法 | 实测 | 证据 |
|---|---|---|---|
| 1 | 「每臂新 8731 sidecar」 | **3 次启动全部 `EADDRINUSE` 即死**，服务三臂的是 cold 那一个侧车 | `sidecar-our.log`／`sidecar-placebo.log` 尾部；`lifecycle-our/placebo.jsonl` 均 0 行 |
| 2 | 「冷容器已因每臂新 sidecar 被替换，无法再 `/verify`」 | cold 容器是**被它自己 16:37:53 那次真 verify 拆掉的**（`verify_started→verdict→container_removed` 16:38:16/17），不是被替换；且判词可从侧车缓存复用 | `lifecycle-cold.jsonl` |
| 3 | 「未执行 `skillsbench_grading.py`（故无 memory_gain 数）」 | **它跑了**：`/tmp/r10-s0/grade-cold.log`（16:38）就是官方判分器对 cold 单臂的输出（`memory_gain_warm_minus_cold: null`） | 该文件内容与 `skillsbench_grading.py` 的输出协议一致 |

- 它的「未能回答」两条我认同并已解：⒜ 「三臂同时保留可 `/verify` 容器与单侧车互斥」→ 正解是**逐臂独立侧车＋逐臂判分后即拆**（S1 §0.2／§0.3）；⒝ 「未压测 `deadline_ms=500`」→ 我的探针实测召回 12–20 ms，S1 里逐集记 `retrieve_elapsed_ms` 分布即可。
- **它对 `our` 首次失败的根因判断正确**（family 命名映射＋plane 没换模式），且修复动作可复现（事实 11）。
