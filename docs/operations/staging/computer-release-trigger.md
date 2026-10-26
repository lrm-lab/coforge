# 触发 Computer 本地分发发布

云应用的 staging 部署（见 [README](README.md)）和本地 Computer/Daemon 发布都是手动的（见
[`docs/release/local-distribution.md`](../../release/local-distribution.md)）：只挂
`workflow_dispatch`，不挂 `on: push`。每次发布都必须带中英文 release notes（见
[`docs/release/release-notes.md`](../../release/release-notes.md)），缺一种语言会在构建前失败。
触发一次 staging 发布：

```sh
gh workflow run release-staging.yml --repo lrm-lab/coforge \
  -f notes_en="$(cat notes.en.md)" -f notes_zh_cn="$(cat notes.zh-CN.md)"
# 或指定版本号；开新的 minor/major 版本线用 -f line=0.2.0
gh workflow run release-staging.yml --repo lrm-lab/coforge -f version=0.1.5-dev.5 \
  -f notes_en="$(cat notes.en.md)" -f notes_zh_cn="$(cat notes.zh-CN.md)"
```

不填版本号时，workflow 按[版本规则](../../release/github-actions.md)从 production 和 staging 的
`latest` 推导版本线和下一个 `<line>-dev.<N>`，顺序不对的版本在编译前就被拒绝。

发布后要改 notes，用 `release-notes.yml`，不要重发版本。只有最后的 `notes` job 失败时，
版本已经上线、只是没有 notes：`gh run rerun <run-id> --failed` 只重跑这个 job。

**已发布的版本不可覆盖。** 发布前脚本会先探测 `<version>/manifest.json`，已存在就直接
报错退出——CDN 对 `<version>/*` 缓存 365 天，重发同一个版本号会让不同边缘节点长期返回
不同的字节。所以：
- 想重发内容，请换一个版本号（`-f version=...`），不要覆盖旧的；
- 对**成功**的 run 执行 `gh run rerun` 会被这条守卫拦下，这是预期行为；
- 对在 `gates` 阶段失败（比如撞上 flaky 测试）的 run 执行 `gh run rerun` 是安全的：
  那次 run 从没走到发布，manifest 不存在；
- 上传到一半失败也可以直接重跑同一个版本号：manifest 是最后一个上传的对象，
  半截的发布不会留下它。

workflow 用 GitHub OIDC 换取阿里云 RAM 角色 `coforge-release-publisher` 的临时 STS
凭据（`ALIBABA_CLOUD_ROLE_ARN` / `ALIBABA_CLOUD_OIDC_PROVIDER_ARN`，见
`.github/workflows/release-staging.yml`）——该角色的信任策略只认
`repo:lrm-lab@340480458/coforge@1412896035:environment:staging`，没有长期 AccessKey，也就不需要为 OSS 放
对应的 secret。workflow 跑 `scripts/release/publish.ts` 把 Computer 发布到
`coforge-releases-staging` bucket（`https://releases-staging.coforge.cn`），
默认编译全部六个 target。darwin 可执行文件在 macOS runner 上用 Computer 的自签名代码签名证书签名，
私钥是 `staging` Environment 的 secret `COFORGE_DARWIN_SIGNING_KEY`（由
`scripts/release/generate-darwin-signing-identity.ts` 一次性生成；缺了它发布会在编译前失败）。用
`gh run watch` 或仓库 Actions 页面看进度；发布记录留在 workflow run 里，不写入本
文档。
