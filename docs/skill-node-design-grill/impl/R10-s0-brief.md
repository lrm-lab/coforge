# R10-S0 派发件：真适配层 ＋ 1 个 test 任务 × 3 臂（cold／our／placebo）

**上游**：`R10-design.md`（测量设计＋§8 跑法）／`R10-brief.md`（接口清单）／#182（探路波已证管道通）／#183（模型定 `DeepSeek`）。
**本件的形状**：**探路波的桩已经证明管道通**（四条硬门全过），所以 S0 不是再跑一次桩，而是**把桩换成真适配层**——用生产的因果读路径检索我们已冻结的视图，**三条臂各跑一集**。
**这不是实现波**：适配层住在操作侧目录（**不进 `OpenViking` 主包**、**不改一行生产代码**、**不改 Go 侧**）。

## 0. 硬约束（违反即交回重做）

- **不改 harness**：`evol_bench/`（含 `SkillsBench/`）、`memory_graph_evolving/` 的**任何源码**一行都不改；`OpenViking/` 只**只读 import**，不许改。产物只有：适配层（本件）＋ manifest（由既有文件筛出）＋报告。
- **不 push、不建 `ov.conf`、不加依赖**（只用标准库 ＋ `OpenViking` 既有模块）；凭据只从环境文件读、**不进 argv**、不打印。
- **不许动**：端口 `18888／1933／8789／8732／8733`、`coforge-openviking-prototype-1`、共享 `coforge` DB、以及**正在跑的 118 个 `sb-*` 容器**（它们全被 8732／8733 活侧车认领，删了将来恢复会坏）。本件用 **8731（sidecar）／8741（适配层）**，两端口现在都空着。
- **上限 6 个 episode**（3 臂各 1 ＋ 最多 3 次重试）；**单集超过 30 分钟没产出就停下报卡点**。
- 开工 `df -h /`、收工再记一次；**可用低于 15 GB 就停下报卡点**（现在 52 GB），不要清任何东西。

## 1. 适配层（本件唯一产物）

位置：`skill-node-design-grill/impl/r10_memory_plane/`。**新增文件**（`stub_server.py`／`manifest-court-form-one.jsonl` 原样保留，别改）。

### 1.1 端点壳

照抄 `R10-brief.md` §0 的七个端点与行为边界（鉴权 `Bearer`、幂等注册回 `duplicate`、`:stage`／`:commit` 回 2xx 且 no-op、`degradation.state` 非空、**按 `space_ids` 作用域过滤**）。
**`/v1/recalls` 是唯一有实质逻辑的端点**：`query`／`space_ids`／`max_results(=5)`／`deadline_ms(=500)` 收到后走下面 1.3 的生产读路径；**逐次把请求与响应全文写 JSONL**（含耗时）。

### 1.2 视图来源（**先钉死，跑完不许换**）

- **只读** `/tmp/r9m/corpus/`（grok-4.5 那轮的模型视图，10 集合规）。**先整份复制**到 `impl/r10_memory_plane/views-r9m45/`（`views.json`＋`report.json`＋`ledgers/`，共约 1.1 MB）并记 SHA256——**跑批不许直接依赖 `/tmp`**。
- 贡献视图的**只有这 10 集**（`report.json` 里 `compliant=true` 的）：`0001/0002/0003`（cyber）＋`0004/0005/0006`（finance）＋`0008/0009/0010/0014`（industrial）。**4 集不合规的（0007/0011/0012/0013）不贡献**——**不许**用画布视图兜底、**不许**重新抽一遍；覆盖率本身就是本件要如实报的读数之一。
- **family 映射**：`space-<family>-shared` → 该 family 的那几集视图（family 来自 episode id 的 `sb-<task>` → `data/sb-full.jsonl` 的 `family_id`）。落到查询上：`space-sb_industrial-physical-systems-shared` 只许命中 industrial 那 4 集的视图。
- **非家庭空间一律返回 0 条**（cold 用的是逐 episode 隔离空间）——这条是 cold 基线的命根子，必须有日志自证（命中／未命中都记）。

### 1.3 检索：走**生产因果读路径**，不许自己拼卡片

`OpenViking/openviking/session/retrieval_facade.py` 是入口（模块 docstring 把三类语料与配额规则写全了）：

- `HybridRetrievalFacade(fork_branch, projection, segment_atom, retrieval_subgraph=...)`，`facade.retrieve(query, principal_labels, profile) -> RetrievalResult`；
- 该文件里的生产适配器：`ForkBranchAdapter`／`InfluenceProjectionAdapter`／`SegmentAtomAdapter`／`RetrievalSubgraphAdapter`；卡片类型 `RetrievalCard`、查询 `RetrievalQuery`、档位 `RetrievalProfile`；`coerce_query`／`coerce_profile` 负责归一。
- **把上面那 10 集已冻结的 `adaptive` 视图（`views.json` 的 revisions）喂给生产适配器**，让 `retrieve` 出卡；`items[].content` 用卡片的真文本（`RetrievalCard.text` 等）**逐字**渲染，`citation.citation_id` 要能溯源到视图修订／块／子图。
- **哪些通道真出了卡、各几张，必须逐次记进 JSONL**（fork／projection／subgraph 分开数）。若某通道恒为 0（比如我们没写过 fork），**照实报**，不要为了好看去造卡。
- **延迟**：`deadline_ms` 是 500 ms，必须记每次 retrieve 的真实耗时；超了就如实报（不许悄悄降级成桩条文）。

### 1.4 三种模式

用环境变量（**不要**改成命令行参数，凭据／模式都别进 argv）：

| 模式 | `/v1/recalls` 行为 |
|---|---|
| `R10_PLANE_MODE=cold` | 恒 0 条、`degradation.state="empty"` |
| `R10_PLANE_MODE=our` | 按 `space_ids` 的 family 返回我们检索出的卡片（≤`max_results`） |
| `R10_PLANE_MODE=placebo` | **同形同数**，但内容换成**别的 family** 的卡片：供体＝按 family 名排序的下一个（循环），映射写进日志 |

（cold 臂也可以直接用 `our` 模式跑——隔离空间本来就返回 0；但**用哪个模式跑的必须记清楚**。）

## 2. S0 怎么跑（三条臂各一集）

1. **任务**：`grid-dispatch-operator`（test／qa／`sb_industrial-physical-systems`／medium）——它所在 family 有 4 集记忆、主题（电网调度）与 `energy-ac-optimal-power-flow`／`energy-market-pricing` 最近。**备选**：`r2r-mpc-control`（同 family，medium）。
2. **manifest**：**从 `evol_bench/SkillsBench/data/sb-full.jsonl` 里筛出该任务的那一行**，原样写成 `impl/r10_memory_plane/manifest-s0.jsonl`（该文件的每一行都带 `converter_version`／`upstream`／`selection` 等元数据键 ⇒ 直接筛行即满足判分器的 formal 校验；**别手写 manifest**，探路波就是手写才被拒）。
3. **镜像**：这 16 个任务**都没有缓存镜像**，sidecar 会现建（`/env` → `build_image`）；建镜像的耗时如实记。
4. **三次独立调用**（`--gms-url` 模式一次只能一个臂）：`--arms cold`／`--arms warm`（＝our）／`--arms warm`（＝placebo），**各自 `--out-dir`**，其它参数照 `evol_bench/results/_gms-sb-slb-2026-09-19/run_stage2a_sb_train.sh` 的完整参数（`--provider lenovo-deepseek-v4-flash --model DeepSeek --pi-env HOME,PATH,NODE_EXTRA_CA_CERTS`、`--sidecar-url http://127.0.0.1:8731`、`--refs-root data/staging`、`--extension-file` 用现场生成的 `skillsbench_extension_gen.py` 产物）。**每臂起一个全新 sidecar**（残留侧车会对同一 `episode_id` 返回已拆旧容器）。
5. **判分不由你做**（见 §3）：**跑完把 sidecar 与容器留着**，**不要** `--shutdown-after`、不要 `kill` sidecar、不要 `docker rm`；把**我该跑的确切判分命令**（`--attempts` 合并文件、`--manifest`、`--sidecar-url`）原样写进交回件。

## 3. 四条硬门 ＋ 一条形状门（**逐条给证据，过就是过**）

1. `our` 臂 Pi 转录首条 user 里真出现 `--- recalled memory` 段，且**条数 ≥1**（给路径＋原文片段）；
2. `cold` 臂同一位置是 `Context snapshot: no recalled evidence (state=empty).`；
3. 适配层日志里 **`space_ids` 过滤真的生效**：cold 的隔离空间零命中、`our` 只命中目标 family（给日志行）；
4. **判分能出数**：你不用判分，但要给**容器的存在证据**（`docker ps` 该 episode 的容器名＋sidecar `/verdicts` 里 `env_created` 行），让判分方（我）能直接按下判分键；
5. **形状门（新）**：`placebo` 臂拿到的卡片**与 `our` 同形同数但内容来自别 family**（给两条臂的卡片文本与 citation 对照，证明"错配"真的错配了，不是又发了一遍 our）。

## 4. 交回

1. **四条硬门＋形状门的逐条结果**（证据路径＋原文片段）；2. 适配层位置、启动命令、三种模式用法、日志路径；3. 三次 runner 调用命令与 `--out-dir`；4. **我该跑的判分命令**；5. 卡点清单（现象／证据／根因／最小解法／是否要裁定）；6. **未能回答的项**单列（不许猜）。

## 5. 不许读成

- S0 **不是**「记忆有用」的证据（n=1＋桩换成真适配层这一步本身就可能是坏的）；它只回答「真适配层接上后，管道还通不通、卡片是不是真的来自我们的视图」。
- 本件的 `memory_gain` 就算不为 0 也不构成结论（单集、单模型、易／中难度混杂）。
- 我们服务的记忆**只覆盖 3 个 family／16 个 test 任务**——这是本轮测量的**覆盖面事实**，报告里必须显式写出（其余 5 个 family 上 `our` 会静默退化成 cold，不许把那部分混进读数）。
