# Task 与 Memory 协作评测

评测入口是 `benchmark/evolbench-collab/src/run.ts`，通过真实 CoForge 频道、Daemon、
Agent HTTPS 接口和 OpenViking 工具运行。经验与证据文档统一由 Memory Agent 检索。
旧 Go/GMS/BM25 runner 的历史分数不能作为这条链路的结果。

## 群聊协议

1. 人类题目同时发送给 `@task @memory`，分别触发两个 Agent。Memory 根据原始任务自主构造查询并开始检索，无需等待 Task 再次请求。两者执行顺序不作保证。
2. Memory Agent 注册为 Workspace 的 Memory Agent。普通频道和线程更新按目标累计，5 条或首条等待 30 秒触发合并通知，即使未 @Memory 或只 @其他 Agent；自己的消息不计入。个人 @mention 仍立即通知。停止、离群或关闭 memory profile 后不再新增观察投递。Task 可继续 `@memory` 提出查询。
   收到通知后使用不带范围锚点的 `message_read`，从服务端已读位置分页读取正文，`hasNewer=true` 时继续。通知与 custody ACK 不推进已读位置；成功读取才推进。`message_check` 只消费投递集合，不能代替频道增量阅读。读完判断是否需要检索或发言。
3. Memory 使用 `ov_find` 检索、按需 `ov_read`，用 `memory_offer` 返回带引用的 Hint。`ov_find` 显式发送 `retrieval_mode=bm25`，Memory 不暴露 `ov_search_context`。后端未明确返回 BM25 标识时返回 `bm25_backend_required`，不回退 embedding。已发布的 frozen AIG/Fork 摘要可由 `ov_find` 发现，再使用返回的 chainRef、URI 和关系调用 `ov_expand` 逐跳探索；链绑定用户、已返回节点、权限和预算。Fork 分支标明反事实，不能当作真实执行证据。
   `ov_find`、`ov_read`、`ov_expand` 没有每个触发消息的读取次数上限；客户端和 Web 均只记录读取次数。单次查询最多 10 个候选，每个触发最多发布 1 个 Offer，检索链自身的跳数与权限校验仍生效。
   Memory 根据原题、群聊增量及未解决约束判断检索事实、方法或两者：简单事实查文档；复杂多跳题、检索停滞或策略调整主动用抽象方法/失败模式查询 `viking://resources/causal/forks`，按返回关系展开相关 Fork。Fork 是未执行的方法建议，不能代替事实证据；文档 BM25 按词项 OR 匹配，不支持引号短语或日期范围过滤。
   Memory 提示词和 `ov_expand` 描述说明组织结构：冻结 AIG 包含记录块与归因边；Fork 是挂在记录块上的替代分支，步骤可引用已有块或假想动作。`anchor` 回到原始块，`branch_steps`/`next`/`previous` 读建议步骤，存在的 `observed_block` 关联实际记录；块的 `incoming`/`outgoing` 先返回边，再由边的 `source`/`target` 返回块。每跳只用服务返回的关系和节点，遵守链预算；空结果不等于原动作从未发生，归因边也不等于因果已被独立证明。
   Memory 可以及时交付带引用的部分发现并列出未解决约束，无需独自解完整题目；后续检索由 Task 明确继续请求，或诚实提交证据不足的最终答案；不得双方互等或承诺 Offer 后自动继续。成功发布 Offer 后当前模型轮次正常结束。连续空频道轮询也正常结束轮次，后续消息继续使用同一会话。新请求/新内容必须使用新 `operationId`，相同逻辑调用重试保持原 ID；活跃 session 会拒绝不同 Offer 内容复用旧 ID，防止静默回放旧消息。
4. Task 调用原生 `memory_disposition` 记录 adopt / reject / defer 和原因，再决定如何执行。
5. 最终答案来自不属于 Memory 检索请求的 Task 消息；IR 只选含非空 `Exact Answer:` 的答案，后续完成通知不会覆盖答案。IR 的 `Exact Answer:` / `Confidence:` 完整答案允许在解释中提及 Memory。两者结束运行、Memory 没有待消费的观察消息，且最新回复、Hint 和运行进展经过 settle 窗口后才结束该题，避免在 30 秒批通知发出前清理 workspace。仍受 quiet 和总 deadline 预算限制。

harness 不做 pre-turn recall，不自动检索、选技能或注入经验，也不向 Task 工作目录复制
原始语料、技能 ledger 或 `ir_search.py`。Task 保留产品正常执行工具；角色指令要求检索走
Memory。是否遵守需结合原生 Agent 轨迹核查，不能仅凭提示词宣称工具隔离。

## 准备 IR 文档和训练经验

宿主机准备程序通过 `/api/v1/search/index_lexical` 批量写入原文和持久化 BM25 索引，不调用 embedding 或文档摘要 LLM。
文档输入为 JSONL，每行仅投影 `docid`、`text`、可选 `url`；经验输入为冻结训练 ledger
数组，投影 `sha256` 和 `text`。题目标签和 grader 字段不加入文档资源。
经验文本自身应在训练阶段完成来源审核。

使用独立 OpenViking account。账号初始设置文件可选；BM25 准备不需要 embedding 与 VLM。Gemma 实验
必须显式配置 Task/Memory 模型，不能沿用 runner 的 DeepSeek 默认值。
设置文件、密钥文件留在本地，禁止提交。可用 `COFORGE_EVAL_MODELS_PATH` 指定隔离的 Pi 模型
配置（默认读取 `~/.pi/agent/models.json`），例如让两个 Agent 使用已有的全局 Gemma 请求池。

```bash
# 在仓库根目录；先设置 OPENVIKING_PROTOTYPE_CONF 和输入路径变量。
COFORGE_KNOWLEDGE_ACCOUNT_ID=ir-frozen-20261015 \
COFORGE_KNOWLEDGE_CREATE_ACCOUNT=1 \
COFORGE_KNOWLEDGE_ACCOUNT_SETTINGS="$ACCOUNT_SETTINGS" \
COFORGE_KNOWLEDGE_CORPUS="$CORPUS_JSONL" \
COFORGE_KNOWLEDGE_LEDGER="$TRAIN_LEDGER_JSON" \
COFORGE_EVAL_KNOWLEDGE_READY="$READY_JSON" \
mise exec -- bun run --cwd benchmark/evolbench-collab prepare:knowledge
```

默认要求 67,707 篇文档和 89 条经验。小型集成验证可显式设置
`COFORGE_KNOWLEDGE_DOCUMENT_COUNT` / `COFORGE_KNOWLEDGE_EXPERIENCE_COUNT`，结果必须标为 smoke。
cold 使用同一文档输入、空 ledger，并显式设置 `COFORGE_KNOWLEDGE_EXPERIENCE_COUNT=0`；warm 使用 89 条冻结训练经验。
每批核对返回 URI、原文 SHA256 和 BM25 标识。checkpoint 保存源文件 SHA256、账号创建时间、处理模式和已完成 URI；同名重建账号不能复用。恢复时去掉
`COFORGE_KNOWLEDGE_CREATE_ACCOUNT=1`，使用相同输入和账号。
全部完成且服务器实际文档/经验数量吻合后才写 v2 ready 文件；旧语义 ready 文件不能复用。冻结评测账号不允许残留未纳入输入来源的 AIG/Fork 或其他资源类型；图检索能力在独立集成测试中验证。

## 冻结 test

IR runner 要求 `COFORGE_EVAL_KNOWLEDGE_READY`，缺少时直接失败，不回退旧 runner。
使用只含 test 的 manifest 和 `COFORGE_EVAL_ARMS=warm` 或 `cold`，必须与 ready 中的 arm 一致；这里的 `memory_policy` 为
`frozen_readonly`。每题新建 workspace、频道和 Agent 会话，顺序绑定同一个准备账号，
不把 test 对话 drain 回 OpenViking。账号已被其他 workspace 绑定时直接报错。

```bash
COFORGE_EVOLBENCH_COLLAB_EVAL=1 \
COFORGE_EVAL_ARMS=warm \
COFORGE_EVAL_MANIFEST="$TEST_MANIFEST" \
COFORGE_EVAL_KNOWLEDGE_READY="$READY_JSON" \
COFORGE_EVAL_MEMORY_AGENT_PROVIDER=gemma-4-31b-it-2gpu-1 \
COFORGE_EVAL_MEMORY_AGENT_MODEL=gemma-4-31B-it \
COFORGE_EVAL_TASK_AGENT_PROVIDER=gemma-4-31b-it-2gpu-1 \
COFORGE_EVAL_TASK_AGENT_MODEL=gemma-4-31B-it \
mise exec -- bun run --cwd benchmark/evolbench-collab eval
```

还需配置 `DATABASE_URL`、`REDIS_URL`、Agent 凭据加密 key、Centrifugo API/WS、Web URL、
OpenViking URL/配置和明确的 `COFORGE_MEMORY_HINT_TTL_SECONDS`；沿用产品环境，不另建检索服务。
`attempts.jsonl` 记录知识源哈希和数量、请求消息 ID、所有 Offer 消息 ID、实际 disposition，
以及原有最终答案与运行诊断。`trajectory_path` 指向清理 workspace 前导出的群聊与原生回执。
收到 Hint 却未提交对应原生回执会标记 `missing_disposition`，答案仍可正常判分。判分继续使用原有离线 grader；“有答案”不等于判分正确。

验证：`mise exec -- bun run --cwd benchmark/evolbench-collab test` 和 `check`。

## Memory 自主四角色诊断

Memory 可根据可见 Task 状态判断是否调用 `memory_diagnose`：重复失败、检索无进展、证据冲突、计划受阻或答案有明显未解决项。无需 Task 先发 `@memory diagnose`，显式诊断请求仍支持；简单查询或重复完成通知不应触发诊断，明确的 retrieve-only 指令继续遵守。

`messageId` 必须来自 `message_read` 中同一可见群聊的 Task 消息。后端验证双方仍为该频道成员，拒绝本人消息、人类消息、跨 workspace、私聊、已归档或隐藏频道。它冻结截至该锚点的同线程有界消息快照（最多 64 条、64000 字符），不是完整私有工具轨迹。

同一个锚点消息固定同一诊断请求，轮询不重复追加证据或重建；运行中不应改用另一消息制造新请求。只有 Task 有实质新尝试或结果才考虑再次诊断。成功交付经 Reader 验证的报告后结束 Memory 当前轮次，Task 判断和执行后续行动；失败通知不能当作成功建图。

四角色输入不提供已验证结果，Memory 不得查找或传入评测 ground truth、答案键或评分。评测驱动仍须保证群聊材料不包含这些信息；这不是对任意聊天正文的自动去标注器。已有进程保留启动时提示，新的自主能力需要新会话和更新后的 Web 后端。
