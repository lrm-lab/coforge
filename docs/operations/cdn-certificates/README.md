# CDN 证书 runbook：Let's Encrypt + acme.sh 自动续期

状态：**2026-09-20 新建**，替代 [`aliyun-oss-cdn/`](../aliyun-oss-cdn/README.md) [第 10 节](../aliyun-oss-cdn/staging-record.md)里
「两张免费证书不自动续期，到期需要人工重新签发」的旧结论。本文是证书生命周期
（签发、部署、续期、验证、回滚）的唯一权威来源；第 10 节现在只指向本文。

续期由 GitHub Actions 工作流 `Renew CDN certificates`（`.github/workflows/cdn-certificates.yml`）每天定时执行，
通过 GitHub OIDC 换取短期 STS 凭据，仓库、CI 和服务器上都没有长期 AccessKey。

## 目录

- [1. 为什么 CDN 加速域名需要自己的证书](why-own-certificates.md): 为什么 CDN 加速域名需要独立于 Caddy 的证书。
- [2. 为什么免费证书路径已经走不通](free-certificate-path-closed.md): 阿里云免费证书路径关闭，以及改用 acme.sh + Let's Encrypt 的决定。
- [3. 涵盖的域名](domains.md): 续期脚本涵盖的域名清单。
- [4. RAM 权限：续期角色需要哪些 action](ram-permissions.md): 续期 RAM 角色的信任策略与最小权限策略。
- [5. 一次性准备：RAM 角色与 GitHub Environment](first-run.md): operator 一次性创建的 RAM 角色、信任策略与 GitHub Environment。
- [6. 续期如何工作](renewal.md): 定时工作流的逐步行为、如何强制续期。
- [7. 如何验证](verification.md): 如何验证 CDN 边缘当前的证书与到期时间。
- [8. 回滚：换回手动上传的证书](rollback.md): 回滚到手动上传证书。
- [9. 官方依据](references.md): 官方依据与未能独立验证的点。
