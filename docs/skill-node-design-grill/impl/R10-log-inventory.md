# R10 日志完整性盘点（派发 #1）

**范围**：SkillsBench + 现有 bench-runner / sidecar / GMS 链路（`evol_bench/`、`memory_graph_evolving/` 只读盘点）。
**主实测轮次**：`evol_bench/SkillsBench/results/sb-train-wsb-dsv4flash-r1`（14 个 `episodes/` 目录、4.2 MB 总量；`attempts.jsonl` 仅 7 行——轮次未跑完，见文末「未能回答」）。
**对照实测**：`sb-smoke-local-1`、`sb-smoke-par-1`、`sb-smoke-gmsgb-dsv4flash-1`；sidecar lifecycle：`results/_mechanism/lifecycle-par1.jsonl`、`lifecycle-stage2a.jsonl`。

**标注约定**

| 标记 | 含义 |
|------|------|
| **[实测]** | 在本仓库已录制产物中直接看到 |
| **[推断]** | 从源码阅读，未在本轮产物中逐字段核对 |
| **[部分实测]** | 源码 + 少量产物交叉验证 |

---

## A. 逐层落盘清单

### A1. bench-runner：`attempts.jsonl` 与 `work-<arm>/`

#### `attempts.jsonl` 字段（schema 来源 + 实测空值）

**Schema（全字段）** — **[推断]** `memory_graph_evolving/pi-group-chat-host/cmd/bench-runner/main.go:164–241`（与 `evol_bench/EvoAgentBench/code/bench-runner/main.go:164–241` 同构；后者 `attemptRecord` 无 `split`，但 **[实测]** train 轮 JSON 含 `"split":"train"`，说明当时跑的 `/tmp/bench-runner` 二进制与 `memory_graph_evolving` 侧更新一致）。

| 字段 | 含义 | train 轮 7 条 **[实测]** |
|------|------|---------------------------|
| `run_id`, `evaluation_id`, `benchmark`, `domain`, `task_id`, `episode_id`, `family_id`, `role`, `split`, `arm`, `room_id`, `memory_policy`, `seed`, `attempt`, `status`, `duration_seconds`, `work_dir`, `staged_files` | 运行身份与结果摘要 | 均非空 |
| `failure_kind`, `error` | 失败分类与原因 | 7/7 有（含 `PI_CANCELLED: context deadline exceeded`） |
| `recall_state`, `recall_citations` | 回合 recall 汇总 | **`recall_state` 空字符串 2/7**；其余为 `empty`；citations 全 0 |
| `recall_spaces` | 分 space 引用计数 | **7/7 未出现（omitempty 未写）** |
| `final_output`, `final_code_output` | 房间可见终稿 | **`final_output` null 2/7** |
| `transcript` | 房间轨迹（非 Pi 全量） | 7/7 有；内容为 task 用户句 + agent `room_send` 摘要，**不含** bash 中间步骤 **[实测]** 对比 `0010` 的 `*.jsonl` |
| `user_turns`, `termination`, `text_fallback_turns` | 双控/终止 | train 单轮任务多为 `user_turns:1` |
| `publish_reminder` | 发布提醒 | 未出现 |
| `memory_agent_*` | warm-ma 记忆代理轮 | 未出现（本臂为 warm-skill-batch） |
| `skill_proposal_*`, `skill_proposals_total` | 诊断提案 | **`skill_proposal_status`** 有值（如 `no_trajectory`）；计数类多为 0 或未写 |
| `skill_retrieval_*` | test 检索轮 | train 臂无 |
| `frozen_skill_version`, `consolidation_room_id` | 冻结技能图 | 均有；**[实测]** 与 `consolidated-*.md` 0 字节并存 |
| `graph_snapshot`, `test_write_policy` | 图版本钉扎 / test 写策略 | smoke test **[实测]** 有；train 7 条未写 `graph_snapshot` |
| `skill_replay_*`, `delivery_class`, `start_overlap`, `delivery_status` | replay / gmsgb 交付 | gmsgb smoke **[实测]**；train 无 |

**写入时机** — **[推断]** 每集结束（或 train 批量缓冲后）追加一行；**[实测]** train 仅 7 集写入，后 7 集有 `episodes/` 与 Pi 会话但 **无** `attempts.jsonl` 行（并行跑批中断/磁盘等）。

#### `work-warm-skill-batch/` 目录树（train 轮 **[实测]**）

| 路径 | 是什么 | 粒度 / 截断 |
|------|--------|-------------|
| `episodes/<seq>-sb-<task>/` | 单集工作区 | 每集 median ~207 KB（14 集合计 ~2.76 MB **[实测]**） |
| `…/sb-task.json` | 侧车任务 id | 仅 `task_id` 等少量字段 **[实测]** ~28–51 B |
| `…/<ts>_<uuid>.jsonl` | **Pi RPC 会话 transcript** | 见 A2 |
| `…/host-events.jsonl` | Host 编排事件 | 见 A2 / A5 交叉 |
| `…/pi-stderr.log` | Pi 进程 stderr | **[实测]** 14/14 集 **0 字节**（进程未往 stderr 写或极短） |
| `…/sb-actions.jsonl` | 扩展写侧车命令历史 | 每行：`call_id`, `command`, `exit_code`, **`stdout_tail` 最后 1500 字符** **[实测]** + **[推断]** `skillsbench-extension-gmsgb1.mjs:44–45` |
| `…/*`（agent 产出） | 宿主机 episode 目录下的脚本/数据 | 仅 mirror 在 cwd 的文件；**容器内 `/root` 产物默认不在此** **[实测]** agent 常写 sidecar 容器 |
| `diagnosis/<seq>-sb-*/` | 诊断 Pi 轮 | `host-events.jsonl`、`*.jsonl`、`trajectory-chunks.json`、`diagnosis-extension.mjs`；**无** `sb-actions` |
| `consolidation/<family>/` | 族 consolidation Pi 轮 | `host-events.jsonl`、`consolidation-extension.mjs` |
| `skills/consolidated-<family>.md` | 冻结技能 Markdown | **[实测]** 两文件 **0 字节** |
| `extension/` | 臂级扩展副本 | 与 mechanism 生成物同源 |
| `train-trajectories/` | 训练轨迹汇总 | **[实测]** 存在；本盘点未逐文件拆字段 |
| `arm-summary.json` | 臂级汇总 | **[实测]** **0 字节**（轮次未完成） |
| `../gms-warm-skill-batch/state.json` | GMS 持久图 | ~332 KB **[实测]**；终态图，非按 recall 时间序列 |
| `../gms-warm-skill-batch/gms.log` | GMS JSONL 操作日志 | ~652 KB **[实测]**；见 A5 |
| `../train-first-trials/` | 首轮试验 | **[实测]** 40 KB 级目录（未展开） |

**Runner 标准输出** — **[实测]** 编排脚本将 bench-runner 重定向到日志文件，例如 `evol_bench/results/_gms-sb-slb-2026-09-19/run_stage2a_sb_train.sh:50` → `logs/sb-stage2a-run.log`（非 `tee`，效果等同追加捕获 stdout+stderr）。

---

### A2. Pi 侧 agent transcript（`*.jsonl`）

**文件结构** — **[实测]** `0010-sb-energy-unit-commitment/2026-09-19T07-32-19-842Z_*.jsonl`：70 行；`type` ∈ `session`, `model_change`, `thinking_level_change`, `message`。

**每条 `message` 记录** — **[实测]** + **[推断]** Pi RPC 写 session（bench 使用 `--mode rpc`，**[推断]** `memory_graph_evolving/pi-group-chat-host/internal/pi/launcher.go:189–206`）：

| 内容 | 是否全文 | 出处 |
|------|----------|------|
| `message.role` | user / assistant / toolResult | **[实测]** |
| `message.content[]` | `text` 与 `toolCall` 块 | assistant 的 **工具入参在 `toolCall.arguments`（JSON 对象）**；**[实测]** bash `command` 为完整字符串 |
| `message.content`（toolResult） | 工具返回文本 | **[实测]** 侧车/bash 输出作为 `text`；极长输出单行 JSON，**未见 runner 侧截断**（侧车 API 层有上限，见 A3） |
| `usage` | input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost | **[实测]** 33/70 行 message 带 `usage`（assistant 轮） |
| `timestamp` / `message.timestamp` | ISO / ms | **[实测]** 有 |
| 单轮 wall time | 无直接字段 | **[实测]** 需用相邻 timestamp 差分；Host `turn_end.duration_ms` 更准（A5） |
| `provider`, `model`, `stopReason`, `responseId` | 有 | **[实测]** |

**「最终送给模型的提示全文」能否从 transcript 还原？**

- **[实测]** 首条 `user` 消息以 `Room message (untrusted content):` 开头，且含 `Context snapshot: …`——与 Host 组 prompt 一致（见下）。
- **[推断]** Host 在 recall 后调用 `buildTurnPrompt` 再 `process.Prompt(..., trace.prompt, …)`：`memory_graph_evolving/pi-group-chat-host/internal/runtime/orchestration.go:858, 1923–1954`。
- **[实测]** `0010`：`host-events.jsonl` 首行 `room_input_bytes=3218`，Pi 首条 user UTF-8 长度 **3308**；差 ~90 B 为 recall 包装句（该集 `recall.items=[]`，snapshot 为 empty）。
- **Recall 正文**：若 `recall_state=complete` 且有条目，**完整 recall 段在 Pi user 消息中**（`--- recalled memory … ---` 包裹 **全文 `item.Content`**）；**host-events 里 recall 仅 200 字符 preview**（A5）。**[部分实测]** `sb-smoke-local-1` 暖臂 `host-events` 含 `items[].preview`；同轮完整内容应在对应 `*.jsonl` user 首条（本盘点未对该路径做字节级 diff，**未闭合** preview 与 Pi 全文一致性证明）。

**Pi CLI 额外日志** — **[推断]** bench 固定 `--mode rpc`，**无** `--verbose`；`pi --help`（本机 `/home/zhoujie22/pi-0851/node_modules/.bin/pi --help` **[实测]**）：`--verbose` 仅 **Force verbose startup**，不扩大 session JSONL。RPC 下 **`pi-stderr.log` 为唯一 stderr 落盘**（`orchestration.go:877–887`）；train 轮全空。

---

### A3. Sidecar（`skillsbench_env_server.py --log`）

**Lifecycle JSONL 位置** — **[实测]** train 使用 `results/_mechanism/lifecycle-stage2a.jsonl`（412 KB，215 行，`run_stage2a_sb_train.sh:34`）；并行冒烟 `lifecycle-par1.jsonl`。

**`kind` 种类** — **[实测]** `lifecycle-par1.jsonl`：`image_built`, `env_created`, `exec`, `verify_started`, `verdict`, `container_removed`；**[推断]** 另有 `oracle_run`, `container_removed` 等（`skillsbench_env_server.py:229–417`）。

| kind | 字段 | 截断 |
|------|------|------|
| `exec` | `t`, `episode_id`, `call_id`, `command`, `exit_code`, `stdout`, `stderr`, `n_actions` | **stdout 末 8000 B、stderr 末 4000 B** 写入 log **[推断]** `:363–367` |
| HTTP `/execute` 返回 agent | `stdout` / `stderr` | **16000 / 4000** **[推断]** `:368–369` |
| `verdict` | `reward`, `graded`, `error`, `verifier_exit`, `verifier_output_tail` | `reward.txt` **首行 token** 解析为 float **[推断]** `:398–411`；**verifier 合并 stdout+stderr 末 6000 B** |
| `verify_started` | `task_id` | |
| `env_created` | `container`, `image`, `workdir`, `limits`, … | |
| `container_removed` | `task_id` | verify 后 **删容器** **[推断]** `:416–417` |

**`/verdicts` GET** — **[推断]** 返回 `--log` 文件全文解析为 `records[]`（`skillsbench_env_server.py:460–469`）。**判分不在 `attempts.jsonl`**；事后 **`skillsbench_grading.py`** POST `/verify` 再跑官方 `test.sh` **[推断]** 文件头注释 + **[实测]** 脚本存在。

**与 `sb-actions.jsonl` 关系** — extension **另存** `stdout_tail` 1500 B 供下轮 prompt 注入 **[推断]** extension 注释 `:39–40`；**lifecycle `exec` 更宽（8k）** 但 **不同文件**。

---

### A4. 容器内

| 产物 | 跑完后还在吗 | 在哪 | 要不要显式抓 |
|------|--------------|------|--------------|
| 任务容器文件系统 | **否**（verify 后 `docker rm`） | 仅 verify 前可通过 `docker exec` | **要**：verify 前快照或依赖 lifecycle `exec` |
| `reward.txt` | verify 时读 | 容器内 `/logs/verifier/reward.txt`（挂载到 host `container-logs/<container>/verifier/`） | grading 会再跑 verifier；**分析单次 agent 尝试** 应抓 lifecycle `verdict` 或挂载目录 |
| `test.sh` stdout/stderr | 部分 | `verdict.verifier_output_tail`（6k） | 全量需 verify 时额外 `docker exec` 或改 log（**本件禁止改 sidecar**） |
| `docker logs` | 容器 `-d sleep infinity`，agent 活动走 **exec** | 通常 **无实质 agent 日志** | 低优先级；**exec 链在 lifecycle** |
| Host 挂载日志 | oracle / 部分 episode | **[实测]** `results/_mechanism/container-logs/sb-*` 含 `verifier/` | 容器名规则 **`sb-` + episode_id  sanitized** **[推断]** `:318–319`；例 `sb-xlsx-recover-data-work-warm-skill-batch-episodes-0006-sb-xlsx-recover-data` **[实测]** |

**env key（grading / sidecar 对齐）** — **[推断]** `task_id@work-<arm>/episodes/<seq>-<episode>`（extension `skillsbench-extension-gmsgb1.mjs:17–20`）。

---

### A5. Memory plane（GMS / 未来适配层）— 重点

#### 每轮 recall 请求/响应现在记在哪

| 层 | 请求全文 | 响应全文 | 耗时 / 关联 ID |
|----|----------|----------|----------------|
| **Host `host-events.jsonl` `event=recall`** | **不记** query；仅有 `request_id`, `state`, `duration_ms`, `items[]` | **`items[]` 仅 metadata + `preview`≤200 字符** | **[实测]** train 全 `items:[]`；**[部分实测]** smoke-local 非空 preview；**[推断]** preview 截断 `orchestration.go:838` `truncateString(..., 200)` |
| **`host-events` `turn_start`** | **`room_input_bytes` 计数，无正文** | — | `prompt_request_id` **[实测]** |
| **GMS `gms.log` `http_request` POST `/v1/recalls`** | **`recall_query_prefix` 最多 240 B**；`recall_query_bytes`, `recall_spaces`, `recall_max_results`, `recall_request_id` | **`recall_items` 计数、`recall_scores[]`；无 item 正文** | `duration_ms`, `req_bytes`, `resp_bytes` **[实测]** train `gms.log`；**[推断]** 不写 body 明文 `requestlog.go:47–52, 133–153` |
| **`state.json`** | — | **committed 证据终态**（图/空间/版本） | 非 recall 请求日志；**无法按时间回放每次 recall 响应** **[实测]** 332 KB 单文件 |
| **Pi `*.jsonl` 首条 user** | **含完整 `buildTurnPrompt` 结果**（room + recall 段） | recall 条 **Content 全文**（若有） | 与 `prompt_request_id` 间接对齐（session 无该 id 字段）**[部分实测]** |
| **`attempts.jsonl`** | 无 | 无 | 仅 `recall_state`, `recall_citations` 汇总 |

**Recall HTTP 请求体形状（适配层必须兼容）** — **[推断]** `orchestration.go:789–804`：`request_id`, `query`←`roomInput`, `space_ids`, `max_results`, 可选 `space_versions`。

**Evidence 写入链（与 recall 因果相关）** — **[实测]** `host-events` 尚含 `drain_start/end`, `evidence_stage`, `evidence_commit`（字段：`batch_id`, `space_id`, `events`, `links`, `memory_version`, `duration_ms` 等）**[推断]** `orchestration.go:1608–1724`；**不含** staged event 正文。

---

## B. 缺口（跑完后用 log 优化表现）

| # | 缺什么 | 为何重要 | 最接近替代 |
|---|--------|----------|------------|
| 1 | **GMS/适配层 recall 响应正文**（item content、citation、score 全量） | 分析「召回了什么 → 提示如何变 → 行为/通过率」 | Pi 首条 user（**仅当 recall 非空且走 GMS 路径**）；`host-events` preview 200 字不够 |
| 2 | **Recall 请求 query 与 `prompt_request_id` 的结构化绑定**（GMS 仅 240 前缀） | 批量对齐多轮/多臂 | `host-events.recall.request_id` ↔ `gms.log.recall_request_id` ↔ `turn_start.prompt_request_id`（**[实测]** 可字符串对齐） |
| 3 | **Sidecar 容器内 agent 文件树与 verifier 全量 stdout** | 区分「做对了但路径错」vs「算法错」 | lifecycle `exec` 8k + `verdict` 6k tail；**挂载 `container-logs/`** 在容器删除前复制 |
| 4 | **`attempts.jsonl` 无 reward/verifier 细节** | 优化需 pass/fail 与机制字段 join | 跑 **`skillsbench_grading.py`** 产出；或 lifecycle `verdict` |
| 5 | **`attempts.transcript` 非 Pi 全轨迹** | 技能/诊断分析会漏 tool 步 | 同集 `*.jsonl` + `sb-actions.jsonl` |
| 6 | **`sb-actions.stdout_tail` 1500 + lifecycle 8k 仍可能截断** | 长编译/测试输出归因 | 无 harness 内全量；操作侧需在 sidecar 容器仍存活时 `docker exec` 重跑命令或抓文件 |
| 7 | **Train 轮 recall 全 empty**（**[实测]** 7 attempt + 14 集 host recall `items:[]`） | 无法用 train 轮验证「召回→行为」链路 | 用 **`sb-smoke-local-1` / `par-1` 暖臂 `recall_state=complete`**（**[实测]** `gms.log` `recall_items≥1`）做日志模板 |
| 8 | **Tool proxy（`memory_explore` 等）** | gmsgb 臂因果 | `host-events` `tool_invocation` 有 outcome/digest；**无 explore 结果全文** **[推断]** `pi_tool_*` 仅 `args_bytes`/`result_bytes` |

---

## C. 不改 harness 的操作侧补采集

### C1. Memory plane 适配层（或外挂 GMS 代理）全量记 — **必做、可行**

在适配层对 **`POST /v1/recalls`**（及若实现的 stage/commit）写 **独立 JSONL**（与 `gms.log` 并行），建议字段：

- `ts`, `duration_ms`, `request_id`, `prompt_request_id`（若上游 HTTP 头或 body 扩展；否则仅 `request_id`）
- **请求全文**：`query`, `space_ids`, `space_versions`, `max_results`, `deadline_ms`
- **响应全文**：`degradation`, `items[]`（含 `content`, `citation_id`, `score`, `source_space_id`, `memory_version`）
- `req_bytes`, `resp_bytes`, `http_status`
- 可选：`tenant_id`, `arm`, `evaluation_id`（由启动脚本环境变量注入，**不进 argv 密钥**）

**不改 Go**：适配层/反向代理侧实现；bench 仍对 `--gms-url` 说话。

### C2. `tee` / wrapper 抓 bench-runner

- **[实测]** 已有：`run_stage2a_sb_train.sh:50` 等 **`>"$LOGDIR/...run.log" 2>&1`**，捕获 printf、sidecar close 错误、并行进度。
- **补强**：`script -a "$LOGDIR/run-$(date +%F).log" -c '...bench-runner...'"` 或 `tee -a` 包一层，保留 **终端格式 + 时间**；内容 **不含** Pi transcript（仍在 `work-*/episodes/`）。

### C3. 每集跑完：`docker` / 挂载

容器名 **[推断]** `sb-<sanitized_episode_id>`，`episode_id` = `task_id@work-<arm>/episodes/<seq>-<slug>`。

```bash
# 在 sidecar 仍持有 env、verify 之前（episode 级；容器名以 lifecycle env_created.container 为准）
EP='fix-druid-loophole-cve@work-warm-skill-batch/episodes/0001-sb-fix-druid-loophole-cve'
C="sb-$(echo "$EP" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | cut -c1-90)"
docker exec "$C" bash -lc 'ls -la /root /logs/verifier 2>/dev/null; wc -c /logs/verifier/reward.txt 2>/dev/null'
# 挂载目录（与 sidecar --log 同目录族）
LOGROOT=/home/zhoujie22/river2_0/evol_bench/SkillsBench/results/_mechanism/container-logs
ls -la "$LOGROOT/$C/verifier/" 2>/dev/null
# verify 后容器已删时：只余 lifecycle JSONL
curl -s http://127.0.0.1:8733/verdicts | python3 -c "import json,sys; r=json.load(sys.stdin)['records']; print([x for x in r if x.get('kind')=='verdict'][-3:])"
```

**生效对象**：当前 run 的 sidecar 端口（train 脚本 **8733**；R10 设计拟 **8731**——**[推断]** `R10-design.md:47`；**禁止在本盘点中启动/切换**）。

### C4. Pi transcript 是否够全

- **够**：模型侧对话、**完整 turn prompt（含 recall 段）**、tool 入参/出参（受 sidecar 16k/4k 限制）、token `usage`、时间戳。
- **不够**：Host 内部 `room_input` 原文（未包 `Room message` 壳）、GMS HTTP 原始 JSON、sidecar 8k exec log。
- **无需额外 Pi 开关** for RPC bench（`launcher.go:189`）；`--verbose` 不增 session 字段。

### C5. 磁盘代价外推

**基准 [实测]**：`sb-train-wsb-dsv4flash-r1` **4.2 MB** / 14 集（单臂 warm + 共享 lifecycle 412 KB + gms 652 KB）；`episodes/` 均 **~207 KB/集**。

| 档位 | 45 task × 2 臂（cold+warm） | 45 × 3 臂（+placebo） |
|------|------------------------------|------------------------|
| **结构化**（`work-*` + `gms-*/state` + `attempts` + `host-events` + Pi jsonl + `sb-actions`；**不含** lifecycle 全 exec） | **~20 MB** 量级（线性外推） | **~30 MB** |
| **+ lifecycle `--log`**（按 stage2a **~30 KB/集** 实测密度） | **+~3 MB** | **+~4 MB** |
| **+ 重 exec 保留**（假设 **~500 KB/集** lifecycle，长 stdout 8k×多 call） | **+~45 MB** | **+~68 MB** |

**Pi jsonl 主导体积**（长 agent 轮次 **>100 KB/集** **[实测]** `0013`）；**token 级成本**见 `R10-design.md:38`（与磁盘分开）。

---

## D. 可直接照做的采集清单

### 跑批前（必须 / 可选）

| 项 | 必须 | 说明 |
|----|------|------|
| `EVAL_ID`、`OUT=results/$EVAL_ID` | ✓ | 与 `run_stage2a_sb_train.sh:15–47` 一致 |
| Sidecar `--log results/_mechanism/lifecycle-<id>.jsonl` | ✓ | 判分/容器/exec 链 |
| `LOGDIR=.../logs` + runner `>LOGDIR/*run.log 2>&1` | ✓ | 已有模式；可选改 `tee -a` |
| 每臂 `gms-*/gms.log` + `state.json` | ✓ | bench-runner `--gms-binary` 自动 **[推断]** |
| **适配层 recall JSONL**（C1） | ✓（R10 分析） | 新文件，如 `results/$EVAL_ID/recall-audit.jsonl` |
| 环境：`NODE_EXTRA_CA_CERTS` 等 | ✓ | 脚本已有；**密钥仅 env/模型配置** |
| `docker system df` / 磁盘余量 | 强烈推荐 | train 曾 `no space left` **[推断]** `R10-design.md:46` |

### 每集跑完（按 episode 目录）

| 抓什么 | 必须 | 命令/路径 |
|--------|------|-----------|
| `work-*/episodes/<dir>/` 整目录 | ✓ | 已自动落盘 |
| 对齐 `attempts.jsonl` 是否新增一行 | ✓ | `wc -l $OUT/attempts.jsonl` |
| lifecycle 中该 `episode_id` 的 `exec`+`verdict` | 推荐 | `rg "\"episode_id\":\"$KEY\"" lifecycle-*.jsonl` |
| `container-logs/<container>/` | 可选 | verify 前复制（A4） |
| join keys | ✓ | `prompt_request_id`, `recall_request_id`, `task_id@...` |

### 跑完整轮汇总

```bash
OUT=/home/zhoujie22/river2_0/evol_bench/SkillsBench/results/<EVAL_ID>
MECH=/home/zhoujie22/river2_0/evol_bench/SkillsBench/results/_mechanism
python3 evol_bench/SkillsBench/code/skillsbench_grading.py \
  --attempts "$OUT/attempts.jsonl" \
  --manifest evol_bench/SkillsBench/data/sb-full.jsonl \
  --sidecar-url http://127.0.0.1:<PORT> \
  --shutdown-after
du -sh "$OUT" "$MECH/lifecycle-"*.jsonl "$OUT"/gms-*
```

| 产出 | 必须 |
|------|------|
| `grading_report.json` / 日志 | ✓（test pass rate） |
| `attempts.jsonl` + 全 `work-*` + `gms-*` | ✓ |
| `lifecycle-*.jsonl` + `logs/*run.log` | ✓ |
| **`recall-audit.jsonl`（适配层）** | ✓（R10） |
| `curl sidecar/verdicts` 归档 | 可选 |

---

## 未能回答 / 未闭合项

1. **Train 轮后 7 集无 `attempts.jsonl`** 的确切断点（磁盘满 vs 超时 vs 进程 kill）——**未读** `sb-stage2a-run.log` 全文（允许读但未在本件展开）。
2. **`sb-smoke-local-1` preview 与 Pi user 首条 recall 段字节级一致**——未做 diff。
3. **暂停中 eval 栈（8732/8733/…）当前 lifecycle 路径**——本盘点 **未启动任何服务**，未实测。
4. **`/tmp/bench-runner` 与 `evol_bench/.../main.go` 字段差（如 `split`）**——以 **[实测]** JSON 为准；二进制未 `strings` 验证版本。
5. **R10 外部 memory plane 适配层** 尚未实现，故 **无** 其日志产物可盘点。

---

## 附：本轮「最全能拿到什么」（一句话）

**单集分析主轴 = `episodes/<…>/<ts>_*.jsonl`（全 prompt + 工具 + usage）+ `host-events.jsonl`（编排/recall 摘要/evidence drain）+ `lifecycle-*.jsonl`（容器 exec/verifier）+ 事后 grading；GMS 侧仅聚合前缀，recall 响应正文要靠 Pi 或未来适配层 JSONL。**
