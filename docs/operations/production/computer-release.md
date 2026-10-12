# Production Computer release: feed, publisher, and promotion

Status: **workflows implemented; the feed's Alibaba Cloud resources were
provisioned on 2026-10-12** (bucket, CDN domain and its rules, DNS, certificate,
publisher role). `https://releases.coforge.cn/latest` answers 404 with
`x-oss-cdn-auth: success` until the first publication.

The production feed is `https://releases.coforge.cn`, served by Alibaba Cloud
CDN from the private bucket `coforge-releases`. It mirrors staging's
`releases-staging.coforge.cn` / `coforge-releases-staging`
([staging record](../aliyun-oss-cdn/staging-record.md)); the general provisioning
rules are in [`aliyun-oss-cdn/`](../aliyun-oss-cdn/README.md).

## Operator provisioning

Do these once, in the Alibaba Cloud console of account `1085194890307801`.

1. **Bucket** (created, transfer acceleration on). `coforge-releases` in 华北 2（北京）(`oss-cn-beijing`):
   Standard, 同城冗余, ACL `private`, Block Public Access on, OSS-managed
   encryption (AES256), **transfer acceleration** on: the workflows upload
   through `oss-accelerate.aliyuncs.com`.
2. **CDN domain** (done 2026-10-12: private-bucket access, cache rules, both
   cookie header rules). `releases.coforge.cn`
   (「大文件下载」, 「仅中国内地」), origin the OSS bucket `coforge-releases`,
   回源 HOST the bucket domain, no path rewrite, no second origin. Enable Alibaba Cloud OSS Private
   Bucket Access (same account, STS). **No URL signing**: installers and updaters
   fetch anonymously. Add the global `Delete Cookie` request header and
   `Delete Set-Cookie` response header rules.
3. **Cache rules** (done), exactly the staging set plus the installer pointer
   ([cdn-domains §5.3](../aliyun-oss-cdn/cdn-domains.md#53-url-signingcache-与-headers)):

   | Match               | Type      | Expiry | Force revalidation | Weight | Client `Cache-Control`                |
   | ------------------- | --------- | ------ | ------------------ | ------ | ------------------------------------- |
   | `json`              | suffix    | 0 s    | on                 | 99     | `no-cache, must-revalidate`           |
   | `/latest`           | directory | 0 s    | on                 | 99     | `no-cache, must-revalidate`           |
   | `/installer/latest` | directory | 0 s    | on                 | 99     | `no-cache, must-revalidate`           |
   | `/`                 | directory | 365 d  | off                | 80     | `public, max-age=31536000, immutable` |

4. **DNS and certificate** (done 2026-10-12, Let's Encrypt via acme.sh). CNAME `releases` in the `coforge.cn` zone to
   `releases.coforge.cn.w.kunlunaq.com` (done 2026-10-12). Add `releases.coforge.cn` to
   `CDN_DOMAINS` in `scripts/ops/renew-cdn-certificates.sh`,
   [`cdn-certificates/domains.md`](../cdn-certificates/domains.md), and the CDN
   ARNs of [its RAM policy](../cdn-certificates/ram-permissions.md), then run the
   script ([first run](../cdn-certificates/first-run.md)). Turn on 强制 HTTPS
   (`HTTP -> HTTPS`) on the CDN domain.
5. **Publisher role** (done 2026-10-12, policy
   `CoForgeProductionReleasesBucketAccess`). RAM role `coforge-release-publisher-production`
   (type: OIDC identity provider, provider `github-actions`, the one staging's
   `coforge-release-publisher` trusts) with this trust policy, so only a job in
   this repository's `production` GitHub Environment can assume it:

   ```json
   {
     "Version": "1",
     "Statement": [{
       "Effect": "Allow",
       "Action": "sts:AssumeRole",
       "Principal": { "Federated": ["acs:ram::1085194890307801:oidc-provider/github-actions"] },
       "Condition": {
         "StringEquals": {
           "oidc:iss": "https://token.actions.githubusercontent.com",
           "oidc:aud": "sts.aliyuncs.com",
           "oidc:sub": "repo:lrm-lab@340480458/coforge@1412896035:environment:production"
         }
       }
     }]
   }
   ```

   Attach one custom policy that allows `oss:GetObject` (which also covers the
   publishers' `HEAD` probes), `oss:PutObject`, and `oss:DeleteObject` (restoring
   or removing `latest` when activation fails) on
   `acs:oss:*:1085194890307801:coforge-releases` and
   `acs:oss:*:1085194890307801:coforge-releases/*`, and nothing else.
   No AccessKey is created for it.

Verify before the first publication:

```sh
dig +short releases.coforge.cn                     # the CDN's kunlunaq.com CNAME
curl -sI https://releases.coforge.cn/latest        # 404 with x-oss-cdn-auth: success, until the first release
curl -sI http://releases.coforge.cn/latest         # 301 to https://
```

## Promotion

Production publishes only what staging already published, rebuilt from the same
commit ([Staging to production](../../release/staging-to-production.md#local-computer-distribution)).
The `production` GitHub Environment's required reviewer approves the run, whose
title names the exact version and commit.

1. Publish the stable version to staging, and test it there:
   `gh workflow run release-staging.yml --repo lrm-lab/coforge -f version=0.1.1`.
2. Read the commit staging published it from:
   `curl -s https://releases-staging.coforge.cn/0.1.1/manifest.json | jq -r .commit`.
3. Publish the installer first, because `install.sh` reads `installer/latest`
   from the same feed. Its version is `crates/installer/Cargo.toml`'s at the
   commit staging published it from
   (`curl -s https://releases-staging.coforge.cn/installer/latest`):

   ```sh
   gh workflow run release-installer-production.yml --repo lrm-lab/coforge \
     -f commit=<installer commit> -f version=<installer version>
   ```

4. Publish the Computer:

   ```sh
   gh workflow run release-production.yml --repo lrm-lab/coforge \
     -f commit=<commit> -f version=0.1.1
   ```

Each workflow first checks, without credentials, that the commit is on `main`
and that staging published that version from it; the Computer workflow also
requires staging's `latest` to name that stable version. A failed check stops the
run before the approval gate.

Roll a bad installer back with
`gh workflow run release-installer-production.yml -f pointer_only=<version>`.
