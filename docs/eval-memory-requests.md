# Task 与 Memory 协作评测

评测入口是 `benchmark/evolbench-collab/src/run.ts`，通过真实 CoForge 频道、Daemon、
Agent HTTPS 接口和 OpenViking 工具运行。经验与证据文档统一由 Memory Agent 检索。
旧 Go/GMS/BM25 runner 的历史分数不能作为这条链路的结果。

## 群聊协议

1. 人类题目同时发送给 `@task @memory`，分别触发两个 Agent。Memory 根据原始任务自主构造查询并开始检索，无需等待 Task 再次请求。两者执行顺序不作保证。
2. Memory Agent 注册为 Workspace 的 Memory Agent。普通频道和线程更新按目标累计，5 条或首条等待 30 秒触发合并通知，即使未 @Memory 或只 @其他 Agent；自己的消息不计入。个人 @mention 仍立即通知。停止、离群或关闭 memory profile 后不再新增观察投递。Task 可继续 `@memory` 提出查询。
   收到通知后使用不带范围锚点的 `message_read`，从服务端已读位置分页读取正文，`hasNewer=true` 时继续。通知与 custody ACK 不推进已读位置；成功读取才推进。`message_check` 只消费投递集合，不能代替频道增量阅读。读完判断是否需要检索或发言。
3. Memory 使用 `ov_find` 检索、按需 `ov_read`，用 `memory_offer` 返回带引用的 Hint。要求 `ov_find` 只走 BM25，Memory 不暴露 `ov_search_context`；对应后端和词法索引准备改造尚未完成，不能使用旧 ready 文件宣称已验证此检索路径。
4. Task 调用原生 `memory_disposition` 记录 adopt / reject / defer 和原因，再决定如何执行。
5. 最后一条不包含对 Memory 的结构化 @mention 的 Task 消息是最终答案；IR 的 `Exact Answer:` / `Confidence:` 完整答案允许在解释中提及 Memory。两者结束运行且最新回复、Hint 和运行进展经过 settle 窗口后才结束该题，仍受 quiet 和总 deadline 预算限制。

harness 不做 pre-turn recall，不自动检索、选技能或注入经验，也不向 Task 工作目录复制
原始语料、技能 ledger 或 `ir_search.py`。Task 保留产品正常执行工具；角色指令要求检索走
Memory。是否遵守需结合原生 Agent 轨迹核查，不能仅凭提示词宣称工具隔离。

## 准备 IR 文档和训练经验

现有宿主机准备程序使用 OpenViking 资源上传 API 和默认 `semantic_and_vectors` 处理；以下是该旧准备程序的行为，不能代替尚在实现的 BM25 词法索引准备。
文档输入为 JSONL，每行仅投影 `docid`、`text`、可选 `url`；经验输入为冻结训练 ledger
数组，投影 `sha256` 和 `text`。题目标签和 grader 字段不加入文档资源。
经验文本自身应在训练阶段完成来源审核。

使用独立 OpenViking account。账号初始设置文件可以指定 embedding 与 VLM；Gemma 实验
必须显式配置 Gemma VLM 和 Task/Memory 模型，不能沿用 runner 的 DeepSeek 默认值。
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
语义/向量处理每资源等待预算为 900 秒；请求成功但后台失败不算准备成功。
checkpoint 保存源文件 SHA256、账号创建时间、已提交 task id 和完成记录；同名重建账号不能复用。恢复时去掉
`COFORGE_KNOWLEDGE_CREATE_ACCOUNT=1`，使用相同输入和账号；不重复提交已保存的后台任务。
所有资源完成且数量吻合后才写 ready 文件。后台任务过期或失败需先处理，不能手工伪造 ready。

## 冻结 test

IR runner 要求 `COFORGE_EVAL_KNOWLEDGE_READY`，缺少时直接失败，不回退 BM25/GMS。
使用只含 test 的 manifest 和 `COFORGE_EVAL_ARMS=warm`；这里的 `memory_policy` 为
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
