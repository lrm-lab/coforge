# coforge + OpenViking 群聊多 agent 协作评测总报告

- 时间窗：2026-09-21 → 2026-10-08
- 被测链路：coforge PublicChannel 群聊 + OpenViking 工作区记忆
- 模型：lenovo-deepseek-v4-flash / DeepSeek-V4-Flash-0731（memory agent 与 task agent 同模型）
- 判分：全部使用各基准官方 grader / 官方容器 verifier（LoCoMo 用逐字对齐的 lenient judge 离线补判）

---

## 0. 被测协议（所有基准共用）

```
user 在频道 @memory 提问
  → Memory Agent（openviking-memory fence：ov_find / ov_read / ov_search_context /
    memory_offer；预算每触发消息 3 次读 + 1 次 offer，失败不退款）
  → 带 citation 的 Memory Offer 定向投递（@task）
  → Task Agent（bash，无预装 skill）执行
  → 频道回复
```

工作区记忆沉淀：频道消息 → 15 分钟静默窗 → AdmissionDispatcher → OV typed-session 写入。

**双臂设计**（evo 系基准）：
- **warm**：每个 family 一个常驻 workspace，频道 + OV 记忆随 episode 顺序累积（episode 间 stop → 重建带 fence 的 session）；
- **cold**：每个 test episode 全新 workspace + 全新一次性 OV account（隔离记忆）。

---

## 1. 总览

| 基准 | 规模 | 状态 | headline 结果 | 记忆增益 |
|---|---|---|---|---|
| LoCoMo | 10 会话 1540 题 | ✅ 完成 | **89.0%**（1370/1540，0 泄漏） | —（单臂 QA） |
| EvoAgentBench | 354 集（warm 268 / cold 86） | ✅ 完成+官方判分 | warm:test **61.6%** vs cold:test 54.7% | **+7.0pp**（10胜/4负） |
| SkillFlow | 328 集（164×双臂） | ✅ 完成 | warm **76.5%** vs cold 69.8% | **+6.3pp**（19胜/9负，配对） |
| SkillLearnBench | 171 集（warm 95 / cold 76） | ✅ 完成 | 配对集 warm = cold（逐字节一致） | **0（零效应）** |
| SkillsBench | 85/86 任务 | ⚠️ 缺 2 任务 | pytest 通过 **29.4%**（25/85） | —（单臂，skill 仅经记忆链） |

> 结论一句话：**群聊记忆链在代码生成（evo +7.0pp）与 office 长任务（SkillFlow +6.3pp）上带来方向一致的正增益；在 SkillLearnBench 上零效应；长程多会话 QA（LoCoMo）89.0%。**

---

## 2. 分基准详情

### 2.1 LoCoMo（public-channel-memory）

- 协议：30 样本分层抽样中按序跑满 10 个（conv-26/30/41/42/43/44/47/48/49/50）；单臂 openviking；runtime judge + 271 题离线补判（`attempts-*-rejudged.jsonl`）。
- **总分 1370/1540 = 89.0%**，全程 0 memory leak。

| 样本 | conv-26 | conv-30 | conv-41 | conv-42 | conv-43 | conv-44 | conv-47 | conv-48 | conv-49 | conv-50 |
|---|---|---|---|---|---|---|---|---|---|---|
| 准确率 | 88.8% | 86.4% | 90.8% | 89.4% | 89.9% | 89.4% | 86.7% | 89.0% | 85.3% | 92.4% |

- 机制面：ok 1523（98.9%）/ timeout 15 / no_offer 2；平均引用 1.90 条/题，零引用仅 17 题。
- 数据事件：conv-41 首跑 19%（调试热重载窗口内异常），重跑两次 65%→90.8%，以末次计。

### 2.2 EvoAgentBench（evolbench-collab）

- 协议：manifest 354 集（182 train / 86 test）；warm 臂 268 集 = 182 train + 86 test 顺序累积；cold 臂 86 test 全新环境；官方 LCB 判分（09-09 冻结快照 grader + lcb-venv，REPRODUCE.md §5 口径）。
- **配对 test 集（n=86，全集口径：失败/无代码记 0 分）**：

| 臂 | 通过率 | 说明 |
|---|---|---|
| warm:test | **61.6%**（53/86） | train 阶段 92.9%（169/182） |
| cold:test | 54.7%（47/86） | |
| **transfer gain** | **+7.0pp** | win/loss = 10 胜 / 4 负 / 43 双过 / 29 双败 |

- graded-only 口径（只看产出代码的集）：warm:test 85.5%（n=62）vs cold:test 85.5%（n=55）——通过率持平，**warm 的增益主要来自更多 test 集走到完整解题（62 vs 55）外加 10 个翻盘**。
- 官方归档基线（warm:test 85.7% / cold:test 78.1%，gain +0.081）与本项目 graded-only 水平相当，+7pp 方向量级一致。
- 机制面（去重后）：warm ok 130 / **no_offer 133（49.6%）** / no_reply 5；cold ok 54 / no_offer 21（24.4%）/ no_reply 11。warm 臂 no_offer 率显著更高——已定位为模型工具参数格式烧预算 + 不退款的产品问题（已加 coercion 修复，预算退款待产品决策）。
- 数据处理：38 条 cold 重复行（双 shard 竞态）去重，`evo-code-full-collab-1-dedup.jsonl`；判分产物 `result/grade-evo-collab-1/`。

### 2.3 SkillFlow（evolbench-collab + 8733 env sidecar）

- 协议：164 episode × 双臂 = 328 集；20 个 family；官方容器 verifier（sidecar `POST /verify` → reward.txt）。
- **配对判分级（n=158）**：warm **75.9%**（120）vs cold 69.6%（110）→ **+6.3pp**；win/loss = 19 warm-only / 9 cold-only / 101 双过 / 29 双败。
- 全量：warm 124/162=76.5%，cold 111/159=69.8%。
- 与官方论文方向一致（官方 Claude Opus skill-lift 为正），本项目增益更大。
- 机制面：warm ok 115 / no_offer 33 / no_reply 16；cold ok 119 / no_offer 35 / no_reply 9 / leak 1。
- 数据事件：sfcold shard 曾漏传 `VERIFY_SIDECAR/ENV_NOTE`，109 条无验证污染行已剔除并修正重启；sidecar 跨臂缓存污染疑云经行为学实验排除（重绑即新容器）。

### 2.4 SkillLearnBench（evolbench-collab + 8732 env sidecar）

- 协议：171 集（19 family）；官方 verifier。
- **核心发现：配对判分级（n=64）warm 与 cold 结果逐字节一致（verifier_output_tail 都相同），win/loss 矩阵零不一致（38 双过 / 26 双败）→ 群聊记忆链对 SLB 任务结果零效应。**
- 表观的 warm 49.4%（44/89）vs cold 61.6%（45/73）"反向增益"是**判分覆盖面分母假象**，不是 cold 更强。
- 难度门控明显：5 个 family 双臂皆 0%（court-form-filling 0/5、financial-analysis 0/5、stock-data-viz 0/4、temperature-simulation 0/4、python-scala 0/1），其余 family 双臂几乎全过。
- 引用面：warm 平均 2.33 条（87/95 cited）——但 cold（只有 OV 自动生成的 abstract/overview）也是 2.33，提示 warm 引用中可能混有样板内容而非 family 经验，是"零效应"的候选根因之一（另一候选：任务本身不依赖可迁移经验）。

### 2.5 SkillsBench（skillsbench-collab，86 任务）

- 协议：skill 仅通过 memory agent 检索提供（不预装）；官方 pytest verifier（900s）；ingest 后删除 skill 频道行防绕过。
- **pytest 通过 25/85 = 29.4%**（testScore 均值 0.568，满分 25 / 零分 20；另 17 任务 verify 未产出数值）。
- 机制面：ok 54 / no_reply 21 / **leak 10**；引用均值 2.54，零引用 0。
- 缺 1 任务：multilingual-video-dubbing 在 `EXCLUDED_TASKS` 中，按设计排除（任务宇宙 = 85，非 86）。ada-bathroom-plan-repair 结构性不可跑：seed 提示（task.md 单文件 10,676 字符）超频道消息 8,000 字符上限（旧限额，commit c151d922），不改产品限额、不截断 seed（会改变评测行为），记录为结构性阻塞。
- 数据事件：9-23~9-25 期间 lane 未传 `COFORGE_EVAL_TASKS`，89 次运行全部实为 3d-scan-calc（178 个错标文件已 void 到 `result/void-mislabeled-20260925/`），修复后重跑。

---

## 3. 跨基准机制面汇总

| 指标 | LoCoMo | evo warm/cold | SF warm/cold | SLB warm/cold | SB |
|---|---|---|---|---|---|
| ok（链路完整） | 98.9% | 48.5% / 62.8% | 70.1% / 72.6% | 70.5% / 75% | 63.5% |
| no_offer（预算烧尽） | 0.1% | 49.6% / 24.4% | 20.1% / 21.3% | 8.4% / 0% | — |
| no_reply | — | 1.9% / 12.8% | 9.8% / 5.5% | 17.9% / 22.4% | 24.7% |
| leak | 0 | 0 | 0 / 1 | 1 / 1 | 10 任务 |

- **evo warm 臂 no_offer 49.6% 是最大失败源**：模型把 limit 传成字符串、臆造 operationId、裸 viking:// URI 等烧光 3 读预算且失败不退款。coercion 已修（runner.ts），"失败退款"是遗留产品决策。
- SLB/SF 的 no_reply 集中在冷启动 workspace 首集（无记忆且频道为空时 task agent 沉默）。

## 4. 数据质量事件台账（全部已处置）

| 事件 | 影响 | 处置 |
|---|---|---|
| 多 agent fence 403（进程 env 串写） | 全部基准 | runner.ts session-env 闭包修复（未 commit） |
| skillsbench lane 未传任务名 | 2 天白跑（89×3d-scan-calc） | 178 文件 void；lane 修复重跑 |
| sfcold shard 缺 sidecar env | 109 条无验证行 | 剔除 + 修正重启 |
| web 宕机 8.5h | 全线停滞 | 重启 + web 看门狗（/tmp/web-watch.sh） |
| evo cold 双 shard 竞态 | 38 重复行 | 去重 keep-last |
| 判分 keys 文件不统一 | "runtime unavailable" 假象 | 统一 /tmp/pcm-eval-ov-keys.json |

## 5. 局限与后续

1. task agent 无沙箱（bwrap 未做）：存在读宿主 oracle/solve.sh 的泄漏面（SB leak=10 需复核是否此类）；最高优先后续项。
2. 单模型（DeepSeek-V4-Flash-0731）单种子；evo 增益的 CI 未做 bootstrap。
3. SLB 零效应根因未定论（offer 内容 vs 任务难度门控），建议抽样 warm offer 内容比对。
4. 未跑：TAU-2、LifelongAgentBench、AgentStream、PAST-Bench、EarthBench（adapter 已就绪）；longmemeval-collab 未 smoke。
5. 所有产品修复与 benchmark 目录均**未 commit**，等用户决策。
6. ~~web 当前 ERR_MODULE_NOT_FOUND~~（已修复）；SB 缺任务结论改为：multilingual-video-dubbing 设计排除、ada-bathroom-plan-repair 结构性阻塞（见 §2.5）。

## 6. EvoAgentBench run-2 复跑（collab-3，2026-10-08）

run-1 之后定位到两个把 warm 臂机制面打歪的产品级根因，修复后全量复跑（`evo-code-full-collab-3`；warm 串行 268 集，cold 8-shard 并行 86 集），仍用 09-09 冻结快照 grader 判分。

### 6.1 根因与修复（均未 commit）

1. **runner.ts 消息工具 400**（run-1 warm no_offer 49.6% 的主因之一）：runner 发的是 `requestId`，而 post-merge 契约按 `idempotencyKey` 键入（daemon parseMessageRequest 与 web send 路由都以其缺失拒 400）→ memory agent 每次消息读取/发送全 400 → 无 offer → 601s deadQuiet。修复：改发 `idempotencyKey`（`crypto.randomUUID()`）+ `limit` 数字字符串 coerce。OV 工具侧已有 `coerceNumericToolParams`，无需改。
2. **offer 投递缺 Centrifugo push**（no_reply 902s 的主因）：`createPrismaMemoryOfferPublisher.publish` 只写 `agentMessageDelivery` 行、不 publish `daemonControlChannel` 推送，而 agent 指令明确"Do not poll for new messages"、daemon 会话又是惰性拉起 → 投递行永远无人收取。修复：在 `sendAgentMessage` 落库后按 direct-message `publishAgentMentionDeliveries` 同款模式补 push（offer-delivery.server.ts）。
3. 顺带修复 3 处姊妹基准 eval-daemon 的未 await `readAgentRuntimeCredentialEncryptionKey`（skillsbench / longmemeval / public-channel-memory；evo 侧此前已修）。

### 6.2 cold 臂终数（n=86，全集口径）

| 指标 | run-1 cold | run-2 (collab-3) cold |
|---|---|---|
| graded pass | 47/86 = **54.7%** | **53/86 = 61.6%（+7.0pp）** |
| success（mech） | 55 = ok 54 + no_offer 1 | 59 = ok 58 + leak 1 |
| failure | 31 = no_offer 20 + no_reply 11 | 27 = no_offer 22 + no_reply 5 |
| no_reply 902s 超时 | 11 | **5**（push 修复直接收益） |
| no_offer 601s deadQuiet | 20 | 22（LLM 级预算烧尽未变，见 §6.4） |
| success 均时长 | 219s | 209s |
| graded by mech | — | ok 52/58（89.7%）、leak 0/1 |

冷臂 61.6% 恰好追平 run-1 warm 水平——修复把「offer 已生成但 task agent 收不到」的 6 个 902s 超时救回，且其产出代码判分全过。剩余失败大头仍是 no_offer（memory agent 预算烧尽，LLM 行为层面）。

### 6.3 warm 臂：collab-3 作废，collab-4 干净重跑（2026-10-10 决策）

**collab-3 warm（204/268）作废。** 该臂实际跑成三个段：f831947e（98 train）→ 585a211c（84 train + 20 test）→ d85d9476（2 test），每段一次 crash-resume 重新 provision＝新 workspace＋新 OV 账号，记忆随段清零。事后确认三段的 OV 记忆**全部不可恢复**：段 2 的账号 evol-55666872a8c2 已被服务端删除（rotate 404，且不在 4105 账号列表中），段 1/3 的账号随 releaseFamily 销毁。若裸续跑剩余 64 个 test 集，其记忆深度为 0，与 run-1 warm:test（86 集全部跑在带 41 集 train 记忆的同一段内、深度 41–126）完全不可比。204 行 attempts 保留为机制面证据，不进入 warm:test 口径。

**决策：warm 臂整个重跑（`evo-code-full-collab-4-warm`）。** manifest 恰为单一 family，warm 臂本就设计为「一次 provision＋一个账号串行 268 集」——干净重跑即回归设计形态，且记忆深度（test 集前有 182 集 train 记忆）优于 run-1 的分段形态。cold 臂沿用 collab-3 已判分的 61.6%（cold 无记忆连续性问题）。

**harness 加固（未 commit）**：run.ts 新增 warm 账号跨重启复用——resume 时 rotate 同账号 admin key 而非新开账号；状态文件 `<resultDir>/<evalId>-warm-account.txt` 记录账号；releaseFamily 对 warm 臂跳过账号删除。binding 仓库的 `WorkspaceMemoryScopeError`（cross-workspace 拒绑，产品不变量）通过 resume 时先删除 stale workspace（binding 随之级联删除，OV 记忆在服务端不受影响）来满足。

**环境事故台账（当日已处置）**：① 09:47 worktree 被外部会话删建，runner 中途死亡；② EvoAgentBench 整树被删，manifest 自归档找回（sha256 = 冻结值 f5015bfa…）＋ LCB venv 改用归档路径；③ /tmp/web-watch.sh 的旧监督循环以缺 env 的配置反复拉起 web，已 kill；④ **12:17 起「start pending」全灭的真正根因：coforge-redis-1（Centrifugo engine＋web 锁共用）达 maxclients，拒绝一切新连接**——HTTP API 走存量池看似正常、WS 客户端全灭，极具迷惑性；docker restart 该 Redis 后恢复（两个 Centrifugo 容器顺带重启）。对 §6.1 之外早前把 12:17–12:57 失败归因 web 缺 COFORGE_CENTRIFUGO_PROXY_SECRET 的判断予以修正：该缺失属实，但 09:30 有 fresh daemon 成功连接，说明它并非 12:17 后故障的原因；Redis 饱和才是。

**collab-4 早期健康**：13:00 UTC 起 runner 越过 provisionFamily（agent start completed），双 agent 会话活跃，首集执行中。口径警示同上：push 修复后的 warm 臂 episode 以「offer→唤醒→task 执行→回复」完成，与 run-1 warm（大量 601s 空转假成功）不同机制，warm:test 对比 run-1 须附此说明。

### 6.4 遗留

- 预算不退款：budget.consume 在 proxy.post 之前，400/ungrounded offer 也烧预算（产品决策待定）；no_offer 失败率未因 coercion 显著下降。
- cold no_offer 22/86：memory agent 在全新 workspace 上 citation 绑定失败率高（引用 operationId 而非 citationId、citationRefs 传 JSON 字符串等），属模型工具使用层面。
- daemon→web 的 reminder snapshot RPC 对 8789 主 web 404（当前树新增方法 vs 部署版词汇差异；agent start 不依赖它，cold 全量在该状态下已跑通）——非致命，留意。
- 基础设施：coforge-redis-1 无监控告警，饱和后仅表现为「新连接静默失败」；建议对 connected_clients/maxclients 加告警。

## 7. 产物路径

- LoCoMo：`benchmark/public-channel-memory/result/`（`attempts-*-rejudged.jsonl`、conv-50 为 `attempts-2026-09-23T212001516Z.jsonl`）
- evo：`benchmark/evolbench-collab/result/evo-code-full-collab-1-dedup.jsonl` + `grade-evo-collab-1/{graded_attempts.jsonl,grading_report.json}`
- SF/SLB：`benchmark/evolbench-collab/result/{sf,slb}-full-collab-1-attempts.jsonl`
- SB：`benchmark/skillsbench-collab/result/attempts-*.jsonl`（错标归档 `void-mislabeled-20260925/`）
