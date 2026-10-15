# Round 2 答复（设计者原话，中间人整理）

- **Q9: 未决** —— 设计者表示没太懂"硬上限与超额降级"，要例子。见下方中间人解释；数量上限、保留优先级、因果链合并、预算外步骤去向仍待答。
- **Q10: 未决** —— 设计者问"稳定 URI 是什么意思"。见下方解释；表示模型 A/B/C、schema 最小字段、used_skills[] 引用规则仍待答。
- **Q11: 未决** —— 设计者没太懂投影发布协议。见下方解释；写入顺序、失败恢复、投影内容、命名空间、ACL 边界仍待答。
- **Q12: 已决** —— **evaluator 批准即可**，不需要人工 workspace owner 参与 gate。
- **Q13: 未决** —— 设计者问"daemon 隔离 worker 是什么意思"。见下方解释；可 replay 判定标准、执行者与 sandbox 策略、预算、guidance 生产函数、对照组设计仍待答。
- **Q14: 基本同意推荐** —— 专用结构化 guidance event、对 WM/key-step/skill 三个 extractor 默认过滤、仅显式 adoption event 计 utility。**但提出两个新问题（Round 3 必须正面回答）**：
  1. 检索入口到底是哪些对象：trajectory node 的 context（七段状态）进检索，未来分支（含想象分支）也进检索吗？
  2. 设计者理解 guidance 应该是未来分支的一个组成部分；质疑"guidance 独立进检索"的意义与实际作用。要么给出具体用例证明 guidance 独立可检索的价值，要么承认 guidance 只是分支的字段、检索入口只有节点/分支。
- **Q15: 已决** —— 接受推荐：`memory.skill_trajectory_mode = legacy | causal` 版本化枚举；全局默认 → workspace 覆盖 → session 创建时固化；causal 统一 gate 节点抽取/投影/检索消费/proposal/replay/guidance/统计；切回 legacy 保留数据与审计但停止新写入、索引消费与聚合；`session_skill_extraction_enabled` 在 legacy 下保持旧语义、causal 下被接管。

## 中间人给设计者的概念解释（Round 3 请在此共享理解上出题，用例子，不要堆术语）

### Q9 的例子（关键步骤上限与降级）

假设一次 debug 会话的一个 commit 批次（archive_007）里发生了 8 个"合格"关键步骤：

1. 用户改变目标：从"修登录 bug"变成"顺带重构 auth 模块"（计划改变）
2. 读代码后形成假设：怀疑 token 校验顺序错了（假设）
3. 改了配置文件并提交（不可逆外部变更）
4. 假设被推翻：真正 bug 在缓存层（诊断结论改变）
5. 修复 + 测试通过（代码状态改变）
6. 又发现边界情况，再次修复（又一次代码状态改变）
7. 决定把修复方案写成文档（计划改变）
8. 验证文档（诊断结论）

没有上限 = 8 个节点 × 七段快照，成本可能超过 Working Memory 本体。Q9 要定的就是：最多留几个（0–3？0–5？）；按什么优先级砍（如：不可逆变更 > 失败纠正 > 诊断/计划转折 > 其他）；第 1 和第 4 属于同一因果链，要不要合并成一个节点、span 怎么记；被砍掉的 5 个步骤是只留在 messages.jsonl 原文里，还是打包成一个"不投影、不可检索"的汇总节点。

### Q10 的"稳定 URI"

稳定 URI = 地址永远不变、但内容可以换版本的对象；不可变节点 = 那份内容永远不改的快照。

例：`viking://~/skills/git-rescue` 是稳定 URI——五条轨迹各抽出一个轨迹节点（节点 A 记录"当时用 git-rescue 做了 X，失败"；节点 B 记录"用它做了 Y，成功"，每个节点是**不可变**的，带自己的版本和 hash）。而消费者引用 `git-rescue` 这个地址时，永远解析到 Evolution **当前**发布的版本。地址稳定 ≠ 内容不变。

Q10 的实质：轨迹节点（不可变、带历史、供审计/归因）和可执行 skill（可更新、被消费执行）是**两个对象**（方案 A），还是塞进同一个 SKILL.md 资产里挂 nodes[] 数组（方案 B），还是完全不改 schema、节点只存在 archive 里（方案 C）。

### Q11 的投影发布协议（用流程讲）

一次 commit 后：① extractor 抽出 3 个节点，写进 archive_007/（证据，永不修改），写 .done；② 后台 worker 读这些节点，往 `viking://~/causal-experiences/` 发布**投影**——轻量副本（摘要 + embedding + 指回 archive 的指针），让"相似 context 检索"能命中。

Q11 问的全是这条流水线的工程契约：①成功②失败（embedding 服务挂了）时 .done 写不写？谁发现"有节点没投影"并重试？重试怎么不重复（幂等）？投影里放多少（只有摘要还是整个七段）？检索方拿摘要和 node ID 后，要不要按原会话/工作区权限二次校验才能读 archive 全文？投影放独立命名空间还是混进 skills（混进去的话，搜 skill 的人会搜到"失败诊断节点"）？

### Q13 的"daemon 隔离 worker"

coforge daemon 是常驻后台服务（管 agent 会话、消息投递、agent 进程）。"隔离 worker"= daemon 另起一个受限执行环境（独立进程或容器）：文件系统是当时 workspace 的快照、网络按白名单、拿不到生产凭据、跑完销毁。

为什么必须有：replay 要"重新执行一遍轨迹"来对比不同 skill/guidance 的效果；如果直接在生产环境跑，重放的工具调用会真的删文件、发请求、写库。隔离 worker 让 replay 可以随便跑、失败不伤生产。Q13 要定的就是：谁判定可不可以 replay、worker 的具体限制、每次诊断的预算（几条分支、多少 token）、guidance 长什么样、无 guidance 基线怎么对照。
