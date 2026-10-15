# R6d brief：给因果通道出第一个离线数字（L1 投影臂，零 LLM）

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（HEAD `5aebd83cb`，未 push）。**追加新提交；不 rebase／amend；不 push；不引新依赖。**

## 一句话

既有 L1 跑分器只量了 fact 通道（而且那条通道已被 #87/#88 暂停，生产臂现在是 0）。这一波**新增一个同目录的跑分脚本**，把「确定性 fallback 视图 → `ProjectionRegistry` → 投影通道」这条链建起来，用**同一个 hit@k 判分**给出因果通道的第一个离线数字。

## 硬纪律（违反即越界）

- **`benchmark/causal_memory/l1_locomo_hitk.py` 必须逐字不变**（它是存量基线 `eval/l1-locomo-hitk-full.json` 的产出者）。新增**同目录新文件**，例如 `benchmark/causal_memory/l1_locomo_projection_arm.py`。
- `benchmark/` 下**只允许新增这一个文件**；不改其它任何 benchmark 文件、不动 `evol_bench/`、不动被暂停的 live 栈（`eval/NEXT.md` 的「不要做」清单照旧）。
- **不改 `openviking/` 任何源码**。若你判断需要改源码才能量，**停下并报告**，不要动。
- 输出只写命令行 `--out` 指定的路径（默认不写仓库内）。

## 背景：为什么现在量不到因果通道

- 生产臂 P 走 profile `{fork_branch: 0, projection: 0, segment_atom: 12}`，而 fact 通道被 `FACT_LANE_PAUSED = True`（`openviking/session/retrieval_facade.py:114`，分支第一个提交 `988148ad8`）关掉 → P 在所有题上返回 0 张卡（我实测：空并集 1982/1982）。
- 跑分器构造门面时 `InfluenceProjectionAdapter(ProjectionRegistry(work / "unused.jsonl"))`——**没有注册任何视图**，投影座位也是 0，所以投影通道等于没接线。
- 参考臂 T（纯 Python 词重叠）与我们的改动无关：hit@5=56.0% / hit@10=61.8%。

## 要做的事

### 1. ingest 要**按消息分段**（关键，否则量不了）

现在每条消息一个 AO，但没有指定 `segment_id`／`participant_id`。确定性 fallback 视图的约束是**每个 segment 只能有一个参与者的连续 AO 区间**（`influence_view.build_minimal_fallback_view`），所以要在 `AOLedger.append` 的 `action` 里显式给：

- `segment_id`：每条消息一个（例如 `f"{sname}:{dia_id}"`，`sname` 是 `session_N`）
- `participant_id`：该消息的 speaker

其余 `acl_labels=["locomo"]`、`text`、`dia_id`、`record_kind` 保持原样（R5b 的探针已证 `AOLedger` 会采用 action 里给的 `segment_id`／`participant_id`）。**这样 fallback 视图的 block 数与消息数相等**——请断言 `len(revision.blocks) == len(atoms)`，这是这条链建对了的硬证据。

### 2. 用**生产构造器**建视图与注册表（不要手搓领域对象）

- 视图：`openviking.session.influence_view.build_minimal_fallback_view(session_mapping, clock=None)`。`session_mapping` 需要 `session_id`、`task_run_id`、`purpose=PURPOSE_POST_RUN_INDEX`、`ao_records`（列表，元素是台账行）。台账分页请**沿用生产同一口径**：`trajectory_index_hook._page_ao_records(session_dir, session_id)`，或自己按 `list_ao_ledger(..., include_live=True)` 翻页——**报告里写清你用了哪种**。
- 注册表：`ProjectionRegistry(<path>)` 后 `registry.register(revision, acl_labels=("locomo",))`。**标签必须显式给**：不给就走 `session_acl` 回调，而你没设回调 → 卡片没有标签 → 检索侧 fail-closed，一张都拿不到（`influence_projection.py:620-625`）。
- 门面：`InfluenceProjectionAdapter(registry, views=[revision], content_resolver=<ao_id → 正文>)`。`content_resolver` 是把 AO 正文拼进 BM25 文档的唯一途径（H1 修复，`retrieval_facade.py:1083-1087`）；正文从你 ingest 时留的 `ao_id → text` 表取。其余适配器与既有脚本一致（`ForkBranchAdapter(work)`、`SegmentAtomAdapter(work / session_id, session_id)`）。

### 3. 投影臂的判分（与 P 臂同口径，便于对比）

- profile：`{"fork_branch": 0, "projection": 4, "segment_atom": 0}`（只开投影；fact 座位 0，不受暂停影响）。名字叫 **B 臂**。
- 卡片 → gold 的解析：投影卡片的 `source_pointer` 是 `{"view_revision_id":..., "block_or_claim_id":...}`；要回查到 block 的 `source_refs[*].ao_id`，再经 `ao_id → dia_id` 映射成 dia。**一个 block 覆盖多个 AO 时，把它的所有 dia 都算作该次检索取回**（fallback 每消息一段时就是一个）。取回顺序与 P 臂保持一致：按关键词逐个查询、卡片首次出现的顺序去重。
- 指标：`any-hit@{5,10}`（gold 里有任一 dia 落在前 k）、`B_union_size`、空并集数、按 category 的 `B@10`。
- **同一脚本里照旧跑 P 与 T 两臂**，用来证明你没有意外改掉既有口径：在 HEAD 上 P 必须仍是 `hit@5=0.0% / hit@10=0.0% / 空并集 100%`、T 必须仍是 `56.0% / 61.8%`（若两臂任一不是这个数，先停下报告，不要改基线文件去迁就）。

### 4. 要写进报告的机制核查（不是打分，是「这条链真的通了吗」）

- `len(revision.blocks) == len(atoms)`（每消息一块）与 `revision.construction_mode == "fallback"`。
- 注册表里卡片数 = blocks 数；`registry.search(principal_labels=("locomo",))` 非空；**换一个不相交标签必须拿不到**（fail closed 仍在）。
- 至少一道题上把 B 臂取回的一张卡**手工回溯**到它的 block → AO → dia，确认这条链不是靠巧合命中（打印这一例）。
- **空并集不能是 100%**：如果 B 臂一道题都取不回卡片，那是构造错误（标签／resolver／绑定视图），**报告失败而不是报告 0 分**。
- 把「P 为什么是 0」在报告里写一句（fact 通道暂停，`retrieval_facade.py:114`），避免后来人误读成回归。

## 提交与报告

- 一条提交即可，信息形如 `bench(causal-memory): projection-channel arm on LoCoMo (zero-LLM)`。
- 报告必须写：**新增文件的路径**；`git status` 证明 `l1_locomo_hitk.py` 未变（例如 `git diff --stat` 里没有它）；你用的台账分页方式；B 臂的 hit@5／hit@10／空并集／按 category；P 与 T 的复跑数字（并说明与基线一致）；你自行选定的地方（segment_id 形式、ranking 细节、block→dia 的多 dia 处理）；以及测试／运行的**完整命令**（含 venv 与 `--data` 路径）。
- 运行环境说明：本机**没有 `ov.conf`**。如果你走 `maybe_index_session_trajectory` 之类的生产入口，需要把 `openviking.session.trajectory_index_hook.is_causal_mode_enabled` 打桩成 True（既有测试同法）；如果你直接调 `build_minimal_fallback_view`，则不需要。**别去创建 `ov.conf`**。
- 数据：`--data` 默认沿用既有脚本的 `/home/zhoujie22/river2_0/evol_bench/LoCoMo/data/locomo/locomo10.json`；完整跑 10 个会话（约几分钟），把逐题 JSON 写到 `--out`。
