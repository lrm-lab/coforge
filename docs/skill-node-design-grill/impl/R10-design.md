# R10 设计：影响图记忆 → SkillsBench 任务通过率（端到端）

**立项缘由**：用户 2026-10-01 问「能开始测『影响图记忆 → SkillsBench 任务通过率』吗？」。这是本设计要回答的唯一问题。

**与既有结论的关系**：#140 的负结果说的是「**L1 检索级尺子**测不出因果子图价值」（那一层测的是命中了没有）；端到端**任务通过率**是**另一把尺子**，且是唯一能回答「值不值」的那把。两者不冲突，也不能互相替代。正因为 #140，**placebo 臂在本设计里不可省**。

---

## 1. 被测量与判读（先冻结，后打分）

- **被测量**：同一批 test 任务、同一模型、同一超时下，`reward`（官方 `verifier/test.sh` 写出的 `reward.txt`，fail-closed：判分前先删、官方脚本重写、缺/不可解析记 0 并披露 `verifier_exit`）。
- **主读数**：`memory_gain = warm − cold`（`code/skillsbench_grading.py` 已实现，`grading_report.json.memory_gain_warm_minus_cold`）。
- **对照（本设计的核心）**：三条臂**配对**跑同一批任务：
  - `cold`：无记忆（harness 已支持，recall 恒空）；
  - `our`：**我们的影响图记忆**（生产因果读路径答 recall）；
  - `placebo`：**错配记忆**（把别的任务/族抽出的卡片喂回去，形状同 `our`、内容无关）＝「多给点上下文」的安慰剂。
- **判读规则（写死在打分前）**：
  1. `our − cold > 0` **且** `our − placebo > 0` ⇒ 才算「影响图记忆有用」；
  2. `our ≈ placebo > cold` ⇒ 是「上下文/技能提示」的有用，**不是**我们的图；
  3. `our ≤ cold` ⇒ 负结果，照报。
- **不报**：任何「哪条边／哪个座位有用」的分解（那是 L1／R7 系列的问题，本合同不回答）。

## 2. 接缝（不改 harness）

- bench-runner 的记忆面**就是 HTTP**：召回 = `POST /v1/recalls`，返回条目被**逐字渲染**进提示（`internal/runtime/orchestration.go` `buildTurnPrompt`：「Memory from earlier sessions in this room (state=...)」＋ 每条 `--- recalled memory N (source=..., version=...) ---`），并把 `recall_state`／`recall_citations` 记进 `attempts.jsonl`。
- runner 既能自拉一个 GMS（`--gms-binary /tmp/gms-bench`），也能指向**已存在的外部服务**（`--gms-url`／`--gms-token`）⇒ **我们的记忆可以以「外部 memory plane」的身份接进去**：起一个适配层（GMS 形状的端点子集），用生产的因果读路径（影响视图 → 投影座位 → resolver → fork store，按 #113／#114／#115）回答 `/v1/recalls`，`cold` 臂不需要它。
- ~~待核实~~ **已闭合（#178，进 R10-brief §0 的接口清单）**：`--gms-url` 模式**无健康检查**、**每次调用只允许一条臂**、写路径 `:stage`／`:commit` 非 2xx 会 fail-closed 记成 infrastructure 失败、recall 错误**从不中断 episode**（⇒ 桩坏了会**静默退化成 cold**，这就是硬门 ①② 存在的理由）、鉴权 `Authorization: Bearer`。
- **两条控制反查（2026-10-01 我逐字核过源码）**：① `buildTurnPrompt`（`orchestration.go:1922–1955`）里「**没有 pre-turn recall**」与「**有 recall 但 0 条（`no recalled evidence (state=%s).`）**」是**两句不同文案**，cold 臂走的是后者（`MemoryPolicy` 只是记账字段，cold 并未 `SkipRecall`；我在 `sb-smoke-local-1/work-cold` 转录上实测逐字为 `Context snapshot: no recalled evidence (state=empty).`）；② 判分侧 `memory_gain` **写死** `warm − cold` 两个臂名（`skillsbench_grading.py:193–195`）⇒ **接我们记忆的那条臂必须就叫 `warm`**，否则配对不算数。
- **判分不是离线动作（新发现，影响跑法，也影响独立性）**：`skillsbench_grading.py` 的 CLI 是 `--attempts --manifest --sidecar-url`，它**现拉起容器里的官方 verifier 打分**。容器是 `docker run -d --rm`、**无 bind mount** ⇒ 任务产物**只活在容器可写层**，`/verify` 判完即**拆容器**、`/shutdown` 直接 `docker rm -f` ⇒ **事后无法补判、也无法独立重判**。（`/close` 只是 best-effort 异步判定，15 s 预算，容器不受影响。）⇒ 两条硬性跑法：**① 先判分、后收容器**；**② 判分键由验证方按**——episode 由实现方跑、容器留着，`skillsbench_grading.py` 由**我**（verifier ≠ 作者）调起来，reward 才算独立产出（判分零模型 token、每任务 ~22 s，代价可忽略）。我的复核＝「我自己按的判分」＋「用真 `build_report` 重算配对」两条。
- **明确不做**：不改 `memory_graph_evolving` 的 Go 侧（改了就不是同一个 harness，读数不可比）；不把我们的视图先灌进 GMS 再让 GMS 检索（那测的是 GMS 的检索，不是我们的）。

## 3. 分级与规模（用户裁定）

| 级 | 内容 | 目的 | 实测代价参照 |
|---|---|---|---|
| **S0 接缝烟测** | 1 个 test 任务 × `cold`／`our` 两臂 | 证 recall 真进了提示、判分能出数 | smoke-gmsgb 每集 3–9 分钟，约几万 token |
| **S1 配对** | 15 个 test 任务 × 3 臂 ＝ 45 集 | 拿方向性数字（够不够看出 `our` vs `placebo`） | 数小时墙钟 |
| **S2 全量** | 45 个 test 任务 × 3 臂 ＝ 135 集 | 可对外报的通过率 | 1–2 天墙钟、千万级 token |

- 实测参照：train 轮（14 集）单集中位数 **1745 s（29 分钟）**，其中 **2/7 撞 30 分钟 episode 超时被杀**（`PI_CANCELLED: context deadline exceeded`）；smoke 轮每集 27 s–8.6 分钟；每集上下文累计 token **0.1–3.3M**（train 14 集合计 ≈ 11.2M）。
- **模型**：`lenovo-deepseek-v4-flash`／`DeepSeek-V4-Flash-0731`（与被引用的既有轮次同模型，才可比）。不换 Cursor CLI 的模型跑 benchmark——那会把「记忆效果」和「换模型」混在一起。
- **任务集合**：`data/sb-full.jsonl` 的 45 个 test（8 个 family）；S1 的 15 个按 family 分层抽，抽样规则先冻结。

## 4. 先决条件与风险（都写清后才开工）

- **史上「暖臂」几乎没把经验送到现场（2026-10-01 逐轮核 `attempts.jsonl`，见 #180）**：train 录制轮 7 条 attempt **全 `recall_state=empty`／0 引用**、`skills/consolidated-*.md` **0 字节**、`frozen_skill_version=sha256("null")`（从没冻结过）；gmsgb 冒烟暖臂 `recall_state=skipped`／0 引用。**唯一真送过经验的是 local-1／par-1 两轮 n=2 冒烟，`complete`／1–2 条引用，两轮都是负的（−0.25／−0.4165）**。⇒ 本波不是「重复一次已知实验」，而是**第一次把记忆真送到 test 任务的提示里**（S0 那条「提示里必须出现 `--- recalled memory` 段」的硬门就是为此设的，且这条历史说明该硬门**不能省**）。

- **磁盘**：`/` 现在 **20 GB 可用、98% 已用**（2026-10-01 探路波前后一致；docker 侧可回收约 91 GB：镜像 68.8 GB＋容器 19.3 GB＋构建缓存 3.2 GB）；**上一轮 train 就是 `no space left on device` 死的**（`arm-summary.json` 0 字节、无判分，成因见侦察）。全量跑前要有余量——**清理是破坏性操作，等用户点头**。探路波实测：2 集 cold＋warm 对盘余量无可测影响。
- **端口/栈隔离**：新 sidecar 用 **8731**（我 2026-10-01 已在上面跑通官方 oracle）；**不碰** 8732／8733／18888／8789 与 coforge DB 那套暂停中的 eval 栈（`eval/NEXT.md` 的不要动 list）。
- **超时**：30 分钟 episode 超时会**直接压低通过率**（train 轮 2/7 被杀）⇒ 要么调大并披露、要么把「被超时杀」单独计数，不能混进 `reward=0`。
- **凭据与模型（2026-10-01 已实测，结论见 §7 第 3 条）**：pi 侧 `lenovo-deepseek-v4-flash` 的 key **有效**（能跑通 `DeepSeek`，两集共 65 条 assistant 消息带 usage）；**失效的是模型 id**——`DeepSeek-V4-Flash-0731` 被网关 403 下线，当前授权清单见 §7。
- **S0 前置事实（已成立）**：官方 verifier 链路今天可用——`court-form-filling`／`dialogue-parser`（都是 test split）`solve.sh → test.sh` 各 **reward 1.0**、各 22 秒、零模型 token。

## 5. 非目标与不动的东西

- 不改生产检索实现（`retrieval_facade.py` 等）——除非 S1 暴露「读路径接不上」这种真缺口，那也要另立设计；不 push；不建 `ov.conf`；不动暂停的 eval 栈与 `oauth:*` 令牌。
- 本设计**不**顺带改抽取契约（缺口 A／B 仍是独立待裁项）：`our` 臂用哪套视图必须**先钉死**（画布确定性 fallback？R9m 的模型视图？4.5 还是 4.7？）——这份视图选择进 R10-brief 冻结清单，跑完不许换。

## 6. 交付物

- `R10-brief.md`（派发件：接缝清单闭合项 → 适配层 → S0 → S1，每步带硬门与 SHA 钉）
- 报告：`impl/R10-run.md`（S0／S1 逐集读数、`our` vs `placebo` vs `cold`、失败与超时单列）
- 记账：`CONSENSUS.md` 新增裁定、`R0-wave-plan.md` 新增 R10 行

## 7. 待用户裁定（开工前只卡这几条）

1. **规模（唯一未决）**：先 S0＋S1（推荐），还是直接上 S2 全量？
2. ~~**盘**~~ **已裁定（#183，2026-10-01）**：用户授权清理，我已执行——**20 GB → 52 GB 可用**（98% → 93%）：删 105 张死轮次任务镜像（**R10 保留集原样保住**）、构建缓存 17.5→9.5 GB、`/tmp` 196 个死沙箱（24→9.8 GB）。**没动**正在跑的 118 个 `sb-*` 容器（全被 8732／8733 活侧车认领）、`jianghp3` 的 17.9 GB 停止容器、`/tmp/simpo310`／`ov-push`。若 S1 跑到一半仍吃紧，下一个可动的口子只有「R10 保留集镜像（重建代价）」或上面那三项非我们所有物。
3. ~~**模型 id**~~ **已裁定（#183，2026-10-01）**：本轮用同 provider 的 **`DeepSeek`**；报告须标注「与 9 月 campaign 不可比」。以下为原卡点记录。campaign 钉死的 `DeepSeek-V4-Flash-0731` **已被 Lenovo 网关下线**（当前 key 的授权清单只有 `gpt-oss-120b／DeepSeek／gemma-4-31B-it／GLM-5.3-Flash／Laguna-S-2.1`；旧 id 403）。探路波是用**同一 provider 上的 `DeepSeek`** 跑通的。**要你定的**：① 就按 `DeepSeek` 定为本轮模型（同轮配对不受影响，但**与 9 月 campaign 的数值不再可比**，R10 报告里必须这么标注）；② 还是去 Lenovo 侧开通旧 id、恢复跨轮可比性后再跑。**我推荐 ①**——R10 的判读规则是臂间差，跨轮可比性不是本轮的前提。

## 8. 真实波的跑法（#182 已定，不再逐轮问）

1. 实现方跑 episode（每轮**全新 sidecar**：残留侧车对同一 `episode_id` 会返回已拆的旧容器）；容器留着不拆。
2. **判分键由验证方（我）按**：容器 `docker run -d --rm`、无 bind mount ⇒ 产物只在可写层，判完即拆、事后无法补判，所以判分必须在场景跑完、容器还在时由非作者一侧调起。
3. **判分产物与 `attempts.jsonl` 同目录**（探路波把产物落在 `/tmp/r10/`，是我脚本首轮判 G3/G4 为 FAIL 的直接原因；真实波不许再这样）。
