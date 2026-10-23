# 3. 涵盖的域名

与 [`scripts/ops/cdn-certificate-domains.json`](../../../scripts/ops/cdn-certificate-domains.json)
（工作流与测试共用的唯一域名清单）必须保持一致（`scripts/ops/cdn-certificates.test.ts`
会校验两者不漂移）：

| 域名 | 现状 | 原证书 |
| --- | --- | --- |
| `files-staging.coforge.cn` | 已上线，HTTPS 已启用 | `cert-d7orsd`，2026-12-02 到期 |
| `releases-staging.coforge.cn` | 已上线，HTTPS 已启用 | `cert-a4kn7`，2026-12-03 到期 |
| `images-staging.coforge.cn` | 2026-09-20 新建，HTTPS 已启用但**无证书** | 无 |
| `files.coforge.cn` | 2026-10-12 新建，生产附件 | 无 |
| `images.coforge.cn` | 2026-10-12 新建，生产头像与图标 | 无 |
| `releases.coforge.cn` | 2026-10-12 新建，生产 Computer 与 installer 发行 feed | 无 |
| `docs.coforge.cn` | 公开开发者文档站（`apps/docs`，OSS `coforge-docs-prod`） | Let's Encrypt 证书已手工上传到 CDN，2027-01-21 到期；工作流在到期前 30 天内自动换新 |

新增 CDN 域名时，在 JSON 清单里加一项，在这张表里同步加一行，并把该域名的 ARN 加进
[第 4 节](ram-permissions.md)的 RAM 策略；下一次定时运行会为它签发证书（或手动触发，见[第 6 节](renewal.md)）。
