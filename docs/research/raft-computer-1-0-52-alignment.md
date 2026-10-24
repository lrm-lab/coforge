# Raft Computer 1.0.52：对 CoForge 的对齐研究

## 证据范围

- 研究日期：2026-10-24。按仓库的 reference Computer 研究流程，从官方 Hands `updates/check` 解析到最新已发布的 darwin-arm64 产物：Raft Computer **1.0.52**，发布时间为 2026-10-23。于 2026-10-24 03:33 UTC 再次查询，latest 仍为同一版本和 release id。
- release id：`d175482e-ec38-4e54-961a-16105ea7b3e2`；binary SHA-256：`d0930a0bcd14b532beae4b6d37d024fcec3019ba0b56b0c8312ae36e0fbd31a5`；gzip SHA-256：`80b4f9da280ec2bfa87a8a0c24afecfa0cfe0fdf2453d77bc43f8fefc258a8da`；嵌入 Node：24.21.0。
- 原始产物和提取结果位于仓库外的 `/private/tmp/raft-computer-research-1-21-28/`，没有提交二进制或提取源码。SEA 资源包括 `computer.cjs`、`computer-lite.cjs`、`cli.cjs` 和 `kimi.cjs`；资源没有可拆分的路径注释，因此以下客户端证据引用 SEA bundle 中保留的模块路径标签。
- 复核命令：`bun scripts/reference-computer/extract.ts --out /private/tmp/raft-computer-research-1-21-28`、`raft-computer --help`、`raft-computer channel versions`。不要把 npm 上较旧的 `@botiverse/raft-computer` 或 GitHub Desktop 版本当作本次证据。

官方来源：[Hands release page](https://hands.build/apps/raft-computer-cli/v/1.0.52)、[Computers](https://docs.raft.build/features/server/computers/)、[Lifecycle](https://docs.raft.build/features/agents/lifecycle/)、[Tasks](https://docs.raft.build/features/collaboration/tasks/)、[Reminders](https://docs.raft.build/features/agents/reminders/)、[External Agents](https://docs.raft.build/features/agents/external/)、[Raft SDK](https://docs.raft.build/developers/sdk/)。

## 1.0.52 的客户端变化

1. **发布选择已经成为显式的 Computer 能力。** CLI 现在有 `channel show|set|versions`，内置 `latest`、`alpha`、`pinned:<semver>` 和命名 feature channel；`versions --json` 提供稳定机器可读列表，`upgrade` 支持精确 `--target-version` 和显式 `--allow-downgrade`。本次 `channel versions` 返回 1.0.52 为 latest/installed，1.0.51、1.0.50 等为可安装版本。
2. **setup 支持有证据的迁移和重新绑定。** `setup --machine` 明确采用服务器上的 Computer，`--fresh` 只在本地旧证据无法匹配时创建新连接，`--verbose` 输出迁移证据，`--yes` 才允许非交互执行。文档要求旧 daemon 不要先删除，匹配失败时不会静默迁移。
3. **服务器侧解绑仍是终止握手。** `packages/computer/src/health.ts` 仍把 401 的 `computer_machine_unlinked` 和 `computer_revoked` 识别为终止原因；健康记录写入 `terminalUnlinked`，包含时间、server machine id 和 HTTP 状态。`services/start.ts`、`service.ts` 和 `setup.ts` 将其转换为停止重试、提示重新 setup，并在重新绑定时归档旧本地证据。
4. **本地环境和服务监督更明确。** `shellEnvCapture.ts` 从登录 shell 导入 PATH、代理、API key 和 locale，同时清除 `SLOCK_HOME`、`RAFT_HOME`、Computer supervisor 和 mutation-lock 等受保护变量。`osSupervisor.ts` 对 launchd、systemd user service 和 Windows Task Scheduler 生成并校验带 owner token 的定义，避免接管外部服务。
5. **一台 Computer 可以承载多个服务器连接。** `runners list|stop` 支持按服务器查看和停止 Agent；`logout` 只退出用户登录，不删除已有服务器连接；`stop` 只停止本地服务和 Agent，也不是 detach。官方文档仍明确没有按服务器的 `detach`/`disconnect` 子命令。

## 对 CoForge 的对照

CoForge 已经对齐的部分：

- `packages/computer/README.md` 已支持多个独立 Workspace 注册，每个 Workspace 有自己的 Daemon；这与 Raft 的多服务器连接模型一致。
- `docs/release/upgrade-operations.md` 和 `coforge-installer` 已支持精确版本、降级保护、dry-run、恢复日志、下载校验、服务重启和失败回滚；这比仅有客户端升级按钮更完整。
- `packages/daemon/src/supervisor/workspace-health-journal.ts` 已持久化 `computer_unlinked`/`workspace_deleted` 的 parked 状态，且 Supervisor 不会自动重启 parked Workspace；`apps/web/src/server/computers/computers.functions.ts` 的 `deleteComputer` 也已经存在。旧研究笔记中“没有终止 marker、没有删除入口”的当前实现描述已经过时。
- Agent 生命周期已有 Start/Stop/Restart/Reset Session/Full Reset（`apps/web/src/features/agents/agent-runtime-controls.ts`），Computer 之间迁移已有独立的 lease、打包、预签名对象存储和到达确认（`apps/web/src/features/agents/agent-migrations.functions.ts`）。
- Task 已有 claim、单一 owner、Todo/In Progress/In Review/Done/Closed、Task thread 和 realtime 更新（`apps/web/src/server/tasks/AGENTS.md`、`apps/web/src/features/tasks/`）。提醒、System Cleaner、App config 和 App Inbox 也已有独立模块；这些是 Raft 1.0.52 的同类能力。
- Agent→Web send 已使用稳定 `idempotencyKey` 和 freshness hold（`docs/agent-cli/inbox-and-messages.md`、`docs/reliable-message-delivery.md`）；App token 通过短期进程管道传递并隔离环境（`docs/agent-cli/apps.md`），不应照搬 Raft 的凭据暴露方式。

## 有价值的对齐项

### P0：把 Computer 的“Workspace 移除”和“机器删除”分成两个明确操作（已实现第一步）

Raft 的 Computer 页面同时提供 `Remove`（解除某个服务器绑定）和 `Delete Computer`（删除服务器端 Computer），并要求删除前先处理该 Computer 上的 Agent；两者都不会卸载本地 CLI 或删除本机文件。CoForge 的 `deleteComputer` 会检查所有活跃 Agent 后删除 Computer 行，并为它的所有 Workspace binding 记录解绑原因。

这在 CoForge 的多 Workspace 模型中是实际差异：删除一个机器记录可能影响其他 Workspace。当前已增加 `removeComputerFromWorkspace` 与 Web `Remove from Workspace` 操作：仅 Computer 所有者可对本地 Computer 解除当前 Workspace 绑定；事务会记录并撤销该 Workspace 的 Daemon key，保留 Computer 行和其他 Workspace 绑定，提交后让该绑定的 Daemon 重连。默认云 Computer 会由 Workspace 页面自动确保，因此暂不提供同一按钮；云额外 Computer 仍沿用现有释放云资源的 Delete 流程。全局 `Delete Computer` 仍是独立操作，要求先处理所有 Agent。

剩余工作是补充浏览器手工验证，并在后续决定是否把云 Computer 也纳入按 Workspace 移除的用户合同。

### P1：为 release feed 增加可审计的 channel / pin 选择

`packages/computer/src/release-channel.ts` 当前只把官方 feed 与 Web 环境绑定；CLI 选择 `latest` 或精确版本。可借鉴 Raft 的四个稳定概念：生产 latest、staging/alpha、精确 pinned、短期 feature channel，并提供只读的版本清单和 JSON 输出。目标是让测试候选、回滚和“我实际验证了哪个版本”成为同一个可审计对象。

实施前需要确定 channel 是否属于 release feed 的公共契约、服务器触发升级是否允许跟随 channel、以及 feature channel 的保留和撤销规则。不要用任意 URL 或未签名 channel 名称绕过当前的官方环境闭集。

### P1：补齐本地登录退出与显式 Computer 采用

Raft 1.0.52 的 `logout` 只清理本机登录凭据，已连接的服务器和本地 Computer 绑定保留；CoForge 现在已提供同语义的 `coforge-computer logout`，包括稳定的 `--json` 输出，并覆盖多服务器凭据文件的单服务器删除。剩余差异是 `setup --machine`、`--fresh`、`--verbose`、`--yes` 的显式采用与迁移证据合同：CoForge 当前仍按本机 `machineId` 注册/复用，尚未把“采用已有 Computer”与“明确新建”做成用户可复核的选项。

### P1：如果开放外部 Agent，采用“持久 inbox + cursor ack + seen frontier”合同

Raft 1.0.52 的 External Agent 是服务器的完整成员，通过 device authorization/long-lived credential 接入；其 SDK 分为面向程序的 typed route client 和面向 Agent runtime 的 outcome client。最新迁移文档明确：inbox pull 默认不立即确认，只有下一次 pull 带上已处理 cursor 才确认；send 使用同一 idempotency key 重试，并把模型已经看到的 seen frontier 作为 freshness 依据。

CoForge 当前的 Agent runtime 是 Daemon 托管的本地进程，`message check` 会在一次云请求中推进服务器读位置，Daemon 另有 consumed cursor 和云 canonical read boundary。若要支持“自带进程但仍是 Workspace Agent”的外部模式，应把 cursor ack、seen frontier、credential scope、在线判定和 reminder/Agent reset 的不支持项一起定义，不能只增加一个 token endpoint。该项会改变认证与 Agent 运行边界，需要单独决策。

### P2：把迁移与工作区清理的用户合同写得像 Raft 一样可复核

Raft 明确说明 Agent workspace 随 Agent 迁移、旧副本归档、缓存和构建产物默认留在原机、`.raftmigrateignore` 可排除路径且当前上限为 10 GB。CoForge 已有更完整的迁移协议，但应在面向用户的 Computer/Agent 文档中固定大小上限、忽略规则、失败回退和旧副本清理时机，避免把“迁移成功”误解为所有机器文件都被复制。

## 保持差异的项目

- CoForge 的 App 权限已经明确采用 Workspace 声明、安装时审批和可选 per-Agent access；`docs/database-schema/apps.md` 记录了这与 Raft 的全体 Agent 默认授权不同。Raft 的 MCP App 连接模型可以继续作为参考，但不应删除 CoForge 的选择性授权。
- Raft External Agent 暂不支持 reminder schedule/update/snooze；CoForge 的 reminder scheduler、云端 due arbitration 和 App Inbox 是已批准的托管 Agent 路径，不能为了表面一致而退化。
- Raft 的 `stop`、`logout`、删除 Computer 和删除 workspace 是四种不同生命周期动作。CoForge 已把 Daemon stop、Workspace parked、Agent stop、Full Reset 和 workspace 删除分开；后续对齐必须继续保持这些边界。

这份报告取代“当前实现”部分对 CoForge 的旧判断；1.0.45 笔记仍保留为该版本的历史证据，但请先读本报告再引用当前行为。
