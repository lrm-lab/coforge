# R10 派发 #2（卡点测试）独立验收

**验证方 ≠ 作者**。作者交回：`impl/R10-blockers-cursor-raw.log`（摘要）、`impl/r10_memory_plane/R10-blockers-report-2026-10-01.md`（长报告）、`impl/r10_memory_plane/{stub_server.py,manifest-court-form-one.jsonl,README.md}`、`evol_bench/SkillsBench/results/r10-blockers-{cold,our}/`、`/tmp/r10/*`。

**我不采信它的自述**：四条硬门全部由我从磁盘产物重算（脚本 `/tmp/probes/r10_gates.py`，先用历史轮 `sb-smoke-local-1` 自测过，重算得 `memory_gain=−0.25`，与既有台账一致）。

---

## 1. 四条硬门：逐条重算结果

| # | 判据 | 我的重算 | 证据（我自己读的原文） |
|---|---|---|---|
| ① | `our` 转录首条 user 含 `--- recalled memory` | **过** | `results/r10-blockers-our/work-warm/episodes/0001-sb-court-form-filling/2026-10-01T15-39-15-518Z_*.jsonl`：命中 1 处；同臂 26 条 assistant 全带 usage |
| ② | `cold` 对应位置是 `no recalled evidence (state=empty)` | **过** | `results/r10-blockers-cold/work-cold/.../2026-10-01T15-36-42-095Z_*.jsonl`：`Context snapshot: no recalled evidence (state=empty).`；`no pre-turn recall` 命中 0（⇒ 走的是「有 recall 但 0 条」那一支，不是「跳过 recall」那一支） |
| ③ | 官方 verifier 出 reward | **过** | 三重独立通道互相印证：① `/tmp/r10/lifecycle.jsonl` 两条 `verify_started`→`verdict`（`court-form-filling@work-cold/...`、`court-form-filling@work-warm/...`，`reward=1.0 graded=true verifier_exit=0`）；② runner 自记 `run-cold.log`→`recall=empty(0)`、`run-warm.log`→`recall=complete(1)`；③ `/tmp/r10/graded_attempts.jsonl` 两行 `sb_grade.graded=True` |
| ④ | 合并 attempts 可算 `memory_gain` | **过** | 我用**真 `build_report`**（`evol_bench/SkillsBench/code/skillsbench_grading.py`，非它的 JSON 转述）重算 → `memory_gain_warm_minus_cold = 0.0`，`arms={cold:1,warm:1}`，两臂 `pass_rate` 均 1.0 |

**读数边界（我认可作者 §6 的写法并加一条）**：`memory_gain=0` **什么都不是**——n=1、桩条文与任务无关、且该任务 `difficulty=easy` 连 cold 臂也满分（官方 oracle 同为 1.0）。本件只证明了管道，没有测出任何记忆效应。

## 2. 我另外查出的四条（作者报告里没有或不准确）

1. **判分产物落在了跑批目录之外**：`graded_attempts.jsonl`／`grading_report.json` 在 `/tmp/r10/`，而 `results/r10-blockers-{cold,our}/` 里**没有**判分产物 ⇒ 我的脚本首轮 G3/G4 判 **FAIL**（找不到 graded 文件）。判分器的常规落点是 `attempts.jsonl` 的同级目录，本件为迁就 B3（manifest 不合格）改了输入路径，**顺带把产物也带出了跑批目录**。这是**可复现性缺陷、不是卡点**：真实波必须让判分产物与 attempts 同目录，否则「跑完就找不到判据」。
2. **`/tmp/r10/pi-probe-deepseek-id.log` 是 0 字节**：作者「`--model DeepSeek` 探活成功」这条**没有可供核验的产物**。但该事实由**跑本身**独立成立——两集共 65 条 assistant 消息、模型字段逐条为 `DeepSeek`、provider `lenovo-deepseek-v4-flash`，即它确实跑通了这个 id。
3. **代理在自己容器里读了官方判据**：生命周期日志里有 `cat /verifier/test.sh`、`cd /verifier && python3 -m pytest test_outputs.py -q` 两次 `exec`（cold/warm 各一）。`/verifier` 与工作区同容器 ⇒ **判据对被测代理可见**。这是 harness 固有属性、非本波引入，但后续波次解释差异时必须记得：拿到分的路径里可能包含「读了测试」。
4. **残留侧车是个陷阱（我按设计变更清理了）**：`/env` 是「首次调用为准」，残留的 8731 侧车对同一 `episode_id` 会返回**已拆掉的**旧容器。故真实波**每轮必须起全新侧车**。我已 `kill` 本波残留（8731 pid 830202、8741 pid 840116，% 已确认端口释放）。

## 3. B1（模型 id）——我独立复核后的定性

作者说「钉死模型 403、改用 `DeepSeek` 才跑通」。我复核**成立**，且把根因从「凭据/未开通」收紧为**网关侧的模型改名＋端点变更**：

- **探活原文**（`/tmp/r10/pi-probe-{system-ca,lenovo-ca}.log`，两把 CA 无差别）：`Warning: Model "DeepSeek-V4-Flash-0731" not found for provider "lenovo-deepseek-v4-flash". Using custom model id.` ＋ `403 "model is not allowed for this api key"`。
- **网关当前授权清单（我用 `models.json` 里的 key 只读查了 `/llm/v1/models`）**：`gpt-oss-120b`、`DeepSeek`、`gemma-4-31B-it`、`GLM-5.3-Flash`、`Laguna-S-2.1` —— **旧 id 根本不在其中**，所以「改本地 models.json」并不能救它；作者给的最小解法（Lenovo 侧开通）是唯一路径。
- **配置史**：`~/.pi/agent/models.json.bak-openrouter`（9/16）里该 provider 注册的是 `DeepSeek-V4-Flash-0731`、baseUrl 为 **service 专路径** `.../service-large-600-1777255649450/llm/v1`；现行 `models.json`（**9/24 改**）换成通用 `https://modelfactory.lenovo.com/llm/v1` ＋ id `DeepSeek`。⇒ 是**端点/呈现 id 变更**，不是密钥过期。
- **可比性影响（我的裁定建议）**：R10 的判读规则是**臂间差**（`our − cold`、`our − placebo`），同轮同模型 ⇒ **B1 不阻断 R10**；被破坏的只是**与 9 月 campaign 数值的跨轮可比性**（历史轮转录里逐条为 `DeepSeek-V4-Flash-0731`）。若用户能开通旧 id，跨轮可比性可恢复。

## 4. 约束合规（我自己执行，不采信自述）

- **不改 harness**：`find evol_bench memory_graph_evolving -mmin -200` 排除 `results/` 后**只有** `code/__pycache__/skillsbench_grading.cpython-312.pyc`（import 产生的字节码缓存，非源码）。`results/` 下新增即本波产物。
- **不动live栈**：受保护端口 `18888/1933/8789/8732/8733` 的 PID 与开工基线**逐个相同**（`8789=1573579`、`18888=2760716`、`8732=2292638`、`8733=507454`）；`coforge-openviking-prototype-1` 仍 `Up 3 days (healthy)`。
- **盘**：开工与收工均 `20G 可用 / 98%`；`docker system df` 各列未变；今日创建的容器 0 个（两集容器已被 `/verify` 拆掉）。
- **不 push、无 `ov.conf`、密钥不进 argv**：未见相关动作痕迹。

## 5. 我建议进真实波的改动（已写进 `R10-design.md`）

1. **判分键由验证方按**：容器 `docker run -d --rm` 无 bind mount，产物只在可写层，`/verify` 判完即拆 ⇒ 事后无法独立重判。故真实波：实现方跑 episode、容器留着；**判分由我调起**（零模型 token、约 22 s/任务）。
2. **判分产物必须与 attempts 同目录**（本件缺陷的修正）。
3. **每轮全新侧车**（残留会返回已拆容器）。
