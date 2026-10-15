# R1b brief：修正 BM25 的中文分词（R1 缺陷修复）

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（R1 已提交 `988148ad8`）。**追加新提交，不要 rebase／amend 已有提交；不要 push。**

## 缺陷：中文整段被当成一个 token

`openviking/session/bm25.py` 的 `tokenize` 用 `re.compile(r"\w+")`。CJK 汉字属于 `\w`，所以连续中文会被切成**一整个 token**，部分重叠完全算不出来。复现：

```
uv run python -c "
from openviking.session.bm25 import BM25Index, tokenize
q='这次发布必须蓝绿'
idx=BM25Index(['这次发布必须蓝绿','blue environment cutover','文档里只出现一次绿灯','蓝绿发布'])
print(tokenize(q), tokenize('蓝绿发布'))
print([round(s,3) for s in idx.scores(q)])
"
```

结果：`['这次发布必须蓝绿'] ['蓝绿发布'] [1.394, 0.0, 0.0, 0.0]`。也就是 query 只与**逐字相同**的那条文档命中，含「蓝绿发布」的 fork 文档得 0 分。

但设计记录里这一档的期望不是这样。`skill-node-design-grill/round-12-questions.md` 的 Q127 A 档原文：「三份语料都用 BM25。甲和写了「蓝绿发布」的 fork 排到前面。乙没有共同词，不进这 12 张。丙若只共享「绿」这个很常见的片段，分低于甲。」——「只共享『绿』这个片段」必须能算成重叠。「蓝绿发布」与「这次发布必须蓝绿」也必须能重叠。

现有新增测试全是英文（`apple apple apple`、`zephyr`），所以这条没被覆盖。

## 要做的

1. `tokenize` 改成：**CJK 汉字逐字成 token**（CJK 统一表意文字 U+4E00–U+9FFF，含扩展 A U+3400–U+4DBF；其余非 ASCII 字母按你判断，保持简单即可），拉丁字母／数字／下划线连成的词保持整词，标点作分隔符，`casefold` 保留。若你认为二元组（bigram）更合适，先说明理由，并保证下面第 3 条的期望全部成立；默认按单字实现。
2. 其余语义不许变：空 query → 全 0 分、保持写入顺序；非空 query 且 0 分 → 不进结果；标准 BM25，k1=1.2、b=0.75 可传参，Lucene 变体 IDF。
3. 加中文测试，用 round-12 Q127 那个例子做一条端到端：query「这次发布必须蓝绿」，语料含 (a) 完全同文的甲、(b) `green environment cutover` 的乙、(c) 只出现一次「绿灯」的丙、(d) 含「蓝绿发布」的 fork 文本。断言：甲排最前；含「蓝绿发布」的那条排在丙之前且分数 > 0；乙 0 分、不进结果。(e) 另加一条纯英文语料的测试，确认既有英文行为不回归。
4. 顺手标注一个待定参数：`HYBRID_BM25_WEIGHT = 0.25` / `HYBRID_VECTOR_WEIGHT = 0.75` 在设计记录里**没有出处**（CONSENSUS.md 决策 #95／叙述 86 只规定「把 BM25 与真实向量合成名次」，没定权重和合成公式）。请加一个 policy 版本常量（例如 `HYBRID_FUSION_POLICY_VERSION`），在注释里写明它是待定参数、需要设计确认，并在回复里说明你取这两个值的理由。不要把它当成已定设计。
5. 测试：`uv run pytest tests/test_retrieval_facade.py -q -o addopts=''` 必须过。已知基线就有 3 个失败（`test_influence_projection.py::test_acl_change_without_revalidation_callback_warns_once`、`test_trajectory_index.py::test_missing_projection_registry_warns_once_and_still_indexes`、`test_trajectory_index.py::test_supersede_without_revalidation_callback_warns_once`），不要试图修它们，如实报告即可。
6. 回复报：新 commit 短哈希、`tokenize` 的新行为（给两三个中英混排的例子）、中文测试结果、混合权重的理由。
