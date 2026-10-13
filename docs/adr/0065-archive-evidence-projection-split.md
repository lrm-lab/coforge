# 归档证据不可变，fork node 权威记录独立于 archive，投影经 outbox 异步发布

sessions 树不进向量索引是 OpenViking 的既有边界（semantic 索引显式跳过 session URI），而 fork node 又必须可被相似 context 检索。决定三层分离：archive 只保留原文与 AO 台账，`.done` 仅表示"台账证据已提交"；fork node 权威记录写入独立的 `viking://~/causal-experiences/`；检索投影是 outbox 驱动的异步幂等副本（node_id + content_hash），只含检索摘要与指针。读证据正文一律按来源 session ACL 二次授权，检索命中本身不构成越权读取。

## Consequences

- 诊断 agent 作为新写入者只能走受控 write API（propose → 验证 → 原子落库 → 异步投影），禁止直写索引、统计或 archive。
- 想象分支未经验证不得持久化进投影；真实与已验证想象分支必须可按 evidence_status 区分。
