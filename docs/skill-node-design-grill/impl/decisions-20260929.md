# 实现期代定决策（2026-09-29，用户授权）

用户 2026-09-29 指示「你来定吧」，授权编排侧（ZCode）裁定卡住 R5c／R6 的两条待定项。以下四条**已写入 `CONSENSUS.md` 决策总账 #116–#119**，作为设计的一部分生效；本文件记理由与后果，供设计对话回看。

## #116 会话 ACL 标签来源

**裁定**：因果检索对象（投影卡片、检索子图、fork）的可见性标签，生产环境取该会话 owner 的单一标签 `user:{user_id}`；owner 解析顺序为 `session.ctx.user.user_id` → `session._meta.created_by_user_id` → 会话 URI 的 user 段（`viking://user/<user_id>/sessions/<id>`，见 `core/namespace.py:174`）。读侧沿用既有 `openviking/storage/acl.py:192` 的 `acl_principals(ctx)` = `{user:{uid}, "user:*", group:{gid}}`——两边同一标签空间，求交语义与既有 `acl_allows` 完全一致。**不含 `group:{gid}`**（`group_ids` 在 Phase 2 被 `SessionCommitMsg` 丢掉，要补字段才能用）。**解析不出 owner → 不可见**（沿用 R4b 已实现的 fail-closed）。

**理由**：这是仓库里唯一既有的生产 ACL 标签空间，复用它不需要新造概念、不需要改队列消息、不需要在 Phase 2 补 group 字段。三档候选里的 (B)（加 group）要动队列消息与「调用方不得提供组标签」的既有声明；(C)（新造 `workspace_id` 语义）代价最大且在 `bot/` 里它已是别的意思。`user:{user_id}` 还有一条好性质：默认单用户部署（`default/default`）下标签是 `user:default`，与读侧天然相交，**行为与今天完全一致**；多用户部署才出现隔离。

**代价（要知道）**：同账号内其他用户看不到彼此的记忆。这是设计 #66「在线只用 principal 可见事件」的方向，但比资源侧严格——资源侧 ACL 开关默认关（`AccountAclSettings.enabled=False`，`config/account_config.py:34`）时资源是共享的。

## #117 不新建检索侧 ACL 开关

**裁定**：因果检索一律按 owner 标签过滤，不受资源侧 `AccountAclSettings.enabled` 控制。

**理由**：沿用资源侧开关会让检索在默认配置下**完全不设防**（开关默认关），而「不设防」是危险方向；反过来「读不到标签就不返回」只是保守。两侧开关解耦后，资源侧继续按它的节奏开关，检索侧永远设防。若将来要让检索也受一个开关控制，需要一个**专属于检索、且默认开启**的开关，不是复用资源侧那个默认关闭的。

## #118 `workspace_id` 的生产语义＝owner 标签，写入侧加门

**裁定**：`workspace_id` 在生产即 `user:{user_id}`（与该会话的卡片、子图标签同源）。`write_failure_subgraph_fork` 增加一个数据参数 `workspace_labels`（调用方给出的、该会话可见标签集），若 `workspace_id` 不在其中则拒绝写入。

**理由**：R4b 暴露过——`persist_provisional_draft` 跳过 `ServerChecks`，而 `workspace_id` 由调用方给、原样进干预索引的 `security_labels`，我实测过可以用外来 workspace 写进去。此前建议的两条修法是 (a) 复用 `commit_provisional` 的证明形态、(b) 用会话标签校验 `workspace_id`。既然 #116 已经把标签空间定死，(b) 更省：**不需要新的证明形态、不需要把 ACL 回调注入写模块**，只要调用方把已知标签当数据传进来（而调用方本来就必须传 `workspace_id`）。门是 fail-closed 的：不传标签就写不进去。

## #119 提取模型由 Phase 2 调用，Phase 1 钩子不变

**裁定**：调用提取模型的地点是 Phase 2（`Session.resume_queued_commit` → `_run_memory_extraction` → `SessionCompressor.extract_long_term_memories`，`session.py:1808/1936/2191`）——那里已经是唯一「commit 之后跑模型」的地方，且手上就有 `session_id`／`ctx`／`user`。R5a 挂在 Phase 1 的钩子与其确定性 fallback 视图**保持不变**；R6 在 Phase 2 增加一次带提供方的同名钩子调用，让 adaptive 修订按内容寻址 supersede 掉同 session／purpose 的 fallback 视图。

**理由**：设计 #110／#111／#112 要求「子图只由 commit 后的提取产生」「Memory 不持有提取工具」「diagnosis 仍在 commit 后触发」。Phase 2 的长期记忆提取正是「commit 后、由模型做、已经存在」的那一步，把插座接在这里不需要新造任何模型调用点，也不需要把模型拖进请求路径（Phase 1 持有路径锁，不宜调模型）。第一段 fallback 视图保留的价值是：模型不可用或提取失败时，视图仍然存在、索引仍然有内容——R5a 的降级语义不被破坏。代价是每次 commit 会先落一份 fallback、再被 adaptive 覆盖一次（两次构建都计入 #82 的预算）。

**残留（如实记）**：#85／#86 的「ACL 变更触发再投影／撤下」在生产上仍没有事件来源；R5c 只把回调接上（可被显式调用、会记 needs_revalidation），触发源另议。

## #120 读侧以新增工具接入，不改 `search`／`find` 的现有行为

**裁定**：因果检索在服务端 `openviking/server/mcp_endpoint.py` 以**新增** `@mcp.tool` 的形式暴露（工具面就是这里——`agent-plugins/` 只是透传代理，见 `R6-recon.md`），**不把 causal lane 折进现有的 `search`／`find`**，因此 `legacy`／未开因果的部署行为逐字不变。门控放在**调用期**（沿用 `mcp_endpoint.py:513` 的 `if session_id and service.search.is_intent_enabled()` 先例）：开关关着就返回明确的「未启用」错误，不做成 import 期的注册分支（FastMCP 的工具在模块导入时注册，注册分支会把配置读进导入路径）。principal 一律取 `tuple(acl_principals(ctx))`（与 #116 同一标签空间）。

依据：设计 #96／#97 的一体化门面（分层配额 6/4/2、总帽 12）说的是**检索入口本身**，不是说现有 `search` 必须改语义；#98 把「用卡片 id 展开邻域」明确分派给 Memory Agent 面、诊断 agent 不用——这本身就是一个独立工具的形状。把 causal 折进 `search` 会同时改掉所有既有部署的行为，风险大于收益，且不是设计要求的。

**代价**：Memory Agent 需要知道「什么时候用哪个工具」，这属于 agent 行为面（提示词／skill 文档），R6 只把工具做出来并写进 skill 文档，不在这一波调提示词策略。

## #121 fork store 的生产根＝该会话 owner 的 user 根

**裁定**：`CausalExperiencesStore` 的根目录取该会话 owner 的 user 根（`canonical_user_root(ctx)` → `_uri_to_path`），即 `viking://user/<user_id>/` 对应的本地目录；fork 的 `workspace_id`／标签口径与 #118 一致。

依据：fork 是用户级记忆，`ForkBranchAdapter(root, ...)` 需要一个跨会话可见的根（同一用户不同会话的 fork 要能互相被看到），而 fork 的可见性标签已经定为 `user:{uid}`（#118）——把 store 放在该用户的根下与标签口径自洽，也避免新造一个「workspace 目录」概念。

## #122 诊断侧的工具面不暴露给模型

**裁定**：#98 说诊断 agent 不用展开工具；结合 #110／#111／#112（Memory 不持有提取工具、Memory 不触发 diagnosis），**诊断侧的子图检索与 fork 写入都不做成 agent 工具**，只在服务端、由 commit 后的流程直接调用（#119 的 Phase 2 接缝）。

依据：#112 已经把「谁触发、谁持有工具」定死了；把诊断侧读写成模型可调用的工具会直接违反它。coforge 侧诊断 agent 怎么调这两个能力，属于跨仓库集成面，本波不碰。

## #123 按卡片 id 解析的入口一律过 principal，不可见与不存在报同一个错

**裁定**：邻域展开（以及任何按卡片 id 反查的入口）在解析出卡片后必须做 principal 过滤；不可见与不存在返回**同一个** `ValueError("unknown card id ...")`，不泄漏存在性。`principal_labels` 默认**空序列**——默认即「什么都不可见」，不是「不过滤」。

**依据**：#116／#117 定了「因果检索一律按 owner 标签过滤」（fail closed），而 R6a 的实测显示混合检索守住了、展开没有：同一份 `views.json`／`projections.json` 上，换一个 ctx 走 `facade.retrieve` 得到 0 张卡，但 `facade.expand_claim_neighborhood(card_id=<owner 的卡片>)` 仍然交出 entities=2／edges=1。库里那句「Whether a diagnostic agent may call it is an agent-side fence and is not checked here」讲的是**角色围栏**（Memory 还是诊断），不是可见性，所以补这一层不与之冲突。

**今天是不是活口子**：不是。MCP 工具只收 `session_id`，会话 URI 由 `canonical_session_uri(ctx, ...)` 从调用方的 ctx 推出（`service/session_service.py:213` 传 `session_uri=None`），而唯一传 `session_uri=` 的生产路径是 Phase 2 的队列提交（URI 来自入队时的 `SessionCommitMsg`，不是请求方可控）。所以跨用户读不到别人的会话目录，这个口子目前没有可达路径。判为**纵深防御**：一旦将来有入口允许显式传 `session_uri`，或两个用户的会话被放进同一目录，展开就会成为唯一漏的那条。既然修起来只是解析后加一次集合求交，就按 fail-closed 补上。

**代价**：`expand_claim_neighborhood` 的签名多一个 `principal_labels`（默认空序列），既有测试要显式传标签——它们因此变成这个门的文档。
