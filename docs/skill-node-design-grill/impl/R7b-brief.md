# R7b 派发件：诊断侧检索的**判别力尺子**（失败子图 → 历史子图／fork；零 LLM／只读／可复跑）

先读 **`impl/R7b-design.md`（本波的设计正文，查询表示与尺子都已冻结）**，再读 `impl/R4a-brief.md`（诊断侧读通道的形状）、`impl/R4a-verification.md`、`impl/R8b-verification.md` §5（为什么「跑一把看看」是本项目已经付过代价的错误）。

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支 `feat/causal-subgraph-retrieval`，基线 **`20175df19`**。**追加新提交；不要 rebase／amend；不要 push；不引新依赖。**

## 0. 一句话

生产今天在诊断侧做的是「把子图的散文取出来跑 BM25」（`_subgraph_retrieval_text` 的文档字符串明说 roles／relation types／failure marker／ids／原始 AO 文本**都被丢掉**，以免两段不相干的散文共享 token）。本波要回答的是：**那些被丢掉的字段，能不能表达散文表达不了的区分**——以及**在真数据上两臂到底有没有差别**。这是判别力测试，不是效果量测试（§4 有硬标签要求）。

## 1. 只做三件事

### 1.1 结构签名与结构匹配器（`benchmark/causal_memory/` 新增文件）

按 `R7b-design.md` §2／§3 实现：

- `structural_signature(revision, subgraph) -> <不可变对象>`：只吐**封闭词表＋整数＋id／哈希**，字段清单与取值见设计 §3 表（`boundary`／`anchor_kind`／`anchor_incidence`／`relation_profile`／`role_profile`／`coverage_crossing`／`member_gap`／`truncation_lines`／`workspace_id`；候选侧另加 `grounding_kind`／`evidence_status`／`overlaps_anchor`／`used_skills` 的**种类**）。position 必须用生产的 `default_failure_grounding_position` 派生，不要自己写一套。**不读任何散文，不读七段。**
- 结构匹配器：逐字段相等计数的**加权和**，权重与字段清单**写成常量并在任何分数之前打印**（建议权重见设计 §3），平局按 `(session_id, subgraph_id)` 字典序，cap=3（与生产 `DIAGNOSTIC_SUBGRAPH_HIT_CAP` 一致）。确定性、无随机。
- **词法臂**：**逐字调用生产** `RetrievalSubgraphAdapter.retrieve_historical_subgraphs(view_revision_id, subgraph_id, principal_labels)`，不许本地重写 `_subgraph_retrieval_text` 或重写排名。报告里必须打印 `SUBGRAPH_TEXT_POLICY_VERSION` 与 `DIAGNOSTIC_SUBGRAPH_HIT_CAP` 的实际值。

### 1.2 L1 判别力夹具（controlled pairs）

按设计 §4-L1 生成，**规则生成、不许手写个案、不许事后增删**：

- 材料：从真实语料克隆（用 R8a 的 14 个冻结修订／15 个 fork 作为语料基底；进程内夹具搭法照 `tests/test_subgraph_forks.py:149-241` 的 `_freeze`／`_store` 那套，**但文件放在 `benchmark/causal_memory/`，`tests/` 一个字都不改**）。
- 每个受控对：**散文逐字节相同**，只有类型化字段不同。四条轴（设计 §4-L1 的 A–D）：`boundary`、`anchor_incidence`、`coverage_crossing`、候选侧 `overlaps_anchor`。
- 报每轴每对的两臂**判别率**＋top-1／top-3／MRR（cap=3）。

**三个探针必须做**（这是本波的真值来源，比判别率更重要）：

1. **洗牌测试**：候选结构字段在候选之间随机置换（固定种子，报告里给种子）→ 结构臂判别率必须落回随机带；**随机带的定义与实测值都要给**（例如「1000 次置换的 2.5–97.5 分位」或「理论 50% ± 2SE」——你定，但要在打分前写死）。
2. **散文互换测试**：受控对两名成员的散文互换、结构字段不动 → 词法臂的选择**跟着散文走**，结构臂的选择**不跟**。两条都要有数字。
3. **隔离测试**：`json.dumps(signature)` 里不得出现夹具散文里任何长度 ≥ 8 的自然语言 token；并断言词法臂用的是生产函数（而不是本地实现）。

### 1.3 L2 真数据切片（14 个真实修订 ＋ 15 个 fork）

- 不算判别力（没有裁决可用），只报：两臂 top-3 集合重叠度、排名秩相关、**逐分歧点的归因**（结构臂为什么把某个候选抬高／压低，是哪个字段）。
- 如果两臂在真数据上排名完全一致，就照实写「**本语料上结构字段在生产通道里是惰性的**」——这是有效结论，不要为了有话说而去调权重。

## 2. 交付与报告

- 两个提交（顺序）：① `bench(causal-memory): diagnosis-side subgraph retrieval discriminates on typed fields`（或同等语义的标题）；不需要 lint 单独提交（本波全新增文件，直接按仓库 ruff 规则写干净即可，`ruff check`＋`ruff format --check` 全过）。
- 产物 `--out` 一个 `report.json`（结构自定，但要把签名字段清单、权重、夹具生成规则、cap、随机种子、三个探针结果、两臂逐 query 读数与 L2 归因都写进去）。支持 `--out`／`--resume` 与 stage 划分（L1／L2 可分开跑）。
- 报告写在你最终消息里，必须包含设计 §4 要求的**标签**：L1 一律标「基于夹具，判别力 ≠ 效果量」；**不许出现「结构臂更好」这类效果量表述**；设计 §7 的四条「本波不回答」要原样出现在报告的「不回答」一节。

## 3. 硬约束

- **不改** `openviking/` 与 `tests/` 的**任何**文件（`git diff --stat` 对这两个路径必须为空）。本波要测的就是生产通道，**改它即自证**。若你发现某种对齐必须改生产代码，**停下来报告**。
- 只动 `benchmark/causal_memory/`（新增文件）。`l1_locomo_hitk.py` 字节不变。
- 只读语料；零 LLM；不加依赖；不 push。
- 不动暂停的 live 栈（`eval/NEXT.md` 的「不要动」清单）；不建 `ov.conf`；不重跑／不重归档 `evo-lsk1`。
- **规则冻结在前**：签名字段、权重、平局、夹具生成规则、cap、种子、随机带定义，全部常量＋**任何分数之前打印**；看到数字后不许改规则／删臂／挑轴。
- 确定性：两次运行 report 逐字节相同（给 SHA256）。

## 4. 门检（任一条不过就非零退出）

1. 词法臂逐字调用生产接口；报告含 `SUBGRAPH_TEXT_POLICY_VERSION` 与 `DIAGNOSTIC_SUBGRAPH_HIT_CAP` 实际值。
2. 隔离测试通过（签名无散文 token）。
3. 洗牌测试：结构臂塌回随机带，且给出随机带定义与实测值。
4. 散文互换测试：词法臂跟散文、结构臂不跟散文（两条都有数字）。
5. 四条轴齐全、每轴判别率与 top-1／3／MRR 齐备；**四个轴的报告顺序与轴定义在打分前写死**。
6. 报告无「结构臂更好」类表述；L1 全部带夹具标签；设计 §7 的「不回答」四条在列。
7. `git diff --stat -- openviking tests` 为空；`git status` 干净；未 push；两次运行产物哈希相同。

## 5. 我会怎么验（提前告知，便于你自检）

我会自己重跑一遍比对哈希；读签发件的权重与轴定义是否真冻结；**自己写一个独立探针复算至少一条轴的判别率与洗牌带**；检查词法臂是否真调生产（不是本地 BM25）；检查 L2 的分歧点归因是否经得起复核；确认 `openviking/`／`tests/` 零改动。
