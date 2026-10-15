# 因果记忆栈评测方案（2026-09-28）

对象：OpenViking `openviking/session/` 因果记忆栈（AO ledger → Influence View → Fork/Bridge → retrieval facade → Memory Hint → evaluation loop，17 个模块，main @ fead86677）。现状：**只有单测覆盖，没有任何 benchmark 驱动过它**；工作区也不存在 ground-truth 因果数据集。

## 资产盘点结论（详见调研）

三层可用资产：
1. **OV 内 `benchmark/`**：`longmemeval/openviking/`、`locomo/openviking/`（ingest→检索→答案→judge 管道，走 SDK/HTTP）；`memory_organization/`（**进程内 + 确定性判分**，"注入生产 provider"模式——离线组件评测的结构模板）；skillsbench pytest 判分。
2. **coforge collab 四件套**（`.worktrees/cursor-ov-cm-impl/benchmark/`）：evolbench/longmemeval/skillsbench/public-channel——活 agent 全栈，warm−cold 配对 + 机制列（no_offer/leak/citation），judge grok-4.6（Cursor CLI），LCB 冻结判分。今天报告（EVALUATION-REPORT-COLLAB-2026-09-28.md）：OV prototype 线 evo +7.0pp / LoCoMo 88.8% / SLB 零效应；lsk 线 evo −1.2pp。**共同瓶颈=记忆供给侧交不出来（no_offer 49.6% / offer=0）**。
3. **`evol_bench/`**：11 个基准的数据 + multica_test_runner 判分机件；`skill-node-design-grill/eval/`：lsk 线可复现协议（manifest sha256、判分契约 A1-A4+B）。

死资产：顶层 `memory_bench`（空壳）、`evol_bench_EvoAgentBench`（仅结果副本）、`RSI-Harness`（非评测件）、public-channel-memory 的 causal-host 臂（指向 Rust :9938 服务，是另一条已废线，harness 是 skeleton，勿投入）。

## 方案：三层评测，对应三类设计主张

### L1 检索层——表示阶梯 A→F（离线、进程内、立即可跑）

主张检验：三 corpus 混合检索 + 投影通道 + 依赖模式查询是否优于平铺检索（对应 AIG 调研 §7 的阶梯，落在 LongMemEval/LoCoMo 上）。

- 新建 `OpenViking/benchmark/causal_memory/`，仿 memory_organization 模式（进程内装配生产组件 + 判分）。
- 管道：haystack 会话 → AO ledger（recorder 采集）→ `purpose=post_run_index` InfluenceView → `retrieval_facade.retrieve` → 答案 LLM → judge。
- 臂设计（每臂只加一层表示）：
  - A 仅 Segment/Atom 通道；B + Block/Claim 投影（**deterministic fallback 视图，零 LLM**）；C + 真 LLM builder 视图；D + rerank；E + 依赖模式查询；F + Fork 通道（L2 产出后）。
- 指标：question-type accuracy（对齐 OV longmemeval judge 分型）；**确定性证据命中 hit@k**（LongMemEval 带 evidence session 标注，引用卡片回查即可，无 judge 可算）；token 成本分列。
- 数据：LoCoMo `evol_bench/LoCoMo/data/locomo/locomo10.json`（sha256 已钉）；LongMemEval 本地仅 smoke 样本，全量 500 题需下载（公开集）。
- **零 LLM 冒烟**：A/B 两臂跑 hit@k——天级可出第一个数字。

### L2 因果层——评测循环的配对 replay（离线、注入 LLM）

主张检验：Memory→Diagnosis→Memory 闭环能否从失败轨迹产出可复用的 fork（E1 已就绪，协作方全注入）。

- 输入 = **已录制的失败轨迹**：`evolbench-collab/result/*-attempts.jsonl` + evol_bench Episodes workdir（今天两线跑批的现成产物）。
- 流程：轨迹 ingest → 失败 outcome 触发 `failure_diagnosis` 视图 → E1 循环（diagnosis_fn 注入真 LLM）→ provisional fork → 后续 episode 检索带 fork → 冻结 LCB 判分配对前后。
- 指标：warm−cold 配对 gain（与今日报告同口径可横比）+ no_offer 率（供给侧主张的直接检验）+ fork validated/provisional 比率 + citation 四层计数。
- 诚实边界：无归因 ground truth（AIG Who&When 不在工作区、不引入），锚点质量只能由下游增益间接测。

### L3 系统层——collab 四件套零改动重跑（活 agent）

主张检验：整个因果栈在真实群聊消费端的端到端效果。

- 前置：HTTP 路由/daemon 把 facade 挂上 `ov_*` 检索面（替换 prototype 容器 @1933）——即已出栈的集成缺口，这是 L3 唯一的新工程。
- harness 不改，遵循 lsk 线判分契约 A1-A4+B；对照基线：evo warm 61.6%/cold 54.7%（prototype 线）、62.8%/64.0%（lsk 线）、LoCoMo 88.8%。

## 判分与纪律（全部复用冻结件）

- LCB 判分：`/tmp/evo-grading-0909`（重建指引在 evol_bench vendor）。
- 会话类 judge：grok-4.6（Cursor CLI，longmemeval-collab prompt 原样移植）或 ollama glm-5.3。
- manifest sha256 钉死（lsk REPRO.md 模式）；判分模型 ≠ 任务模型；答案不进频道。

## 建议顺序

1. **L1 零 LLM 冒烟**（LoCoMo 10 会话 hit@k，A/B 两臂）：1 个 ingest 适配模块 + facade 装配——天级。
2. **L1 全量**（LoCoMo 1540 题 + LongMemEval-S 500）：对齐 prototype 线 88.8% 基线，新栈检索的第一场同题竞赛。
3. **L2 配对 replay**（evo 86 test 集，用已录 attempts）：评测循环第一次真实产出 fork。
4. **L3** 排在 HTTP 集成之后。

## 诚实的缺口

- LongMemEval 全量需下载；AML/PersonaMem 数据缺失（判分虽确定性，无米下锅）。
- facade 的 Segment/Atom 通道需要 ingest 适配器把 haystack 会话转成 action 源——L1 的主要胶水工作。
- L2 依赖答案 LLM 与 diagnosis LLM 端点（lenovo DeepSeek / grok-4.6 均已有先例配置）。
- coforge 主检出有他人遗留 `apps/web/repro_tmp.ts`（临时文件，未提交，未动）。

## 探针结果（2026-09-28，已执行）

**LoCoMo 探针**（conv-26，419 消息，eval/probe/l1_probe.py）：管道机制全部正常（ingest 零坏行、fallback 视图确定性、配额 6/4/2 与 8/4 折叠正确、ACL default-deny 端到端成立、selection_audit 正确）。暴露两缺陷并已修复（H1，commit d132bced6）：`_text_hits` 大小写敏感（双侧 casefold 修复）；投影卡内容盲（`content_resolver` 注入修复，正文只用于匹配不进卡片）。修复后复验：小写查询命中、Block/Claim 通道可被内容词命中。

**SkillsBench 探针**（6 任务 10 个 SKILL.md，eval/probe/skills_probe2.py）：
- 机制面正常：事实池摄取、profile 0/0/12 调整、per-task 会话+视图注册干净、arm B 经 resolver 内容命中。
- 检索质量分层明显：**领域 distinctive 词精准**（citation 2/2、bike 4/4、azure 的 oscillation/leaks 精确命中、pcap 文件名精确）；**泛化词噪声大**（"input"/"route"/"detect" 跨任务误命中）；**词形/词汇鸿沟**（printed≠printing；court-form-filling 指令与 pdf 技能文本几乎无词面重叠）。根因：子串匹配是过滤器不是排序器（`_score` 恒 1、插入序输出）。
- 架构发现：**多任务视图共用一个 session 会触发 supersede 语义 + revalidation_callback 未配置警告**——跨任务技能池的正确形态是"事实池（无视图）"或"每任务独立 session"；`SegmentAtomAdapter` 绑定单 session，跨 session 池化检索需要适配层 fan-out。
- 结论：matcher 达到"存在性过滤"设计意图，但评测级检索需要 token 重叠计分（eval 适配层）+ rerank 注入位接 embedding/LLM——即设计预留的注入点，不是缺陷。

**下一步（按方案 L1）**：eval 适配层加 token-overlap 打分 + 证据 hit@k 全量跑 LoCoMo；rerank 位接 embedding 后再开答案 LLM 全量。

**L1 全量结果（2026-09-28，已执行）**：runner 入库 `OpenViking/benchmark/causal_memory/l1_locomo_hitk.py`（commit 见仓库），逐题明细 `eval/l1-locomo-hitk-full.json`。10 会话 5882 消息、1982 题（带 evidence），零 LLM：

| 条件 | any-hit@5 | any-hit@10 |
|---|---|---|
| P = 生产匹配器（facade 关键词并集，插入序） | 11.6% | 17.3% |
| T = token-overlap 参照（idf 加权，纯 Python） | 56.0% | 61.8% |

零并集（P 完全够不到证据）= 0%。分类别 hit@10（P / T）：单跳 26.2%/44.7%、多跳 **10.3%/69.5%**、时序 18.5%/37.0%、开放域 16.9%/64.8%、对抗 17.3%/66.6%。

读法：①子串过滤器+无排序是 P 弱的主因，多跳/长问题被插入序淹没；②rerank 注入位先吃下 token 重叠的 ~44pp，再上 embedding 补语义（lexical 天花板 ~62%，OV prototype 带 LLM 的答案 acc 88.8% 可作远期参照）；③性能注意：SegmentAtomAdapter 每次 retrieve 重读台账分页，1982 题 × 关键词查询约 20 分钟——评测规模需要内存缓存适配层。
