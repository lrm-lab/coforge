# G3：provisional 槽 3 exploitation + 1 seeded exploration（CONSENSUS 总账 #54 / Q87-A、Q91-A）

仓库：/home/zhoujie22/river2_0/OpenViking（分支 feat/fork-node-foundation，已检出）

## 背景与设计依据
HybridRetrievalFacade（openviking/session/retrieval_facade.py）目前 provisional 通道按 in_channel_rank 截断。设计契约（CONSENSUS 总账 #54，Q87-A）：
- provisional 默认 4 槽采用 3 exploitation + 1 seeded exploration；
- 记录 eligible set、selection propensity、seed 与 policy version；
- 无合格探索项时回填 exploitation。
Q91-A：exploration 候选标记 `selection_mode=exploration`；其后续 disposition/adoption/outcome 照常记录（本切片只做检索侧标记，不做去偏信号）。

## 目标契约
1. provisional 配额 n≥2 时：前 n-1 席为 exploitation（维持现有 in_channel_rank 顺序），第 n 席为 exploration：从"未被 exploitation 选中、且通过既有 ACL/状态门槛"的 provisional 候选中，用带 seed 的确定性随机选择。
2. seed 来源：构造参数 seed（可选）；未提供时从查询输入确定性派生（对查询关键输入做稳定哈希，如 sha256 前 8 字节 hex），同输入同选择、可复现、可审计。
3. RetrievalResult 增加选择审计字段（如 selection_audit）：包含 eligible_set（候选标识列表）、selection_propensity（所选候选的入选概率，如 1/len(eligible)）、seed、selection_policy_version、backfill 标志。
4. exploration 卡片标记 `selection_mode="exploration"`，exploitation 卡标记 `"exploitation"`（卡片信封字段；fact/verified 通道缺省 exploitation）。
5. 无合格探索候选：第 n 席回填 exploitation，audit 记 `backfill=true` 及原因。
6. 12 总帽、8/4 通道、fact 通道、ACL-先于-配额（F2c）、rerank 后夹回 12（F2c）全部不得破坏。
7. profile 调大 provisional 配额时同样按 (n-1)+1 规则。

## 允许修改的文件
openviking/session/retrieval_facade.py；tests/test_retrieval_facade.py。

## 验收
新测试至少覆盖：4 槽时恰 3+1 且 exploration 卡来自 exploitation 未选中的候选；同 seed 同查询两次结果一致、不同 seed 可不同；无候选时回填且 backfill=true；卡片带 selection_mode；现有全部测试保持通过。
`cd /home/zhoujie22/river2_0/OpenViking && python -m pytest tests/test_retrieval_facade.py -q` 全绿，粘贴输出。

【硬约束】禁止执行任何 git 命令；只改允许文件；不得放宽既有 ACL/配额/夹紧逻辑。
