# 4. RAM 权限：续期角色需要哪些 action

工作流通过 GitHub OIDC 扮演 RAM 角色 `coforge-cdn-cert-renewal`
（`acs:ram::1085194890307801:role/coforge-cdn-cert-renewal`）；不存在 RAM 用户或 AccessKey。

## 信任策略

只信任既有的 OIDC 身份提供商 `github-actions`，且只信任本仓库的 `certificates` Environment
（该 Environment 限制为 `main`，无需审批人）：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Principal": {
        "Federated": ["acs:ram::1085194890307801:oidc-provider/github-actions"]
      },
      "Condition": {
        "StringEquals": {
          "oidc:iss": "https://token.actions.githubusercontent.com",
          "oidc:aud": "sts.aliyuncs.com",
          "oidc:sub": "repo:lrm-lab/coforge:environment:certificates"
        }
      }
    }
  ]
}
```

## 权限策略

| 用途 | Action | 资源 |
| --- | --- | --- |
| 写入、查找、删除 DNS-01 校验用的 TXT 记录 | `alidns:AddDomainRecord`、`alidns:DescribeDomainRecords`、`alidns:DeleteDomainRecord` | `acs:alidns:*:1085194890307801:domain/coforge.cn` |
| 把证书推送到 CDN 加速域名 | `cdn:SetCdnDomainSSLCertificate` | `acs:cdn:*:1085194890307801:domain/<域名>`，[第 3 节](domains.md)的每个域名一条 |

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "alidns:AddDomainRecord",
        "alidns:DescribeDomainRecords",
        "alidns:DeleteDomainRecord"
      ],
      "Resource": "acs:alidns:*:1085194890307801:domain/coforge.cn"
    },
    {
      "Effect": "Allow",
      "Action": "cdn:SetCdnDomainSSLCertificate",
      "Resource": [
        "acs:cdn:*:1085194890307801:domain/files-staging.coforge.cn",
        "acs:cdn:*:1085194890307801:domain/releases-staging.coforge.cn",
        "acs:cdn:*:1085194890307801:domain/images-staging.coforge.cn",
        "acs:cdn:*:1085194890307801:domain/files.coforge.cn",
        "acs:cdn:*:1085194890307801:domain/images.coforge.cn",
        "acs:cdn:*:1085194890307801:domain/releases.coforge.cn",
        "acs:cdn:*:1085194890307801:domain/docs.coforge.cn"
      ]
    }
  ]
}
```

到期时间由工作流直接对 CDN 边缘做 TLS 握手读取，不需要任何读 API 权限。不要附加
`oss:*`、`ram:*` 或其他 CDN 域名的权限。`alidns:DescribeDomainRecords` 不支持资源级授权时，
把该语句的 `Resource` 改为 `*`，其余不变（这是首次运行最可能需要核对的一点）。
