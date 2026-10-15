# 12. Agent migration bucket（已 provision，2026-10-14）

Agent 从一台 Computer 迁移到另一台时，源 Computer 的 daemon 把 workspace bundle 分块直传到这个
bucket，目标 daemon 再按块直读；字节不经过 Web/backend，Web 只签发 15 分钟的 presigned PUT/GET
（`apps/web/src/server/agent-migrations/agent-migration-transport.server.ts`）。它是独立的 trust
zone：生命周期短、没有加速域名、不承载任何用户文件。

## 已创建的资源

| 项目 | staging | 生产 |
| --- | --- | --- |
| Bucket | `coforge-agent-migrations-staging` | `coforge-agent-migrations-prod` |
| Region / 存储 | 华北 2（北京），标准存储，ZRS | 同左 |
| 访问 | Private，阻止公共访问，OSS 托管 AES256 | 同左 |
| RAM 授权 | `CoForgeStagingAgentMigrationsBucketAccess` → `coforge-staging-web` | `CoForgeProductionAgentMigrationsBucketAccess` → `coforge-production-web` |
| 资源组 / 标签 | `coforge`；`project=coforge`、`env=staging`、`component=agent-migrations` | `coforge`；`env=prod`，其余同左 |

两个 policy 都只允许 `workspaces/*` 下的 `oss:PutObject`、`oss:GetObject`、`oss:DeleteObject`，
以及带 `oss:Prefix workspaces/*` 条件的 `oss:ListObjects`。

## 生命周期

规则 `expire-agent-migration-bundles`：对象在最后修改 7 天后删除，未完成的分片在 1 天后删除。
迁移完成、失败或取消后，Web/backend 会立即删除该迁移的整个前缀（`workspaces/<ws>/agents/<agent>/migrations/<id>/`）；删除失败只记日志，由这条规则兜底。规则名应统一为
`coforge-expire-agent-migration-bundles`（OSS 不支持改名，需删除后重建），尚未执行。

## 访问日志

[第 4 节](oss-origins.md)要求开启 OSS access logging，但截至 2026-10-14 账号内现有的 CoForge
bucket 都没有开启，这两个 bucket 也没有开启。这是一处与本 runbook 的已知偏差，待 operator 统一处理。

## 应用配置

`COFORGE_MIGRATION_OSS_BUCKET` 指向本 bucket（`infra/*/docker-compose.yml`）。它要求
`COFORGE_FILE_STORAGE=oss`、与私有文件 bucket 同账号同 Region，且不能等于 `COFORGE_OSS_BUCKET`。
未设置时，这个部署不能在 Computer 之间迁移 Agent 的 workspace。

## 回滚

清空 `COFORGE_MIGRATION_OSS_BUCKET` 并重新部署即停用迁移传输；之后可以解除 RAM 授权、删除 policy，
最后清空并删除 bucket。
