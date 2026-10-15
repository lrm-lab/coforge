# R2b brief：卡片 id 改成不泄漏内部 id（R2 暴露出的设计对不上）

仓库：`/home/zhoujie22/river2_0/OpenViking`，分支：`feat/causal-subgraph-retrieval`（已有 `988148ad8`、`12f783d19`、`c63995f8e`）。**追加新提交；不要 rebase／amend；不要 push；不要动 `benchmark/`（除非签名必须，最小改）。**

## 问题

`openviking/session/influence_projection.py` 现在这样铸造卡片 id：

```python
card_id=f"{kind}:{revision.revision_id}:{entity_id}",
```

于是模型看到的卡片 id 里直接带着内部 id，例如 `claim:rev-deploy-2024:edge-bluegreen`。这与设计对不上：

- `CONTEXT.md`／round-13 术语「卡片 id」：模型拿它指代「刚才那一张」，**不接触内部的 view id 和 claim id**；设计给的例子是 `claim-card-17`。
- 决策 #98（Q131-A）：展开工具的**参数只有 claim 投影的卡片 id**，「服务端解析 view 与 claim。模型不写内部 id」；被否掉的 C 档理由正是「模型若把内部 id 填进去、或猜一个，调用失败」。今天的格式等于把内部 id 递到模型手上，模型照着抄就能自己造 id。
- 决策 #66（在线只用 principal 可见事件、不返回可反推的内部标识）方向一致：跨任务命中时不该把来源 view revision id 直接交给模型。

这是 R2 之前就有的（行 908），R2 把按卡片 id 的入口公开之后它才显形。R2 本身不用改。

## 要做的

1. 卡片 id 改成**不透明、但确定性**的形式：由 `kind` + 冻结 view revision + 实体 id 派生一个短哈希／序号，形如 `claim-card-<8 位十六进制>`、`block-card-<8 位…>`（前缀你定，但要能一眼看出是 claim 还是 block 卡片）。**字符串里不得出现 `view_revision_id`、claim id／block id、session id。**
2. **确定性**：同一份 view revision 的同一个实体，重复投影得到的 card id 必须一致（幂等键、去重、`ProjectionRegistry._entries` 的键都靠它）。换 revision 才能换 id。
3. 服务端保留 `card_id → (view_revision_id, claim/block id)` 的反查（`ProjectionRegistry.get` 今天已经有 `source_pointer`，确认它够用；不够就补最小映射）。展开工具仍只吃卡片 id。
4. 受影响的既有测试与断言要一起更新（凡是硬编码 `claim:rev-...:...` 这种形状的地方）。若 `benchmark/causal_memory/` 里有硬编码，先报告再动。
5. 加一条**不变量测试**：投影出的卡片 id 里不含 `view_revision_id`、不含 claim/block id、不含 session id；且同一 revision 重复投影出的 id 相同。

## 交付要求

- 只改 OpenViking；不加新依赖；不顺手重构无关代码。
- 跑：`uv run pytest tests/test_retrieval_facade.py tests/test_influence_projection.py tests/test_causal_experiences.py tests/test_trajectory_index.py -q -o addopts=''`。已知基线 3 个失败（`test_influence_projection.py::test_acl_change_without_revalidation_callback_warns_once`、`test_trajectory_index.py::test_missing_projection_registry_warns_once_and_still_indexes`、`test_trajectory_index.py::test_supersede_without_revalidation_callback_warns_once`），不改、如实报告。
- 提交到 `feat/causal-subgraph-retrieval`，`fix(session): ...` 或 `refactor(session): ...` 风格，不要 push。
- 回复报：新 commit 短哈希、新卡片 id 的形状与两个例子、反查加／改在哪、不变量测试结果、以及有没有别处依赖旧格式（例如评测脚本、benchmark）需要后续跟进。
