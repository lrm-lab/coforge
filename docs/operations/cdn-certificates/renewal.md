# 6. 续期如何工作

`.github/workflows/cdn-certificates.yml`（`Renew CDN certificates`）每天 03:17 UTC 在 `main`
上运行，也可手动触发。它是定时维护任务，不部署任何提交内容。无状态：没有服务器、cron 或
`account.conf`，每次运行都从零开始。

1. 工具在**每次**调用阿里云 API 之前（包括 acme.sh 钩子进程）向 GitHub 重新申请 OIDC 令牌
   （audience `sts.aliyuncs.com`，已 `::add-mask::`，获取失败或为空即报错）并写入令牌文件，
   由 `@alicloud/credentials` 换成角色 `coforge-cdn-cert-renewal` 的 STS 凭据。OIDC 令牌只有几分钟有效期，
   而一次运行远比这长，所以不能只在工作流开头取一次。STS 值不导出、不打印。
2. 下载 acme.sh 3.1.6 的源码包并校验写死的 sha256。acme.sh 自带的 `dns_ali` 与 `ali_cdn` 只接受
   长期 `Ali_Key`/`Ali_Secret`，不支持 STS 令牌，所以这里 acme.sh **只负责 ACME 协议**；
   DNS 与 CDN 调用由 `scripts/ops/renew-cdn-certificates.ts` 通过阿里云官方 SDK（`@alicloud/alidns20150109`、`@alicloud/cdn20180510`）用 STS 凭据发出。
3. 对 [`cdn-certificate-domains.json`](../../../scripts/ops/cdn-certificate-domains.json) 里的每个域名：
   用 `openssl s_client` 读 CDN 边缘当前证书的 `notAfter`；剩余不足 30 天（或 `force`）才续期。
4. 续期：`acme.sh --issue --server letsencrypt --dns dns_cdncert`（每次新建 ACME 账号），
   DNS-01 的 TXT 记录由钩子 `scripts/ops/acme-dns-hook.sh` 经 Bun 工具写入 `coforge.cn`，
   校验后由同一钩子删除；签发前会先清掉该域名遗留的 `_acme-challenge` TXT 记录，结束时（无论成败）再清一次，
   重复添加同一条记录视为成功。随后 `SetCdnDomainSSLCertificate`（`CertType=upload`，
   `CertName=cert-<域名>-<毫秒时间戳>`）。
   上传或边缘校验失败时，**用同一张证书**重试上传（最多 3 次），不会重新签发。
5. 轮询边缘，直到它提供的证书 `notAfter` 等于新证书的 `notAfter`，否则该域名失败。
6. 任一域名失败则整次运行失败（GitHub 会通知）；其余域名照常处理。

## 限流

Let's Encrypt 对同一域名集合每周最多签发 5 张。签发返回限流错误时，该域名被跳过且整次运行失败，
工具不会重试签发。**一个失败的日子里最多手动 `force` 重跑几次**，先看日志找原因。
想验证改动又不消耗额度，用 `staging` 输入（Let's Encrypt 测试 CA，只签发、不上传）。

## 强制续期

Actions -> `Renew CDN certificates` -> Run workflow（从 `main`），勾选 `force`；或
`gh workflow run cdn-certificates.yml -f force=true`。Let's Encrypt 对同一域名集合每周最多签发
5 张，不要反复强制。
