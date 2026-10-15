# Round 1 答复（设计者原话，中间人整理）

- **Q1: C** —— 直接扩展现有 skill schema，使每个 skill 兼作轨迹节点。**另加一个开关**，在"原始 OpenViking 行为"与"本设计修改后的行为"之间切换。
- **Q2: A** —— 归档内只保存不可变证据，另建可索引命名空间存放跨会话节点投影。
- **Q3: B** —— 资格判定：仅发生目标、假设、计划、外部世界状态、代码/配置状态或诊断结论改变的步骤。**（数量上限与超额降级策略未作答，下轮需补问）**
- **Q4: B** —— 首个闭环：失败轨迹 → 归因报告 → 候选 skill proposal。
- **Q5: A** —— 新节点是 Agent Evolution 的前置证据层，executable skill 的产出/更新仍归 Evolution 链路。
- **Q6: B** —— 反事实分支诊断时生成、经验证才持久化。**补充：proposal 可被检索；当被其他 context 采用时，记录此效用信息。**
- **Q7: B** —— 单独异步 aggregator 维护全局物化统计。（utility 标签来源新增一项：proposal 被其他 context 采用，见 Q6 补充）
- **Q8: B** —— 永久 UUID（session_id/archive_id/step_id 派生），节点内容另存 content hash。

## 设计者随答复新增的需求（Round 2 必须拷问）

1. **节点记录 skill 使用**：每个 trajectory 节点记录其使用的 skill。
2. **replay 分支与 guidance**：replay 时的分支轨迹可使用不同 skill 生产不同的 guidance；guidance 记录其参照的 trajectory 节点。
3. **无 guidance 对照**：分支轨迹也可不参照 guidance 运行。
4. **不可 replay 任务的 guidance 语义**：生成的 guidance 不插入中间状态，而是 append 到会话 session 尾部。

## 中间人补充事实：feat/ov-cm-implementation 分支现状（kiro 上轮未能运行 git，由中间人代查）

- worktree：`/home/zhoujie22/river2_0/.worktrees/cursor-ov-cm-impl`，merge-base `87ac3fc6`，共 274 文件 +32801 行。
- 改动分布：`apps/web` 170 个文件（OpenViking 代理路由 `apps/web/src/routes/api/openviking/`、workspace-memory 的 prisma 迁移与 repositories、`apps/web/src/server/openviking/catalog/` 路由族，其中**已存在 `route-family-memory-skill.ts`**）；`packages/daemon` 36 个（`openviking-read-proxy.ts`、agent 适配器、inbox 状态机）；`packages/coforge-sdk` 15 个；`benchmark/` 下 public-channel-memory（causal-host.ts 已删、ingest/judge/types 改动，未提交），另有未跟踪的 evolbench-collab、longmemeval-collab、skillsbench-collab；`docs/adr` 已有 7 个 ADR 文件。
- 含义：集成是 coforge（TS monorepo）侧消费 OpenViking HTTP API；本设计的 skill node / guidance 若要落地，消费端大概率是 coforge 的 daemon/agent 层，数据端是 OpenViking 的 session/skill 体系。
