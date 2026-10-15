# R8b 派发件：**重测 L3（同容量尺子，先冻结再打分）**＋收口证据门＋机械 lint（零 LLM／只读／可续跑）

本波是 R8a 的**修正波**。R8a 的抽取侧已被独立验证成立（`impl/R8a-verification.md` ＃135），不要重做、不要动它的规则与产物格式。要改的只有三件事：**L3 的尺子**（现在不合格，＃136）、**一个生产缺口**（＃138）、**lint**（＃139）。外加把 R7c 的一个描述性残留重数一遍。

先读：`impl/R8a-verification.md`（尤其 §4、§5）、`impl/R8a-brief.md` §2.3 与 §3。**基线是提交 `9494708c2`**。你现在在同一分支上继续，不要 push。

## 0. 为什么必须重测（先读懂，避免把「修尺子」做成「调参凑数」）

`impl/R8a-verification.md` §4 用两组独立测量说明 R8a 的 L3 数字不可报：

1. **每卡片 pattern 容量不对称**。`_card_patterns` 给 fork/branch 卡片的是**整条 `tail_patterns`**（最多 12 个 block 的全部 pattern），给 block/claim 卡片的是该 block／claim 的 pattern 列表；而 `_lexical_hits` 写死 `patterns: [item["pattern"]]`，恒 1 个。实测结构卡片 pattern 数：均值 1.70／中位 1／**最大 6**，单 pattern 卡片占 54%。把结构臂每张卡片削到 1 个 pattern 后：中性（取首个）**154 → 116/218**，事后最优（取能命中的那个，乐观上界）**149/218**；词法臂保持 103/218。即 **51 个优势里约 38 个只来自「一张卡片带多个 pattern」**。
2. **pattern 键太粗**。`pattern = {tool}:{command 首词}`（basename、casefold），全语料只有 **41 个键／444 次事件**；`run_command:cd` 163 次（36.7%）＋`bash:cd` 120 次（27.0%）覆盖 **63.7%**；一张「只含最高频 pattern」的卡片**单独命中 77/218＝35.3%**；上界（后半段事件的 pattern 出现在语料里的比例）197/218＝90.4%。

所以旧数字量的是**工具词汇重合**。本波要把尺子修到能区分「取了同一批工具词」与「取了同一段因果」。

## 1. 要做的五件事

### 1.1 同容量＋多条基线重测 L3（本条是重点；规则**先冻结再打分**）

沿用 R8a 的 `--stage 3` 机制与全部语料常量（14 episode、`SB_EPISODES`、`SB_ATTEMPTS`、留一任务口径、K=12、`_score_leave_one_out` 的命中定义与分母）。**新增的每条臂都要在文件里写成常量／函数，并在跑分前先 `print` 出来**（照 `_print_policy` 的做法），报告里要能看出「规则先于分数」。要报的臂：

| 臂 | 定义（按此实现，不要自行改） |
|---|---|
| `structural_full`（旧臂，照旧） | 现在这样，用于与 R8a 对账；**必须仍报**，且数字要与 `9494708c2` 一致（这是回归门） |
| `structural_cap1_first` | 每张取回的卡片只保留其 `patterns` 里的**第一个**（自然顺序，不做任何挑选） |
| `structural_cap1_oracle` | 每张卡片只保留一个 pattern，但允许事后挑「能命中后半段事件」的那个；**必须标注 oracle 上界**，与 R7c 的 `oracle` 同性质 |
| `lexical_k12`（旧臂，照旧） | 12 座、每座 1 个 pattern，用于与 R8a 对账 |
| `lexical_capacity_matched` | 词法臂座位数 ＝ 同一次查询里 `structural_full` 取回的**不同 pattern 数**（即 `len(union of patterns)`）；其余排序、文档、平局规则不变 |
| `lexical_same_events` | 词法臂座位数 ＝ `structural_full` 取回的**卡片数**（12），但**只允许每座 1 个 pattern**——这是最保守的同座位对照，可与 `lexical_k12` 完全相同（若如此就说明并合并） |
| `frequent_pattern_control` | 一张**只含全语料最高频 pattern** 的卡片（`run_command:cd`），单独跑一遍，报它自己的命中率（验证件已测 35.3%，你要用你的实现复现到同一量级，作为「平凡基线」写进报告） |
| `cross_family_only` | 只允许取回**与 hold-out episode 不同 family** 的卡片／条目；报 `structural_full` 与 `lexical_k12` 在该限制下的命中率（这直接检验「跨 family」的说法是不是被同族工具词撑起来的） |

**判定口径**：不要给「哪条臂赢」下结论，只报数。但报告里必须有一段**归因**：把 `structural_full − structural_cap1_first` 解释为「容量贡献」、把 `structural_cap1_first − lexical_k12`（或与 `lexical_capacity_matched` 的差）解释为「排序／承载方式贡献」，并说明剩余差距还能不能被 pattern 键粒度解释。

**更细的 pattern 键（并存变体，不替换）**：再实现一个 pattern 键变体，例如 `{tool}:{首词}:{第二词}` 或 `{tool}:{首词}:{参数指纹前 8 位}`（自己选一个并写清规则、先冻结）。用这个键**重跑上面全部臂**并**并列报告**。目的：看粗键上的差距在细键上是否还在。**不要**删掉或替换原来的粗键——两个键的读数要并列，让读者自己看键粒度的影响；两者都不许事后调整。

### 1.2 生产门收口（＃138，**不动任何函数签名**）

`write_failure_subgraph_fork` 现在从 `revision` 的 `failure_evidence_refs[0]` 取锚点，但**不校验调用方给的 `position_kind`／`position_ref` 是否覆盖该锚点**，于是调用方自带 position 时能写下一个锚点不可解析的 fork（验证件探针 [4] 真的写成功了）。

要做的：
1. 在 `write_failure_subgraph_fork` 内部加校验：`position_kind="block"` 时，`position_ref` 指向的 block 必须**覆盖** `failure_evidence_refs[0]`（生产已有 `_block_covers_evidence`，用它；`position_kind` 为其它值时按现有语义处理并写清）。**不改签名、不新增参数**。
2. 加**负例测试**：伪造 `failure_evidence_refs[0].ao_id` ＋ 调用方自带 position → 必须抛错且**不写盘**（测「store 里没有新目录」）。
3. 加一条**正例回归**：现有 15 个 fork 的路径仍能写（跑 `--stage 2` 即可覆盖）。
4. **不要**给 `validate_view` 加台账参数（那是签名改动，留给 #125 落地时做）。但请在报告里写一句「`validate_view` 仍不校验 evidence 可解析性」作为已知缺口，便于后续引用。

### 1.3 机械 lint（＃139）

`benchmark/causal_memory/sb_influence_extraction.py` 有 **10 处 `E402`**（`sys.path` 注入后才 import）。同目录其它文件干净。修法：把 `sys.path` 注入＋import 收进一个函数内（推荐，与本仓库其它跑分件一致）或按需 `# noqa: E402`——**选一种，全文件一致**。然后 `ruff check`＋`ruff format` 到干净。

**行为不变的证明（必须做）**：修完后重跑 `--stage all`（约 60 秒），把新 `report.json` 与 `9494708c2` 的产物做**递归语义比对**（键集合／列表长度／标量值；我验证 R8a 时用的就是这个方法，0 差异即为通过）。lint 修复要在**单独一个提交**里，并且该提交的 report 与基线 0 差异；L3 的新臂在**另一个提交**里（否则「行为不变」与「新增臂」混在一起分不开）。

### 1.4 R7c 残留重数（＃134 附属）

`impl/R7c-verification.md` 记了一个未复现的描述性数字：`within_conversation_shared_dias = 159`（我按自然读法得到 137／139）。它不进入任何指标。请重数一遍并把定义写清（同一会话内出现 >1 条的 dia 数？还是「会话×说话人」桶？）——**两种都报**，让数字有确切定义。

### 1.5 报告

写进你的最终消息，并落一份机器可读件（`--out` 的 report.json 里已有结构，按需加 `l3.arms` 一节）。要包含：
1. 回归门：`structural_full`／`lexical_k12` 与 R8a 的数字是否一致（必须一致）。
2. 新臂表（粗键＋细键并列），每条臂每个 caliber 的 micro 与逐 episode 行。
3. §1.1 要求的归因段落。
4. 平凡基线与上界（`frequent_pattern_control`、语料上界、pattern 词表规模），**必须与 R8a 的 35.3%／90.4%／41 键对齐**（你的实现应该复现到同量级；不一致就说明你的实现与我不同，先查清再往下走）。
5. 证据门：新增的负例测试结果（伪造锚点写不进去）＋ 15 个 fork 的正例回归。
6. lint：修前／修后 `ruff check` 输出，＋ 0 差异证明的比对方法与结果。
7. `within_conversation_shared_dias` 的两种定义与两个数字。
8. 残留与不确定项（诚实清单）。

## 2. 硬约束（照旧，逐条遵守）

- **只读语料**：`/home/zhoujie22/river2_0/evol_bench/SkillsBench/**` 只读，不写、不移动、不改名。
- **零 LLM**：不调用任何模型（本波全离线）。
- **不加依赖**，不改 `pyproject.toml`／`uv.lock`。
- **不改** `openviking/` 与 `tests/` 的**其它**文件；本波唯一允许改的生产文件是 `openviking/session/subgraph_forks.py`（＃138 的校验＋测试），且**不许改签名**。若你发现 §1.2 的校验无法在不改签名的前提下实现，**停下来报告**，不要改签名。
- **不动** `benchmark/causal_memory/l1_locomo_hitk.py`（保持字节相同）；其它同目录文件只在 §1.3 允许的范围内动。
- **不重跑／不改**暂停的 live 栈（见 `eval/NEXT.md` 的「不要动」清单：18888／1933／8789／8732／8733／`coforge-openviking-prototype-1`／共享 `coforge` DB）。**不重跑／不重归档** `evo-lsk1`。
- **不建** `ov.conf`。模型 key 只在 `/tmp/pcm-cursor-api-key.env`（本波不需要 key）。
- **不 push**。
- **确定性**：同一输入两次运行 report 必须完全一致；报告里给哈希。
- **不许移动球门**：§1.1 的臂一旦选定就冻结（先 print 再打分）；看到数字后不许改规则、不许删臂。旧的粗臂与旧的键**必须保留并照报**。
- **不许把单源当裁决**：`unrecorded` 不许写成成功或失败（R8a 的 5／2／7 人口数照旧，不要重算重标）。

## 3. 门检（任一条不过就非零退出，不许「跳过」）

1. 回归：`structural_full`／`lexical_k12` 的数字与 `9494708c2` 的 `report.json` **逐字段一致**。
2. 每条新臂都有完整读数（不得只报赢的那条），且每条臂的规则以常量／打印形式固定在文件里。
3. `frequent_pattern_control` 的命中率落在 30–40%（我测 35.3%），语料上界落在 85–95%（我测 90.4%），pattern 键数 ＝ 41（粗键）。**任一条对不上，先停下查实现，查清前不许往下跑**——这说明你的复现与我的不同。
4. 证据门负例：伪造锚点的 fork 抛错且 store 无新目录。
5. 15 个 fork 正例全部仍可写／读回（用生产 reader）。
6. `ruff check` 与 `ruff format --check` 在改动文件上干净；lint 提交后 report 与基线 **0 差异**。
7. `git status` 干净，未 push，`l1_locomo_hitk.py` 字节不变。

## 4. 交付

- 两个提交（顺序）：① `style(bench): fix E402 in the SkillsBench influence extraction script`（＋0 差异证明）；② `bench(causal-memory): same-capacity L3 arms, finer pattern key, and fork anchor check`。
- 报告写在你最终消息里；`--resume`／`--out` 机制照旧。
- 我（编排侧）会独立验证，重点是：新臂的规则是否真冻结、`structural_cap1_*` 是否真按「每卡 1 个 pattern」实现、跨 family 臂是否真排除了同族、证据门负例是否真不写盘。
