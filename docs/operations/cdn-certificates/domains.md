# 3. 涵盖的域名

与 [`scripts/ops/renew-cdn-certificates.sh`](../../../scripts/ops/renew-cdn-certificates.sh)
顶部的 `CDN_DOMAINS` 数组必须保持一致（`scripts/ops/cdn-certificates.test.ts`
会校验两者不漂移）：

| 域名 | 现状 | 原证书 |
| --- | --- | --- |
| `files-staging.coforge.cn` | 已上线，HTTPS 已启用 | `cert-d7orsd`，2026-12-02 到期 |
| `releases-staging.coforge.cn` | 已上线，HTTPS 已启用 | `cert-a4kn7`，2026-12-03 到期 |
| `images-staging.coforge.cn` | 2026-09-20 新建，HTTPS 已启用但**无证书** | 无 |
| `files.coforge.cn` | 2026-10-12 新建，生产附件 | 无 |
| `images.coforge.cn` | 2026-10-12 新建，生产头像与图标 | 无 |

新增 CDN 域名（例如生产的 `releases.coforge.cn`）时，在脚本的 `CDN_DOMAINS`
数组里加一行，在这张表里同步加一行，并把该域名的 ARN 加进
[第 4 节](ram-permissions.md)的策略。
