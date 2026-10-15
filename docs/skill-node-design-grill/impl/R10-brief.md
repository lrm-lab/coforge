# R10-brief：影响图记忆接进 SkillsBench（外部 memory plane 适配层 → S0 → S1）

**上游**：`R10-design.md`（测量设计）＋ `CONSENSUS.md` #177／#178（裁定与接口清单）。
**只做设计里写的事；不许顺手改检索实现、不许改 `memory_graph_evolving` 的 Go 侧、不许 push、不许新建 `ov.conf`。**

## 0. 接口清单（已闭合，2026-10-01；改动前先读这一节）

`bench-runner` 在 `--gms-url` 模式下**只走 `runArm`**，且该模式**没有健康检查、没有版本探测**（`GET /healthz` 只在自拉 GMS 时探，且 GMS 根本没有这个 handler）。适配层必须回答的**最小端点集**（cold 与 warm 相同）：

| 端点 | 形状 | 要求 |
|---|---|---|
| `PUT /v1/tenant` | `{tenant_id, display_name, bootstrap_principal_id}` | 幂等；重复注册返回 `duplicate` 而非 4xx |
| `POST /v1/principals` | `{principal_id, kind, display_name}` | 同上 |
| `POST /v1/spaces` | `{space_id, scope, owner_principal_id, display_name}` | 同上；家庭共享空间形如 `space-<family>-shared`，cold 用逐 episode 一次性空间 |
| `POST /v1/grants` | `{grant_id, principal_id, space_ids[], purpose, operations[], expires_at}` | 同上 |
| `POST /v1/recalls` | 请求 `{request_id, query, space_ids[], max_results(=5), deadline_ms(=500)}`；响应 `{request_id, items[{content, source_space_id, memory_version, citation{citation_id, evidence_batch_id, event_ids[]}, score}], degradation{state, reasons[]}}` | **本波的核心**：按 `space_ids` 作用域返回我们的卡片；`degradation.state` 空串会被驱动改写成 `empty` |
| `POST /v1/evidence-batches:stage` | `{batch_id, idempotency_key, space_id, stream_id, source_segment_id, provenance{...}, events[...], links[...], terminal_outcome}` | **接受并 no-op**（响应体被丢弃） |
| `POST /v1/evidence-batches/{id}:commit` | `{commit_id}` | **接受并 no-op**；响应里只有 `memory_version`／`duplicate` 被读且只用于日志 |

**写死的行为边界**（照抄，别自行发挥）：
- 鉴权：`Authorization: Bearer <token>`（明文 HTTP，无 TLS）。非 2xx 的 stage／commit 会让该 episode **fail-closed 记成 infrastructure 失败** ⇒ 必须回 2xx。
- recall 出错／降级**不会中断 episode**（驱动只在提示里写 "memory unavailable"），且**没有任何代码检查 warm 的 recall 非空** ⇒ 适配层若返回空，warm 会**静默退化成 cold**。所以必须有**自证非空**的硬门（见 3）。
- **一次调用只能一个臂**：`--gms-url` 与多臂互斥（`len(armList) > 1` 直接 `os.Exit(2)`）⇒ cold／our／placebo 是**三次独立 runner 调用**；每次都会重新注册 tenant／principal／space／grant ⇒ 适配层要容忍重复注册。
- cold 的召回作用域是**逐 episode 的一次性空间**（`usesIsolatedTaskRooms`）⇒ 适配层**必须真的按 `space_ids` 过滤**，对非家庭空间返回空；否则 cold 基线被污染，整轮作废。

## 0.1 双臂优先（2026-10-01 追加；用户问「能跑双臂测评吗」）

**先跑两臂：`cold` ＋ `our`（`warm` 指向我们的适配层）；只有出现「`our > cold`」才补第三条 placebo 臂。**

跑法（已核过判分脚本的接口）：
- **两次独立调用**（`--gms-url` 模式一次只能一个臂）：`cold` → `--out-dir results/<eval>-cold`、`our` → `--out-dir results/<eval>-our`；
- **不许两个臂共用一个 `--out-dir`**：`attempts.jsonl` 是 `os.Create`（截断写），共用会把先跑的那条臂的记录整段覆盖掉；
- 判分：`cat <cold>/attempts.jsonl <our>/attempts.jsonl > merged.jsonl` 再 `skillsbench_grading.py --attempts merged.jsonl`——它按记录里的 `arm` 字段分组，**同时看到 `warm` 与 `cold` 才算 `memory_gain`**（`code/skillsbench_grading.py:165-194`）；
- 同一个适配层实例可以同时服务两条臂（按 `space_ids` 作用域对 cold 返回空即可）；`work-<arm>` 目录让两条臂的容器互不干扰。

**判读的不对称（写死在打分前）**：
- `our − cold ≤ 0` ⇒ **双臂即可结论**：记忆没用，不必再花第三条臂的钱；
- `our − cold > 0` ⇒ **还不能结论**：必须补 placebo（同一适配层、换成别的 family 的卡片）才能区分「我们的图有用」与「多给点上下文有用」。

## 1. 适配层（本波唯一的生产级产物）

位置：**不进 `OpenViking` 主包**，放操作侧目录（如 `/home/zhoujie22/river2_0/skill-node-design-grill/impl/r10_memory_plane/`）。要求：

1. 用**生产的因果读路径**（影响视图 + 投影座位 + resolver + fork store；#113／#114／#115）把已冻结的视图检索成卡片，**逐字**放进 `items[].content`（渲染格式与驱动一致即可，`items[].citation.citation_id` 要能溯源到我们的边／子图／fork）。
2. 视图来源**先钉死**（进冻结清单，跑完不许换）：默认＝R9m 的模型视图（grok-4.5 那轮，10 集合规）＋ 画布确定性 fallback 兜住剩下 4 集；**换哪套必须在报告里写明**。
3. `memory_version` 用我们的修订号（单调），`score` 用我们检索的分数；`citation` 里 `evidence_batch_id` 可填视图修订 id。
4. 只读我们自己的存储；**不写生产库**；不依赖 8732／8733／18888／8789 那套暂停的栈。

## 2. 三臂与判读（先冻结，后打分）

- arms：`cold`（空记忆基线）／`our`（我们的记忆）／`placebo`（**错配记忆**：把**别的 family** 的卡片按同样形状、同样条数喂回来）。
- 三条臂用同一 `--evaluation-id` 前缀不同后缀、同一任务集、同一模型（`lenovo-deepseek-v4-flash`／`DeepSeek-V4-Flash-0731`）、同一超时。
- 判读（写死）：`our − cold > 0` **且** `our − placebo > 0` 才算「影响图记忆有用」；`our ≈ placebo > cold` ＝ 上下文有用，不是我们的图；`our ≤ cold` ＝ 负结果照报。
- 判分：`code/skillsbench_grading.py`（官方 verifier）；**被超时杀**的 episode 单独计数，不与 `reward=0` 混算。

## 3. 分级与硬门

**S0（1 个 test 任务 × cold／our）**：
- 硬门 ①：`our` 臂的 episode 里，提示中真的出现了 `--- recalled memory` 段（从 episode transcript 里抓原文），且条数 ≥1；
- 硬门 ②：`cold` 臂该段为 `state=empty`；
- 硬门 ③：适配层日志里 `space_ids` 过滤生效（cold 的隔离空间零命中）；
- 硬门 ④：官方判分出数（`grading_report.json` 可解析）。
四条全过才进 S1；任何一条不过是**接口问题**，不许当成实验结果。

**S1（15 个 test 任务 × 3 臂 ＝ 45 集）**：
- 任务按 family 分层抽，抽样规则先冻结；
- 报 `our` / `placebo` / `cold` 的通过率与 `memory_gain`，附每集时长、超时计数、`recall_state` 分布；
- 顺带报「recall 命中但内容与我们视图不一致」的条数（= 适配层 bug 的探针）。

## 4. 不许读成

- S0／S1 都不是「记忆有用」的结论；**n 小、单模型、无种子重复**；S1 只能给方向。
- 不改 Go 侧 ⇒ 我们测的是「**在官方 harness 的同一通道上**把记忆换成我们的」，不是「bench-runner 本身的能力」。
- 服务端拿到的 `query` 只是房间输入文本；我们的检索**不许**偷看任务答案（stage 文件里没有答案，但要显式声明只读什么）。

## 5. 交回

commit（如果落在 repo 里）＋ 适配层运行说明＋S0 四条硬门的原始证据路径＋S1 报告路径；**没跑 S1 就说明为什么**。
