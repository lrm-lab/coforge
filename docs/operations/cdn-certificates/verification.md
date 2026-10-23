# 7. 如何验证

每次工作流运行的日志里，每个域名都有一行现场证据，来自对 CDN 边缘的 TLS 握手，独立于 acme.sh：

```
files.coforge.cn: valid until 2027-01-20T00:00:00.000Z, not renewing
docs.coforge.cn: edge now serves a certificate valid until 2027-01-20T00:00:00.000Z
```

这是工具对 `openssl s_client -servername <domain> -connect <domain>:443` 的结果调用
`openssl x509 -noout -enddate` 得到的，也可以手动复现，不依赖工作流：

```bash
echo | openssl s_client -servername files-staging.coforge.cn \
  -connect files-staging.coforge.cn:443 2>/dev/null \
  | openssl x509 -noout -enddate -issuer
```

`-issuer` 应显示 `Let's Encrypt`，而不是阿里云证书服务颁发的证书。也可以在
CDN 控制台的域名详情页确认证书来源与到期时间，作为交叉验证。
