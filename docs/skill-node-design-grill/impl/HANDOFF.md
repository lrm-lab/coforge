# 夜间实施交接报告（fork-node 地基，OpenViking 侧）

日期：2026-09-23 深夜。执行：ZCode 编排，cursor-agent 实现，kiro 仲裁一次（S5b）。设计依据：`/home/zhoujie22/river2_0/skill-node-design-grill/CONSENSUS.md`（8 轮 grill、49 问、39 条决策）+ 9 个 ADR。

> **第二轮实施（2026-09-24，Round 9/10 设计落地）追加于文末「Round 9/10 实施报告」节。**

## 交付物

仓库 `/home/zhoujie22/river2_0/OpenViking`，分支 **feat/fork-node-foundation**（自 main e44ea6e11 切出），7 个提交：

| 提交 | 切片 | 内容 |
|---|---|---|
| 79970fcf5 | S1 | AO 台账核心：不可变 AORecord（全局 ao_id、session 内单调 sequence、确定性 synopsis observation、必有 skill_invocations）、独立 AOAttribution、线程安全 ao-ledger.jsonl |
| 7caa92991 | S3 | memory.skill_trajectory_mode = legacy\|causal 版本化开关（默认 legacy，全局作用域；workspace/session 覆盖是预留 kwargs） |
| 55ad5fd4b | S2 | session 挂钩：add_messages_async 后采集工具交互（异常吞掉记日志）；commit Phase 1 写 archive_NNN/ao-attribution.jsonl（幂等并集，绝不改台账）；session.py 仅 +6 行 |
| 92a3ffbd6 | S4 | 读取 API：list_ao_ledger（冻结快照 watermark 分页、include_live 显式、committed 标注）+ get_ao_evidence（acl_check 钩子） |
| dae606637 | S5 | causal-experiences 存储：三种锚点（ao / session_state / interaction_edge）、九字段 EvidenceRef、Q29 双字段 hindsight 硬隔离（contemporaneous 严格早于锚点 sequence）、content_hash、稳定锚点身份复用、幂等 upsert、causal 闸门 |
| f1fabb787 | S5b | kiro 仲裁落地：session_state 锚点身份只含 {anchor_kind, session_id}（watermark 留在 revision）；revision 权威顺序 = supersedes 链，孤儿 sibling 按 (created_at, revision_id)，不推断互相 supersede |
| 79114d388 | S6 | 已验证相似边（四维判定、四值 verdict、negative 标记不召回）+ 中心式可重叠簇（成员须与 center 有正向边、版本化 .vN 历史、merge/split 走 successor） |

另：9 个设计 ADR 已移植到 `.worktrees/cursor-ov-cm-impl/docs/adr/0063-0071`。

## 验证

- 新增 6 个测试文件 **43/43 通过**（每个切片均由编排者独立复跑 + 冒烟，非仅采信 cursor 报告）。
- 回归：`tests/unit/session` 分支 4 failed / 260 passed，与 **main 基线完全一致**（同一 worktree 对照跑过），零回归。4 个既有失败为环境依赖（cluster.json、Jinja init_value 等），与本分支无关。
- 仓库环境变更（透明记录）：用户级安装了项目依赖 + pytest_asyncio + pytest-cov（--user --break-system-packages）；OpenViking 仓库设置了 repo 级 git 身份 me-frankan（沿用 coforge 同机身份）。

## 已知限制与后续切片建议（按优先级）

1. **extract_skill_invocations v1 恒返回 []**——台账的 skill 调用记录需要从 skill 执行路径拿 skill_uri + revision_hash（Q27 运行时采集契约），需接 openviking/session/skill/ 的调用方。
2. **重复记账**：同一批消息若重复喂给 add_messages 会产生重复 AO 记录（无 message_ref 去重）；接诊断 agent 前建议加 (message_id, tool_id) 去重。
3. **ACL 是钩子不是实现**：get_ao_evidence 的 acl_check 默认允许；真实来源 session ACL 接线待做（设计 Q28）。
4. **causal-experiences 是文件级存储**：未暴露为 viking:// 命名空间、无 HTTP 路由、投影/outbox/embedding 索引（Q19/Q16 检索入口）未建。
5. **评估编排未接线**：fork 权威提交 → daemon 七步 replay 判定 → guidance append 的触发链（Q37）需要 coforge 侧配合。
6. **开关仅全局作用域**：workspace 覆盖与 session 创建时固化（Q15）未实现，函数签名已预留。
7. 本机存在需要 /local/_system/runtime_config/cluster.json 等资源的集成测试，无法在此环境验证。

## 设计→实现对照索引

- CONSENSUS 第 2-3 条（AO 台账）→ ao_ledger.py / ao_ledger_recorder.py
- 第 4 条（开关）→ memory_config.py
- 第 17/21 条（读取与身份）→ ao_ledger_reader.py
- 第 19-20、23-25 条（fork schema 与存储）→ causal_experiences.py
- 第 29-31 条（相似边与簇）→ causal_clusters.py
- 第 24 条（九字段 provenance）→ causal_experiences.EvidenceRef

## Round 9/10 实施报告（2026-09-24）

执行：ZCode 编排，cursor-agent（grok-4.7，API key 认证）实现，9 个切片、3 波并行派发（波内文件互不重叠）。设计依据：CONSENSUS.md 叙述 72–85 / 总账 #81–#94 + ADR 0010–0013。仓库 /home/zhoujie22/river2_0/OpenViking，分支 feat/fork-node-foundation，9 个新提交（b7ed9db89…116a32e5f），编排者逐切片独立复跑测试后提交。

| 切片 | 提交 | 内容 | 测试 |
|---|---|---|---|
| S7 | b7ed9db89 | Influence View 层核心：Block/Claim（单 participant/同 segment/连续 AO 校验）、coverage_manifest、draft→≤3 轮 critic→freeze（content_hash）、确定性结构校验（含 failure_diagnosis 的 root→sink 弱连通）、deterministic fallback、按 (session, purpose) 的 ViewSupersedeIndex（Q111） | 9 |
| S8 | 21e56033d | ForkRevision 三阶段（draft→provisional→validated/invalidated，幂等键复用）、InfluenceGrounding 快照（view+位置+摘要+hash）、(view, position) 反向干预史索引、mark_needs_revalidation、无 citation 改状态 API | 4（+原 10 不破坏） |
| S9 | 978cd2483 | Hypothesis/EvidenceBridge 分型、judgment 事件全留档、endpoint+relation 去重、per-run 12 / per-node 32 治理、inactive/reactivated（exposure/traversal 拒绝）、显式证据晋升、path 预算 ≤2 hops/≤12 实体/禁环 | 6 |
| S10 | 8db8864cb | CitationLedger：citation/hint_exposure/index_level_exposure 三类不可变事件、双维强度（task_id 同异分维）、7d/90d 指数衰减（policy-versioned 纯函数式重算）、ACL-safe visible_strength（无隐藏计数字段）、索引级曝光绝不入强度、bridge_id 归因 | 6 |
| S11 | 5b9a31c89 | 台账三缺口修复：skill_invocations 真实接线（skill_uri+revision_hash，缺源记结构化 unknown 不推断）、(message_id, tool_call_id) 去重、ACL default-deny + register_session_acl 注册口 | 24（含原测试） |
| S12 | fbdf7bfaa | TrajectoryIndexService（优先级 evaluation>failed>succeeded、预算/速率/paused、超限明确 Skipped 不伪装、builder 空则 fallback）+ InfluenceProjection 卡片（ACL 标签继承、verified 晋升需 validated grounding、ACL 变更撤下留审计） | 16 |
| S14 | a6f324548 | MemoryHint（多来源合成、不可执行）、MemoryDisposition 独占采纳、Followthrough/Outcome 独立追加、投递节流（未决≤2/冷却 300s/同 provenance 只刷 TTL）、defer_all/blocked_kinds 偏好、TTL 过期仅 exposure | 6 |
| S13 | c1b37d07b | HybridRetrievalFacade：三 corpus adapter、统一信封（kind/channel/in_channel_rank/status/source）、12 总帽 6/4/2（profile 可调总帽不变）、8/4 通道仅状态对象+回填、fact 通道、依赖模式查询（carried_artifact/downstream_effect 匹配）+冻结视图内 Claim 邻域读时拼装 ≤12 实体 | 6 |
| S15 | 116a32e5f | EvaluationOrchestrator 状态机（守卫表、proposal 不能迁移、四停止条件、WAITING_EXTERNAL/resume）+ DiagnosisBrief/DiagnosisOutcome 内容寻址信封（幂等键 iteration+kind+manifest_hash、at-least-once 同结果、credential 字段名构造即拒） | 12 |

验证（编排者独立复跑，非采信报告）：16 个测试文件共 **107 passed**；回归 `tests/unit/session` **4 failed / 260 passed 与 main 基线完全一致**（同 4 个既有环境失败），零回归。

已知边界（诚实记录）：全部为库级实现（进程内 + JSON/JSONL 持久化），未做 HTTP 路由 / viking:// 命名空间 / 常驻 daemon / 真实 LLM builder 与 reranker（留注入位）；S11 的 ACL 是 default-deny 协议口，真实 session 权限模型仓库内不存在，接线待上游提供；embedding_stub 为占位；S15 的状态机事件 payload_hash 为占位哈希。派发原始日志：impl/S7–S15-cursor-raw.log（S8 首发因 key 手误认证失败已重派）。

## 评审修复轮（2026-09-24 晚）

背景：cursor 架构评审（review-cursor-raw.log，19 条发现：3 Critical / 13 Major / 3 组 Minor；主 agent 抽查 7 条指控全部属实）后，P0+P1 共 8 个修复切片两波并行派发（F1a-F1c / F2a-F2e），8 个提交（44f719f16…9cff88444）。

| 切片 | 修复内容 |
|---|---|
| F1a | provisional 幂等崩溃窗口（revision 在盘+幂等文件缺失→内容一致返回原结果）；干预史损坏隔离（禁空表覆盖）；query_intervention_history 逐条 ACL（无隐藏计数）；upsert 禁直写 validated/invalidated |
| F1b | supersede 后旧投影退出检索（registry 联动+审计）；注册重放按 content_hash 判重；低优先级 job 延后不丢弃 |
| F1c | envelope 同键不同正文报 EnvelopeConflict；凭证黑名单补 password/bearer/authorization/cookie/apikey/session，hash 白名单精确化；verify_manifest 校验口 |
| F2a | append_validated 补全 Q81 五门（anchor_valid/四维适用性/反例/无高危矛盾/ControlContract），缺项保持 provisional 返回 missing_requirements；freeze 默认拒绝 high violation（enforce_checks 逃生口）；fallback 视图补虚拟 root/sink |
| F2b | promote_to_verified 必须读权威 validated grounding（position_match），静态断言需 fork_provenance，fallback 视图拒绝晋升；ACL 撤下/supersede 触发 mark_needs_revalidation 回调 |
| F2c | ACL 先于配额过滤（不可见卡不占名额）；rerank 后夹回 12（truncated 标志）；branch 通道跟自身 evidence_status；projection adapter 走 registry.search |
| F2d | materialize_strength 的 principal 必填、events 分管理员路径；list_bridges/traversable_edges 带 ACL；judgment+bridge 合一可重放恢复单位（同 judgment_id 幂等）；坏行统一跳过+计数 |
| F2e | 去重 fallback 稳定键（两键皆失拒绝写入）；disposition 每 hint 一次（amend 只改 reason 不翻 decision）；编排器 FREEZE_BRIEF/COMMIT_REVISIONS 需迁移证据 |

跨切片集成适配（编排者手修，非派发）：F2a 收紧 validated 门槛后 F2c 的 facade 测试 fixture 需补全五门证据与静态晋升 provenance；带环视图的读取截断测试改走 enforce_checks=False（生产默认仍严格，读取侧环截断保留为纵深防御）。

验证：16 个测试文件 **153 passed / 0 failed**（修复轮净增 46 项测试）；unit/session 4 failed / 260 passed 与 main 基线一致。P2 延期项（未做）：时钟注入补全（view/bridge/fork/AO ledger）、citation fsync、3+1 seeded exploration、端点直接重验、并发席位结构、outcome utility 计算函数、按 task lineage 的冷却、用户静默偏好入口（F2e 部分覆盖）。评审原文与修复日志：review-cursor-raw.log、F1a-F2e-cursor-raw.log。

## P2 清零与评测循环最小跑通（2026-09-28）

执行：ZCode 编排，cursor-agent 实现，7 个切片两波并行派发（波内文件互不重叠），7 个提交（34bf61f8c…a16e20a60）：

| 切片 | 提交 | 内容 |
|---|---|---|
| G1 | 34bf61f8c | 时钟注入补全：influence_view / causal_bridges / causal_experiences / ao_ledger(_recorder) 全部接受 `clock`（缺省 None 保持现行为）；固定时钟测试断言落盘时间戳等于常量 |
| G2 | d85ca72c5 | citation ledger 追加 fsync（`fsync_on_append` 缺省 True，对齐 bridges 侧策略） |
| G3 | f9956a129 | provisional n-1 exploitation + 1 seeded exploration（总账 #54/Q87-A）：确定性 seed（构造参数或查询哈希派生）、SelectionAudit（eligible_set / propensity / seed / policy_version / backfill）、卡片 selection_mode（Q91-A）；抽取发生在 adapter ACL/状态门之后，F2c 的 ACL-先于-配额与 rerank 后夹紧不变 |
| G5 | efbdf1745 | WorkerSeatPool（总账 #58/#69/#100）：total=5 非阻塞 acquire、独立诊断子池 ≤3、held_snapshot 审计；迁移进 DIAGNOSIS 的守卫校验诊断批量（加在 F2e 证据守卫之后，不取代） |
| G6 | 5619a43c5 | 投递节流键改为 (target_agent_id, task_lineage_id)（缺省 "*" 桶兼容旧行为）；新模块 outcome_utility：纯函数聚合，adoption(adopt)+followthrough(完成)+正向 outcome 三者齐备才计 positive，policy-versioned，三缺一不计 |
| G4 | 2b08dd755 | 路径端点直接适用性重验（总账 #39/Q72-A）：`endpoint_applicability` 注入 callable(query_context, endpoint)→(ok, reason)，失败端点剪除路径并留审计，未注入显式标 `unchecked` 不默认放行；与 check_path_budget 结果并入同一评估结构 |
| E1 | a16e20a60 | MinimalEvaluationLoop（评审 #15 收口）：brief 经 handoff envelope 幂等投递 → 注入 diagnosis_fn → 提案只走 commit_provisional（validated/invalidated 落盘前拒绝）→ hint 带 task_lineage 投递 + citation 记账 → 沿用既有停止条件；事件 payload_hash 换为 content_address 真实哈希；同 iteration 重放逐层幂等（brief/fork/hint/citation 均不重复） |

验证（编排者独立复跑）：19 个测试文件 **199 passed / 0 failed**（本轮净增 46 项）；`tests/unit/session` **4 failed / 260 passed 与 main 基线一致**（同 4 个既有环境失败），零回归。

另：设计 ADR 0010–0013 已移植 coforge worktree `.worktrees/cursor-ov-cm-impl/docs/adr/` 为 **0072–0075**（commit 14a33de6，仅新增 4 个文件，未触碰 worktree 内他人未提交改动；0010 内部引用 ADR-0013 已同步改为 ADR-0075）。

分支状态：feat/fork-node-foundation 累计 31 个提交（S1-S15 + F1a-F2e + G1-G6/E1）已合回 OpenViking main（本地 fast-forward，未 push）。

明确出栈的后续（依赖宿主系统，非本仓库可独立完成）：真实 LLM builder/critic/reranker 注入、HTTP 路由 / viking:// 命名空间 / 常驻 daemon、真实 session 权限模型（上游提供）、embedding 索引（现为占位）、AIG 调研报告第 7 节的 A–F 评测阶梯。派发原始日志：impl/G1-G6/E1-*-cursor-raw.log。

## 与 origin/main 本地整合（2026-09-28，按用户指示收尾不 push）

main（原落后 origin/main 95 提交）合并 origin/main，合并提交 fead86677。冲突仅 session.py 一处（远端把 session.py 大幅重构：-2528 行，usage 跟踪 API 整体删除、工具外化逻辑外移至 tool_output_externalizer / working_memory / archive_store / checkpoints）：

- **解决方式**：重构块按远端侧（删除被外移方法与 `used()`）；import 区双侧保留（远端新 import + 我们的 ao_ledger_recorder import）。
- **存活的钩子**（自动并入新结构）：`maybe_record_session_tool_exchanges`（add_messages 路径）、`maybe_write_session_archive_attribution`（commit 归档路径）。
- **语义影响（如实记录）**：`note_skill_invocation` 原挂在 `session.used()`，随远端删除 usage API（方法/router 调用/测试三层一致删除）而失去运行时入口。**skill 捕获主路径不受影响**——recorder 直接读 ToolPart 的 `skill_uri`（ao_ledger_recorder `_tool_call_dict`），无注册字段时按 S11 契约记结构化 unknown 不推断；`note_skill_invocation` 进程级 API 保留（test_skill_invocation_capture.py 直测），上游恢复 skill 执行信号后一行即可重接（revision_hash/invocation_id 富化待此）。
- **memory_config.py** 自动合并成功：远端 SessionAutoCommitConfig 重写（enabled / scan_rate_limit）与我们的 `skill_trajectory_mode` 开关共存。

验证（与 origin/main 基线逐条比对，temp worktree 对照）：我们的 20 个测试文件 **205 passed / 0 failed**；`tests/unit/session` 6 failed / 263 passed 与 origin/main 基线**失败集合逐条一致**；`tests/session` 492 条失败/错误与远端基线**逐条一致**（真实 LLM/集群环境依赖，非合并引入）。零合并回归。本地 main 领先 origin/main 32 提交，未 push（用户指示）。
