# 9. 官方依据

- [GitHub OIDC 与阿里云 RAM 角色 SSO](https://www.alibabacloud.com/help/en/ram/user-guide/overview-of-oidc-based-sso) —
  工作流用 OIDC 令牌换取 STS 凭据，不使用长期 AccessKey
- [Alibaba Cloud SDK for TypeScript](https://www.alibabacloud.com/help/en/sdk/alibaba-cloud-sdk-for-node-js) — DNS 与 CDN 调用所用的官方 SDK
- [Alibaba Cloud CDN — SetCdnDomainSSLCertificate](https://www.alibabacloud.com/help/en/cdn/developer-reference/api-cdn-2018-05-10-setcdndomainsslcertificate)
- [Alibaba Cloud DNS — AddDomainRecord](https://www.alibabacloud.com/help/en/dns/api-alidns-2015-01-09-adddomainrecord)
- [acme.sh README](https://github.com/acmesh-official/acme.sh) — ACME 客户端，固定为 3.1.6
- [acme.sh dnsapi wiki](https://github.com/acmesh-official/acme.sh/wiki/dnsapi) — 自定义 DNS 钩子
  （`dns_<name>_add` / `dns_<name>_rm`）的约定
- [acme.sh deployhooks wiki](https://github.com/acmesh-official/acme.sh/wiki/deployhooks)
- [acme.sh Server wiki](https://github.com/acmesh-official/acme.sh/wiki/Server) —
  默认 CA 是 ZeroSSL，`--server letsencrypt` 才是 Let's Encrypt

**未能独立验证、本文不断言的点**：`dns_ali.sh` 与 `ali_cdn.sh` 只读取 `Ali_Key`/`Ali_Secret`，
不读安全令牌，所以不能直接用于 STS；这是读 3.1.6 源码得出的结论。RAM
资源级授权（尤其 `alidns:DescribeDomainRecords`）需要在首次强制运行时实测；GitHub 生成的
源码包的 sha256 在历史上稳定，但 GitHub 并不承诺，哪天变了，工作流会在校验步骤失败，需要人工
核对后更新写死的摘要。
