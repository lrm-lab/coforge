# Memory Agent 使用受限的 role-scoped T_log capability profile

完整论文 `T_log` 检查工具面包含十个操作，但“使用同一 T_log adapter”不表示 Memory Agent 获得所有操作或论文原始返回语义。生产设计以 role/principal/scope/pinned watermark/SearchPlan/budget 生成 capability profile；每次调用逐次重验 ACL、计费并审计。Memory 的稳定群成员身份不能给构图或诊断角色代查，也不能扩大来源 session ACL。

| 操作 | 完整检查语义 | Memory Agent profile |
|---|---|---|
| `get_overview` | 日志步骤数、参与 agent 与大小等紧凑元数据 | 默认允许；只覆盖固定 scope/watermark，敏感元数据按 ACL 裁剪 |
| `read_full_log` | 拼接读取全部步骤 | 仅 evidence escalation；须显式理由、scope、预算与 ACL，禁止启动时自动注入 |
| `read_step` | 读取单个步骤 | 默认允许；必须引用当前快照中的稳定步骤位置并逐次重验 ACL |
| `read_step_range` | 读取闭区间步骤 | 默认允许但区间有界；跨 Segment/session 或 redacted 位置不得静默拼接 |
| `list_agents` | 论文版列出 agent 及完整 system prompt | 条件/脱敏；仅返回调用者可见的 identity、role、capability，不返回其他 agent 完整 system prompt |
| `get_question` | 返回原始用户问题 | 默认允许；仅当前 task/scope，仍受内容 ACL 与撤回状态约束 |
| `search` | 对步骤内容做正则搜索，论文上限 20 matches | 默认允许为受限 current-log exact search；固定 scope/watermark、逐命中 ACL、有界结果，输出当前 evidence refs；不作跨 corpus 语义检索 |
| `list_block_kinds` | 返回 AIG 封闭 block kind 词汇表和必填字段 | 当前 Memory profile 不开放；属于构图/核验 schema 能力，Memory 不创建或修改图 |
| `get_story` | 将当前图渲染为 Markdown | 只读当前 scope 内已冻结图；跨任务完整图须已知 ref、逐 ref ACL 与适用 escalation；mutable draft 永远不可见 |
| `get_graph` | 以 JSON 返回当前图 | 与 `get_story` 相同，只允许冻结 revision；不能读取 Builder draft、Critic 私有状态或未冻结内容 |

无论 profile 如何，Memory 永远没有 `T_build`、AO/Interaction DAG 事实写入、AIG draft 修改、Fork 权威提交或 Agent Evolution 发布权限。`memory-search-entry/Q134-B` 规定受限 `T_log.search` 不再作为群 Memory Agent 面前的第二个公共搜索工具，而由单一 `retrieve(SearchPlan)` facade 作为 `current_log_exact` lane 调度；它与 typed `memory_discovery` lane 只共享 ACL/scope/watermark/父级预算/审计等横切治理，不共享分数、TopK 配额、证据语义或记账。

## Implementation status

- OpenViking `session/retrieval_facade.py` 已有跨 fork/branch、frozen projection、segment/atom adapter 的 typed BM25/vector retrieval 与配额/ACL/rerank，但不是论文的 exact log search。
- OpenViking `session/ao_ledger_reader.py` 已有 pinned snapshot pagination 和逐 AO evidence 读取，目前没有论文式 regex `T_log.search` adapter。
- Coforge Group Memory 目前另有基于 pg_trgm 的 seed retrieval 与有界 exploration session；它尚未与 OpenViking typed facade 或 `T_log.search` 统一。

## Consequences

- 工具注册必须由 profile 生成，而不是把完整论文工具数组直接暴露给 Memory。
- `list_agents` 的生产语义刻意比论文版本更窄；这是防 system-prompt 泄漏的安全边界。
- “默认允许”仍不代表预加载；raw AO 和跨任务完整冻结图继续遵循 summary-first、known-ref 与按需 escalation。
