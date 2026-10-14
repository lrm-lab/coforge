# Raft Computer 删除/解绑 Computer：1.0.45 对 CoForge 的参考

## 证据范围

- 本稿以官方 Raft Computer 1.0.45 darwin-arm64 产物为客户端依据。原始 bundle：`/private/tmp/raft-1.0.45.nHZbi2/raft-computer-1.0.45.cjs`，SHA-256 `5d1325c7bdbadb165caa418ae6ed71bad49883b401ca755b7ff3665430a3a32`；提取源码树：`/private/tmp/raft-computer-research-1.0.45/extracted`。
- 网页入口和文案依据 Raft 官方文档 [“电脑 / 管理电脑”](https://docs.raft.build/zh-cn/features/server/computers/)（当前页面行 160–186）。网页文档确认 UI 语义；1.0.45 客户端产物确认本地行为。产物中没有 Raft Web 前端源码，因此不臆测 Web 的内部实现细节。

## Raft 1.0.45 的行为

1. **删除发生在服务器/Web 侧，不是本地 CLI 命令。** 官方页面的 Computer detail view 提供 `Remove`（从服务器解绑）和 `Delete Computer`（永久删除服务器侧 Computer）；删除前必须先删除分配到该 Computer 的 Agent。删除会撤销 attachment，但不会卸载本机程序或删除本机文件（官方文档行 164–175）。同页明确没有按服务器执行的 `detach`/`disconnect` 子命令，`stop` 也不是断连（行 175–182）。
2. **客户端把服务器删除/解绑当作终止握手。** `health.ts:2-5` 只把 HTTP 401 的 `computer_machine_unlinked`、`computer_revoked` 归类为终止原因；`service.ts:574-575,614-623` 定义退出码 77，在握手被拒绝时写终止标记并停止重试。
3. **终止状态持久化并阻止自动恢复。** `health.ts:71-80,93-115` 将时间、原因、server machine id、HTTP 状态写入 health marker，并在 machine id 改变时清除；`services/start.ts:97-119,121-133` 把它转成 `COMPUTER_MACHINE_UNLINKED`，跳过启动并提示 `raft-computer setup ...`；`startStop.ts:39-43` 输出 “server unlinked this Computer”。
4. **重新绑定会先处理旧本地状态。** `setup.ts:648-670` 将旧 attachment 改名为 `.unlinked-<timestamp>-<uuid>.bak`；`setup.ts:1157-1173` 在启动遇到 unlinked 时归档旧 runner 状态后重新进入 setup/recovery 流程。`services/attach.ts:25-50` 对已有 attachment 做 preflight，凭据被撤销时拒绝静默创建新 attachment。
5. **1.0.45 Computer 客户端未实现删除 API。** `apiClient.ts:95-133,280-303,305-347,476-518` 只有 `POST /api/computer/attach`、`POST /internal/computer/preflight`、server/machine 查询和 runner 管理；没有 `DELETE`/`remove`/`revoke` 方法。官方网页只公开按钮和前置条件，不公开 Delete 的 HTTP URL/method；删除入口因此属于服务器/Web 控制面，客户端只负责接收拒绝、停止重试并引导 setup。

## CoForge 当前实现

- 本地 CLI 只注册 login、setup/attach、install、upgrade、rollback、start、stop、restart、foreground、logs、status：`packages/computer/src/cli.ts:124-251`；共享命令常量同样没有 delete/detach：`packages/coforge-sdk/src/internal/index.ts:391-413`。
- Web Computer server function 目前只有 restart/status、usage、list、upgrade、runtime visibility 等：`apps/web/src/features/computers/computers.functions.ts:42-106,108-180,182-224`。详情面板的 props 和操作按钮只有 rename、runtime visibility、restart、upgrade：`apps/web/src/features/computers/computer-detail.tsx:90-122,234-312`，没有 Remove/Delete affordance。
- Computer HTTPS 边界只暴露 `workspace:get` 和 `computer:register`：`apps/web/src/server/computers/computer-http.server.ts:24-38`。注册事务是 upsert Computer、upsert WorkspaceComputer、撤销旧 key、创建新 key：`apps/web/src/server/db/repositories/setup.repositories.server.ts:40-103`；这是 attach/key rotation，不是删除。
- Daemon 连接收到 error 时只记录 `daemon_connection:failed`、disconnect 并抛错：`packages/daemon/src/connection/daemon-connection.ts:498-567`；没有 Raft 的终止原因分类、持久 marker、退出码或停止重连闩。Computer 本地 `discardRegistration` 也是兼容性 no-op，明确“Switching never deletes prior local state”：`packages/computer/src/local-config.ts:79-113`。
- 数据库已有 `DaemonApiKey.revokedAt`，且 key、WorkspaceComputer、runtime/catalog 对 Computer 为 cascade：`apps/web/prisma/schema.prisma:495-510,620-662`。`Computer` 本身没有 `deletedAt`/`revokedAt` 生命周期字段：`apps/web/prisma/schema.prisma:591-618`。因此直接删 DB 行会清理关联资料，却没有通知在线 Daemon，也没有可审计的 server-side unlink 状态。

## 建议先定的语义

Raft 把“服务器解绑”和“永久删除 Computer”分开，同时要求删除前清空 Agent。CoForge 应先选择以下一种公开语义，再实现对应 use case（这会触及安全边界和协议，需先获批准）：

- **Workspace unlink（推荐先做）**：删除一个 `WorkspaceComputer` 连接并撤销该 Workspace 的 active `DaemonApiKey`；保留 Computer identity，允许之后重新 attach。在线 Daemon 要收到明确的 terminal reason，并停止自动重连/自启；状态页提示重新 setup。
- **Machine delete**：在事务内校验无 Agent/迁移/运行时依赖，撤销所有 key、断开所有 Workspace 连接，再软删或硬删 Computer；需决定 Agent/workspace、审计和恢复策略。
- **仅直接删数据库行（不推荐）**：虽然现有 FK 会 cascade，但在线 Daemon 只能看到通用认证失败，可能持续重连；这与 Raft 1.0.45 的 `computer_machine_unlinked` 终止握手不一致。

实施顺序应是：明确 unlink/delete 的权限和前置条件 → 增加服务器 use case 与稳定错误原因 → 增加 Daemon terminal 状态与 no-retry 行为 → 增加 Web Computer detail 的确认对话框、请求和结果刷新 → 补充 setup/rebind 与本地状态归档。
