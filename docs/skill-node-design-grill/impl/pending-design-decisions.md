# 待设计确认清单（实现侧攒下来的，2026-09-29）

> **状态注记（2026-10-12）：** 这是 ADR-0043 前的实现侧对账和历史问题台账，不是当前产品需求 frontier。其未结项不得覆盖或弱化 [ADR-0043](../docs/adr/0043-aig-native-fork-overlay-and-guided-remediation.md)、`CONTEXT.md` Q166–Q189 或 Q165-A 关闭的实施闸门；涉及 Claim/Cut/独立 ForkRevision 新写模型的项仅可用于 legacy 审计或迁移准备。后续只读复验、缺口归档或延期理由整理仍可引用本文件。

来源：R1–R5b 实现期间，设计与代码对不上、或设计没写、实现只能自己选一处的地方。每条给：设计原文 → 实现今天怎么做 → 要定什么 → 我的建议。**用户 2026-09-29 授权编排侧代定**：已裁定的四条写入 `CONSENSUS.md` #116–#119（理由见 `decisions-20260929.md`），本清单里第 5、8 条由 #118／#116／#117 结案，其余仍待定。

---

## 1. 混合检索的融合权重（R1／R1b）

**设计原文**：决策 #95／叙述 86 只要求「把 BM25 和真实向量合成一个名次」。没有权重，没有公式。
**实现今天怎么做**：BM25 与真实向量各做 min-max，再加权求和，向量 `0.75`／BM25 `0.25`，标了 `HYBRID_FUSION_POLICY_VERSION = "hybrid-fusion-pending-v0"`。
**要定什么**：这组权重与「先 min-max 再加权」这个公式算不算设计。
**我的建议**：这组数可以先用，但要知道它有一个性质：向量权重必须**大于一半**，真实向量才能把较弱的 BM25 命中顶到前面（对半开时两篇文档会打平，只能靠写入顺序分胜负）。若以后接了真向量，这一层值得回看。

## 2. 失败子图看结论块还是看显式标记（R3／R4a）

**设计原文**：叙述 94／决策 #103 说「含 `conclusion` 块的检索子图是失败子图」；叙述 99／决策 #108 说「失败标记由提取模型写入，诊断 agent 不改标记」；`CONTEXT.md` 术语「失败标记」的 `_Avoid_` 把「只用角色为 conclusion 的块」列为反模式。
**实现今天怎么做**：`is_failure` 只读 `failure_marked`，不从块角色、不靠关键词推。含 conclusion 块但没打标记的子图校验通过、不算失败子图，且有测试钉住。
**要定什么**：#108 是否已经取代 #103？还是两条要同时成立（既有标记、又有 conclusion 块）？
**我的建议**：按 #108 ＋ `CONTEXT.md` 走（显式标记），把叙述 94／#103 那句当作 Q142 阶段的前身措辞改掉或加注。

## 3. 「子图内 block 不超过 12」加在哪（R3）

**设计原文**：决策表 #104 只写「一次最多返回 3 份，不足不回填」；叙述 95 把「子图内 block 不超过 12」和这 3 份帽写在同一句。
**实现今天怎么做**：冻结前校验，超过 12 个 block 就 `subgraph_block_limit` 拒绝。
**要定什么**：12 是写子图时的约束，还是只约束检索交回的历史子图？
**我的建议**：留在写时拒绝——它比决策表更严，但更早暴露问题；若只想约束返回，改成命中时裁剪也行，改一处。

## 4. 历史语料是否只召回带失败标记的子图（R4a）

**设计原文**：决策 #102 只约束发起侧（「只有失败子图发起诊断检索」）；#104／`CONTEXT.md`「诊断子图命中」只说「一份历史检索子图」，没写历史侧要不要带标记。Q143 的例子把「没有 fork」的第三份历史子图算在三份里。
**实现今天怎么做**：语料是 `post_run_index` 修订上**全部**子图，只有发起侧要求 `is_failure`。
**要定什么**：设计本意是「历史子图」还是「历史失败子图」？
**我的建议**：维持现状（全部），因为 Q143 的例子与 `CONTEXT.md` 措辞都指这个方向；若本意相反，是设计文本没写清，补一句即可。

## 5. fork 写盘路径不带 ACL 门（R4b，我实测过）——**已结案：#118**（`workspace_id` 在生产即 owner 标签，写入侧要求 `workspace_id ∈ workspace_labels`，fail closed）

**设计原文**：设计没写；但 `retrieval_facade.py` 的在线围栏与 #66（在线只用 principal 可见事件）要求的姿态是 principal 过滤。
**实现今天怎么做**：`persist_provisional_draft` 跳过 `ServerChecks`（`anchor_exists`／`refs_exist`／`provenance_valid`／`acl_allowed`／`acl_hook`），只写 `provisional`；`workspace_id` 由调用方给，原样记进干预索引的 `security_labels`，而干预历史的 ACL 判断正是拿它与 principal 求交。生产上另一条 fork 写路径（`evaluation_loop.py:352` → `commit_provisional`）是带这个门的。
**我实测到的后果**：源 session 的 ACL 是 `team-a`，写入时把 `workspace_id` 填成 `team-foreign`，fork 照样落盘；诊断命中里 `team-a` 看到 0 份接地 fork，`team-foreign` 看到 1 份。
**要定什么**：补法有三种形状——(a) 调用方按 `ServerChecks` 形态给证明；(b) 写入侧用 `session_acl(revision.session_id)` 校验 `workspace_id` 相交；(c) 保持信任调用方，只写文档。
**裁定（#118）**：取 (b) 的形状——`workspace_id` 的生产语义就是该会话的 owner 标签，写入侧要求 `workspace_id` 属于调用方以数据形式给出的 `workspace_labels`，不属于即拒。比 (a) 省：不需要新的证明形态，也不必把 ACL 回调注入写模块。R5c 实现。

## 6. 两份失败子图共享同一个失败 AO 时算几份 fork（R4b）

**设计原文**：#106「每个带失败结论的子图各发起一次诊断检索，各写一份普通 fork」。
**实现今天怎么做**：锚点取自 `failure_evidence_refs[0]`，锚点身份相同就会复用**同一个 fork 节点**，成为该节点的两条 revision，不是两个 fork 节点（既有「同锚点复用」规则，没有另造身份）。
**要定什么**：这种情况算一份还是两份？两份子图的失败证据指向同一条 AO，本身是不是提取模型的异常？
**我的建议**：先按现状（一个节点两条 revision），并在提取侧要求失败证据尽量指向各自的结果。

## 7. 出参里要不要带内部 id（R4a／R4b 未越界，但值得顺手确认）

**设计原文**：术语「卡片 id」与 #98／Q131-A（模型不接触内部 id）、#66（不返回可反推的内部标识）。
**实现今天怎么做**：混合检索的卡片 id 已在 R2b 改成不透明哈希；诊断子图命中里目前带 `view_revision_id`、`session_id`、`fork_node_id`、`revision_id`（模型可见的 `text` 里只有七段＋分支摘要，没有 guidance 与原始 AO）。
**要定什么**：诊断命中里的这些服务端字段，模型能不能看到？还是只给不透明 id？
**我的建议**：与混合检索的卡片 id 拉齐——命中里给模型看的引用改成不透明 id，内部 id 留在服务端。

---

## 8. #82 的「旧投影退出索引」还差一环：生产侧没有任何 ACL 标签来源（R5a）——**已结案：#116／#117**（标签取 `user:{user_id}`，解析顺序 ctx → .meta → URI user 段；不新建检索侧开关）

**设计原文**：决策 #82「独立异步索引服务：预算/优先级/降级/暂停，**supersede 旧投影退出索引**」；#85／#86（投影通道跟随 grounding、ACL 变更触发再投影/撤下 + needs_revalidation）。
**实现今天怎么做**：R5a 把索引服务挂上了 commit，但没有注入 `projection_registry` 与 `revalidation_callback`（作者主动报了这一条），所以生产上 `ProjectionRegistry.register`／`withdraw_superseded`／`needs_revalidation` 都还不会发生。
**卡在哪**：`ProjectionRegistry` 的构造需要 `session_acl(session_id) -> labels`，而生产环境**没有任何会话标签来源**；`TrajectoryIndexService` 的 `builder`／`projection_registry`／`revalidation_callback` 也都没有生产构造点。
**要定什么**：生产环境的会话 ACL 标签从哪来（workspace 标签？账号标签？谁提供这个回调）？定了才能补 R5c。
**裁定（#116／#117）**：标签来源＝owner 的 `user:{user_id}`（解析顺序 ctx.user.user_id → .meta.created_by_user_id → 会话 URI 的 user 段；解析不出即不可见）；不新建检索侧开关，也不受资源侧默认关闭的 `AccountAclSettings.enabled` 影响。R5c 实现。**读侧接线仍留在 R6**。
**已勘查（`R5c-acl-source-recon.md`，2026-09-29）**：仓库里**已经有一套语义完全一致的生产 ACL 标签空间**——`openviking/storage/acl.py:192` 的 `acl_principals(ctx) = {user:{user_id}, "user:*", group:{gid}...}`，`acl_allows` 就是集合求交，与 `_labels_visible` 同形；已有生产接线在向量索引租户过滤与文件读门上，但 `is_acl_uri` **只覆盖 `viking://resources`**。候选来源三档：(A) 只用 `user:{user_id}`（＋`user:*`），Phase 1／Phase 2 都拿得到 owner，**不必扩队列消息**；(B) 再加 `group:{gid}`，但 `group_ids` 在 Phase 2 被 `SessionCommitMsg` 丢掉，要补字段；(C) 新造 `workspace_id` 的生产生产者，代价最大且 `bot/` 里它已是别的意思。**我倾向 (A)**，并把「资源侧 ACL 开关默认 `enabled=False`，检索侧是否沿用同一开关」一并定下来——它决定 R6 能不能默认接线。

## 9. commit 时无法判定任务成败，索引优先级只能取中性默认（R5a）

**设计原文**：决策 #82 要求优先级（`IndexJob.priority ∈ {0 评测, 1 失败, 2 成功}`）。
**实现今天怎么做**：`priority=2`（枚举里最低紧急度）＋ `outcome_status="unspecified"`，并在代码注释里写明「这不是成功判定」。理由是 commit 时会话里只有 `record_auto_commit_success`（自动提交策略的印子），没有任务成败。
**要定什么**：未知结果该坐哪一档？是否需要一档中性的？以及「失败」最终由谁判定（按设计是提取的结论块／失败标记，#103／#108，也就是 R5b 之后的事）？
**我的建议**：先维持中性默认，等 R5b 的提取写入侧接上之后，把优先级改成由提取结果决定（有失败标记的子图 → 失败档），而不是在 commit 时猜。

## 10. 视图上的 `snapshot_watermark` 不是台账读者的原始水位（R5a）

**设计原文**：决策 #81（post_run 视图有界覆盖＋`coverage_manifest`）、#83（视图按 session/task run supersede 演化）。
**实现今天怎么做**：分页用 `list_ao_ledger` 的 token（含 `issued_at`），但写进视图的是 `ao-ledger:{sha256(ao_id, sequence, content_hash)}`。理由：原始 token 每次 commit 都变，会让 `content_hash` 跟着变、服务自带的 `(session_id, purpose, content_hash)` 幂等失效。
**要定什么**：视图上的水位字段是「台账读者水位」还是「内容摘要」？若设计要求前者，幂等要另找依据。
**我的建议**：维持派生摘要（幂等优先），但在文档/术语里说明该字段的语义是内容摘要，不是读者水位。

## 11. 台账行没有段／参与者时怎么分段（R5a，实现侧兜底）

**设计原文**：没说（台账 schema 本身没有 `segment_id`／`participant_id`／`content_hash`）。
**实现今天怎么做**：行上或 `action` 里已有就透传；没有时一行一块（`segment_id=ao_id`）、参与者 `"unspecified"`、内容哈希按行内稳定字段算（不含读者加的 `archive_id`／`committed`）。
**要定什么**：「按台账分段」是不是这个规则？提取模型将来是按这个分段划子图，还是按自己判断的段？
**我的建议**：这属于提取模型的输入质量，等提取写入侧接上后由提取侧对齐；先维持一行一块。

## 12. 索引预算的作用域是单 session 而不是工作区（R5a）

**设计原文**：#82 写的是「独立异步索引服务：预算」，`WorkspacePolicy` 的名字也暗示工作区级。
**实现今天怎么做**：约定路径是每个 session 一份 `trajectory-index.json`，所以 32 次/60 秒是按**这个 session 文件里的** `build_timestamps` 计的。
**要定什么**：预算应该是工作区级还是 session 级？
**我的建议**：先按 session 级（实现简单、隔离好），若设计要求工作区级，把队列快照挪到工作区目录即可。

## 13. 视图幂等按「内容」还是按「每次 commit 一份」（R5b，我实测过）

**设计原文**：#83「视图按 session/task run supersede 演化」暗示每次任务运行有自己的修订；实现侧的幂等键是 `(session_id, purpose, content_hash)`。
**实现今天怎么做**：沿用 R5a 服务语义（简报要求保持一致）。实测：同会话两个不同 commit（`task-1`、`task-2`）提取载荷逐字相同时，磁盘上只有 1 份修订 `post-run:session-1:task-1`，`task-2` 那份被当成「已见过」而不落盘。
**要定什么**：后一次任务运行在自己的视图内容与更早一次相同时，该不该有自己的修订？
**我的建议**：语义上等价（块、claim、失败证据都逐字相同），我判低危、可维持；但要知道它有一个耦合——#83 的「按 task run 演化」在内容相同的情况下会退化成共用一份，且该修订的 `task_run_id` 属于更早那次运行。若设计要求每次 commit 都有一份，幂等键要加 `task_run_id`。

## 14. 自适应写入侧不与台账对账，且插座只服务 post-run（R5b，实现侧选择）

**设计原文**：#101／#108 说 blocks／claims／coverage／子图与失败标记由提取模型给出；没说要不要与真实 AO 台账对账。
**实现今天怎么做**：`freeze_extracted_view` 只做结构校验（R3 的五条子图 violation ＋ 既有块／claim／覆盖校验），**不检查**块引用的 AO 是否真在台账里、覆盖清单是否与台账区间一致；载荷是已建成的领域对象，不是模型 JSON。
**要定什么**：(a) 自适应载荷要不要与台账对账（谁负责发现模型引用了不存在的 AO）？(b) 插座 `extraction_index_builder` 固定 `purpose=post_run_index`，而 `_build_locked` 只校验返回修订的 `session_id`／`task_run_id`、不校验 `purpose`——今天只有 post-run 一条入队路径，若将来诊断侧作业也走这个插座，会按 post-run 语义冻结诊断视图。
**我的建议**：(a) 对账留在提取侧的输入准备（模型看到的块来自哪，那里的 AO 就该存在），写入侧只保证结构——但要设计确认，因为这是「模型说了算」与「台账说了算」的边界；(b) 先记着，等真有第二条入队路径时补 `purpose` 校验。

## 15. 提取模型的输出契约（谁把模型的产物变成 `ExtractionPayload`）（R6b）

**设计原文**：叙述 29／92／99 与 #101／#108——检索子图与失败标记**由提取模型在提取时写入**；#119 把调用模型的地点定在 Phase 2。
**实现今天怎么做**：R6b 之后 Phase 2 有插座（注入 `extraction_provider` 即可让 adaptive 修订经 `extraction_index_builder` 落盘，并按 #124 的身份 supersede fallback），**但没有任何代码把模型输出变成 `ExtractionPayload`**——生产上插座是空的。
**为什么没做**：今天模型的结构化输出带不出 blocks／claims，四处各自都会丢字段：(a) 生成的 operations 模型是 `ConfigDict(extra="ignore")`（`schema_model_generator.py:335`）、(b) 协议骨架只列 `delete_ids` 加各 memory 类型字段（`extraction_output_protocol/json_protocol.py:80-93`）、(c) 指令正文只讲长期记忆（`session_memory/session_extract_context_provider.py:198-255`）、(d) 解析层 L3 明确过滤额外字段（`session_memory/utils/json_parser.py:375-382`）。四处都属于**改 prompt**，会改掉既有长期记忆提取的行为。
**要定什么**：(a) 契约长什么样（模型怎么表达检索子图、失败标记、claim、coverage）；(b) 由哪一次模型调用产出（扩大既有长期记忆提取的输出，还是 Phase 2 里另一次专门调用）；(c) 对账责任（与第 14 条 (a) 同源）。
**已裁定**：**#125**——不在 R6b 做，与 R6c 评测同批判定；理由是用夹具载荷能先把读侧／诊断侧／门控量完，拿基线再定契约。

## 16. 同 id 修订重复的既有残留（R6b 复核，**已实测复现**）

**现象**：`ViewSupersedeIndex.register` 追加不去重，`_content_hash_registered_locked` 只按内容挡重复，所以**同一 `revision_id` 在内容不同时会重复入库**（Phase 1 重放且台账已变，或将来模型非确定性导致同 task run 两次产出不同内容）。而 `_revision()` 遇同 id 多条直接抛错（`retrieval_facade.py:1679`）。
**实测**（`/tmp/probes/exp_r6b_seam.py`）：同一 id 注册两条内容不同的修订后，`_revision(id)` 抛 `... is not unique in the supersede index`；磁盘上 `history` 确有两条。
**范围**：既有语义，非本波引入；#124 只保证正常路径（fallback 与 adaptive）不撞 id。R6b 之后，**adaptive 路径让这件事更容易发生**（模型非确定性 + 同 task run 重放），所以要盯着。
**建议**：不动库语义（改去重会牵动 `history`／`content_hash` 判定与叙述 74）。可考虑的轻量修法是入队侧按 `(session_id, task_run_id, construction_mode)` 去重——真出现时再定。

## 17. 诊断 sink 没有水位，Phase 2 重放会再触发一次（R6b，已实测）

**现象**：同内容重放不新增修订（内容寻址幂等），但 briefs 是从当前 latest 修订**现算**的，所以 sink 会为同一批失败子图**再被调用一次**（实测 1 → 2 次）。
**为什么可能可接受**：#107 的 `failure_subgraph_fork_idempotency_key` 就是为「同一失败子图重复诊断不产生第二份 fork」设计的，重复触发不破坏写入语义。代价是重复触发会重复花诊断模型的钱。
**要定什么**：是否要求「一份修订只触发一次」（会话目录里记已交接的 `view_revision_id`／`fork_idempotency_key` 水位）。今天生产没有 sink（默认 None），没有现成花费。
**我的建议**：先不做水位，等跨仓库集成（谁提供 sink）定下来再一起定，因为水位放在服务端还是诊断侧属于集成面。

---

## 附：不是设计问题、但要知道的两件事

- **`content_hash` 口径变了（R3）**：规范 JSON 现在始终带 `retrieval_subgraphs`（空也带），所以同内容的视图在 R3 之后新冻结，摘要与之前不同。影响面只有「R3 之前落盘、之后重新索引」会被当成新内容；磁盘上没有存量数据，无需迁移。
- **子图的写入侧已经接上（R3 → R5a → R5b）**：R5a 把索引服务挂到 commit；R5b（`8f6b4efdc`）做出写入侧与 `Builder` 插座，我实测过「插座 → 钩子 → `views.json`（`adaptive`＋失败标记子图）→ R4a 读回成命中」整条链。**没配提供方时行为与 R5a 一致**。
- **下一个真正的卡点：谁把模型的产物变成 `ExtractionPayload`** → 已单列为第 15 条。R6b 把插座接到 Phase 2（注入即生效），但**提供方本身仍不存在**：CoForge 零引用 OpenViking，本仓库的 agent 面 `agent-plugins/` 只有 find/search/read/remember，而模型输出的结构化契约今天带不出 blocks／claims（见第 15 条四处过滤）。已裁定为 **#125**：与 R6c 评测同批。
- **子图 id 卫生规则的宽窄（R5b，低危记录）**：拒绝是大小写敏感的整段子串比对（对象：`session_id`／`task_run_id`／`view_id`／`revision_id`）。实测 `session_id='t1'` 时合法 id `sg-cut1-probe` 被拒（`cut1` 含 `t1`）。方向是宁严勿松、改名即可绕过，我不建议现在改。

## 18. 生产接线没有给投影通道接 `content_resolver`，fallback 视图因此对内容「盲」（R6d，我实测）

**现象**：投影通道的 BM25 文档 = `卡片摘要 + card_id + semantic_type + 解析出的 AO 正文`（`retrieval_facade.py:1158-1164`），而**只有 `content_resolver` 能带来正文**（H1 修复引入，`retrieval_facade.py:1166-1182`）。生产唯一的构造点是 `retrieval_wiring.build_retrieval_facade`，它 `InfluenceProjectionAdapter(registry, views=revisions)`——**不传 resolver**（`retrieval_wiring.py:72`）。
**实测**（`/tmp/probes/exp_r6d_projection_chain.py`，14/14）：同一批卡片、同一个关键词，带 resolver 取回 2 张卡，不带 resolver 取回 **0** 张。
**为什么今天没炸**：卡片摘要是 `block.summary` 逐字（`influence_projection.py:887-898`）。**自适应视图**的摘要是模型写的，自带语义，没有 resolver 也能被 BM25 打中；**确定性 fallback 视图**的摘要是占位串 `segment <segment_id> sequences a-b`（`influence_view.py:1661`），`input`／`output` 都是空串——所以 fallback 会话的投影通道在**今天的生产里等于内容盲**，只有段 id 里的 token 能撞上。
**两种读法**：(a) 故意的——fallback 卡片本来就是 `provisional`，内容由 segment_atom 通道（座位 12）承担，投影通道等自适应视图长出来才有实质；(b) 遗漏——H1 加了 `content_resolver` 这个能力，但生产没接线，等于只解决了「类名大小写」那一半。
**要定什么**：生产要不要给投影通道路由一段带 ACL 的「AO 正文读取」（`get_ao_evidence` 那类默认拒绝的入口），还是明确写下「fallback 视图只走 atom 通道，投影通道不负责它的内容匹配」。
**我的建议**：先不接。理由：(i) 接了等于让投影通道复制 atom 通道的正文，分不清两条通道的职责；(ii) R6d 的 arm B 数字是「有 resolver 的上界」，正好用来判断这点——若 arm B 相对 atom 通道没有增量，接 resolver 就没意义；等 R6d 数字出来再定。**这条只是记账，不改实现。**

## 19. L1 判分口径会把「座位数」折进分数（R6d 对照臂实测，**这是下一步最该修的东西**）

**现象**：既有 P／B 的取回口径是「按关键词逐个 retrieve，卡片**首次出现顺序**去重成并集」，`hit@k` 在这个并集上算。R6d 的对照臂（我另跑，`/tmp/probes/exp_r6d_control_arms.py`）把**同一个 atom 通道**只改座位数：**4 座＝36.4%@10，12 座＝15.2%@10**（并集 mean 15 → 35）。也就是说「多给座位」把 gold 挤出前 10，分数掉一半——**这是口径伪影，不是通道变差**。
**为什么现在才看见**：冻结基线里 P 的 12 座 17.3%@10 一直受这个拉扯，但只有摆了同通道的 4 座对照才看得出来；T 臂是对全部 AO 的**全局** idf 排名，不受影响（61.8%@10）。
**影响**：任何跨座位数的比较无效（包括「B 36.4% vs P 17.3%」）；而且下一波要量的**自适应视图**（座位更多、候选更准）也会被同一个伪影压住——**先修口径，再量结构**，否则会误判结构没用。
**要定什么**：候选池怎么建、怎么排序。我建议：候选池仍按通道取（每关键词 k 张），但**名次改成跨关键词的全局排序**（用适配器给的 BM25 分数，或 RRF 融合），这样座位数只增召回、不再惩罚名次；且与 T 的口径可比。
**我的建议**：下一波就做这个（零 LLM、不动 `openviking/`、只在跑分侧新增一个「全局排序」臂，保留原口径出对照）。**这条不改设计，只是让尺子先准。**

**已结案（2026-09-30，R6e）**：实测同一候选池只换合并方式，A12 从 15.2% 升到 **59.0%@10**（T 61.8%），A4 从 36.4% 升到 56.0%；座位 4→12 由 −21 个百分点变为 +3.0 个百分点。主口径裁定为「max-BM25 全局排序」，RRF 实测更低（−4.6~−6.9）只作交叉检查。**同时得出一个更重要的读数：该指标已被词法方法打到接近天花板（atom 59.0% vs T 61.8%，只差 2.8 个百分点），因此零 LLM 的结构代理在此指标上测不出结构价值**——详见 `decisions-20260930.md` #127／#128 与 `R6e-verification.md`。

## 20. 多证据题的瓶颈是「候选池召回」，但池宽被座位预算掐住（R7a 后，我实测的旁证）

**现象**（`R7a-verification.md` 第 7 节，3 个会话的多 gold 题）：把「gold 落在候选池的比例」（任何重排的上界）与「落在前 10 的比例」分开算——

| 会话 | A12 pool／top10 | B12 pool／top10 | T pool／top10 |
|---|---|---|---|
| conv-26（38 题） | 31.4%／22.6% | 28.7%／20.6% | 39.5%／19.1% |
| conv-44（41 题） | 22.4%／12.4% | 23.0%／11.5% | 45.5%／16.7% |
| conv-49（51 题） | 41.1%／31.2% | 41.6%／30.6% | 56.1%／33.7% |

**三条读数**：(1) 多证据题的上界是**池召回**（A／B 22–42%），不是排序；(2) 12 座时排序确实丢 9–12 个百分点（池里有、前 10 没露出来）；(3) **T 的优势在池宽**——它扫所有与问题有词重叠的消息，而它自己的排序损失是全场最大（20–29 个百分点）。

**要定什么**：评测里要不要一个**突破产品座位预算**的对照臂（例如投影／atom 座位 64，或「无条件把某关键词的全部候选纳入池」），用来量「**顺着链接／扩召回把证据拉进池**」这件事的上限。理由是：现行口径下候选池 = 关键词数 × 座位数（12 座 ≤ 36 张卡），**池召回被座位直接掐住**，于是任何「结构能扩池」的价值都测不到——R7a 的多证据读数（`all_gold@10` 17.1%／1.1%）有一大半是池不够宽造成的，不是排序不好。

**我的建议**：值得做，但必须**明确标注为评测上界臂**（像 R7c 的 oracle 臂一样），并且**不改产品默认**——产品的分层配额（12 总帽）是 #110 定的，动它属改设计。这条只是记账：先有数字，再决定要不要动预算。

**这件事的另一半**：即使不扩座位，多证据题也还有一个「结构轴」没测——L1 的 fallback 视图**没有跨消息的边**（一消息一块、claims=0），因果通道的独门资产根本没上场。这条已裁定为 **#130**：L1 只测内容轴，结构轴等带边视图（#125 之后）或诊断侧夹具（R7b）。


## 2026-10-08 全量对账结果

本节按后续 `CONSENSUS.md`、ADR 与当前代码逐项重算原 1–20 条的状态。它覆盖文件开头“其余仍待定”的旧时间点表述；原文保留用于审计，不再代表当前 frontier。

| 原条目 | 当前分类 | 解决依据或后续动作 |
|---|---|---|
| 1. 混合检索融合权重 | **真实未决设计** | `memory-hybrid-fusion/Q156`；源码仍为 `hybrid-fusion-pending-v0` |
| 2. conclusion block vs 显式失败标记 | 已解决 | CONSENSUS #108/#161：只认模型显式 `failure_marked`，不从 role 推断 |
| 3. 子图 12-block limit 放置 | 已解决 | CONSENSUS #158：提取/冻结期合同与 high-severity validation，不是读时裁剪 |
| 4. 历史语料是否只含失败子图 | 已解决 | CONSENSUS #144/#145：发起侧必须 failure-marked；历史候选侧包含全部合规子图 |
| 5. fork 写盘 ACL/owner label | 已解决 | CONSENSUS #118：`workspace_id` 必须属于 caller-provided owner labels，fail closed |
| 6. 两子图共享失败 AO | 已解决 | 稳定身份 #19 + 每子图 upsert #106：一个 fork node、不同 revisions/upserts |
| 7. 诊断出参内部 IDs | 已解决 | CONSENSUS #113/#122：server-internal DTO 保留 join/audit IDs；模型只看接受的 bounded projection |
| 8. 投影 ACL label 来源 | 已解决 | CONSENSUS #116/#117：owner `user:{user_id}` 标签空间，检索侧始终过滤 |
| 9. unknown outcome 的索引优先级 | **实现 backlog** | 已定 workspace priority `evaluation > failed > succeeded`；需在 extraction outcome 可用后 reprioritize，不能把 unknown 当 success |
| 10. view `snapshot_watermark` 语义 | 已解决 | CONSENSUS #159：使用六字段 AO 投影的稳定内容摘要，分页仍用真实 reader watermark |
| 11. 缺 segment/participant 的分段 | 已解决 | CONSENSUS #158/#160：adaptive contract 受 ledger reconciliation；一行一段只属 deterministic fallback |
| 12. workspace budget 实成 per-session | **实现 backlog** | #82/叙述73 已定 workspace-level；队列/时间戳存储需迁至 workspace-owned seam |
| 13. 内容幂等 vs 每 commit revision | 已解决 | CONSENSUS #124/#159：保留 `(session,purpose,content_hash)`；相同语义内容可复用旧 revision |
| 14. ledger reconciliation 与 post-run seam | 已解决 | CONSENSUS #157–#160：在 extraction input/parser boundary fail closed；`validate_view` 保持纯结构门 |
| 15. 模型输出到 ExtractionPayload | 已解决 | CONSENSUS #157–#162：独立 Phase-2 call、只选不造、同一 frozen ledger、严格解析与成本门 |
| 16. 同 revision ID 不同内容重复 | **实现 backlog** | #124 已定 reader identity 必须唯一且历史不可变；需 enqueue/register idempotency conflict handling |
| 17. diagnosis sink 无 delivery watermark | 观察/集成 backlog | 现无生产 sink；语义写入已有幂等。未来付费 consumer 接入时补 checkpoint，不需当前领域决策 |
| 18. projection 无 content_resolver | 已解决 | CONSENSUS #126：生产故意不接；fallback projection content-blind 是已知能力缺口 |
| 19. L1 座位数污染指标 | 已解决 | CONSENSUS #127：max-BM25 global candidate-pool ordering；legacy/RRF 仅对账/交叉检查 |
| 20. expanded-pool upper-bound arm | 评测可选项 | #129/#130：只可作 evaluation upper bound，不改变产品 Q153-B 8/4/cap12；是否花成本跑是调度授权，不是设计 frontier |

### 当前设计 frontier

```text
1. memory-hybrid-fusion/Q156
2. diagnostic-subgraph-text/Q157
```

Q156 来自原条目 1。Q157 不在原 1–20 的独立编号中，但源码仍有：

```text
SUBGRAPH_TEXT_POLICY_VERSION = "subgraph-text-pending-v0"
```

按“一次一个”约定先处理 Q156；Q157 在其后单独展开。条目 9/12/16 必须进入实施 backlog，不能重新包装为用户设计问题。
