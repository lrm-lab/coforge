# G4：路径端点直接适用性重验（CONSENSUS 总账 #39 / Q72-A）

仓库：/home/zhoujie22/river2_0/OpenViking（分支 feat/fork-node-foundation，已检出）

## 背景与设计依据
总账 #39（Q72-A）：每条 path ≤2 HypothesisBridge / ≤12 实体 / 禁环之外，"端点必须对原始 query/MemoryTaskState 做直接适用性检查"。check_path_budget 已实现确定性部分（hop/实体/重复边），端点直接适用性缺失（评审 Minor #19 点名）。真实适用性判断是 LLM 判断，库级提供注入位与结构化结果。

## 目标契约
1. openviking/session/causal_bridges.py 的路径遍历/校验 API（traversable_edges 及 path 评估路径）增加 endpoint_applicability 注入：
   `callable(query_context, endpoint_descriptor) -> (ok: bool, reason: str)`
2. 提供时：path 两端点必须通过；未通过的端点使该 path 被剪除，且在返回结构中记录该端点的检查结果（含 reason）供审计；不得静默吞掉。
3. 未提供时：返回的 path 结构带 `endpoint_applicability="unchecked"` 显式标注（可见、可断言），不得默认当作通过。
4. 与 check_path_budget 的组合顺序固定并记录（建议：预算先行、端点检查其后，两者结果放进同一个评估结构）。
5. 不得改变桥治理（per-run 12 / per-node 32 / inactive 规则）与 F2d 的 ACL 参数语义。

## 允许修改的文件
openviking/session/causal_bridges.py；tests/test_causal_bridges.py。

## 验收
新测试：注入"失败端点"→ 路径被剪除且记录 reason；未注入 → unchecked 标注可断言；全部端点通过 → 现有路径行为不变。
`cd /home/zhoujie22/river2_0/OpenViking && python -m pytest tests/test_causal_bridges.py -q` 全绿，粘贴输出。

【硬约束】禁止执行任何 git 命令；只改允许文件。
