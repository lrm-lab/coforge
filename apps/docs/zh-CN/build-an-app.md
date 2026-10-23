---
title: 构建应用
description: 搭建 CoForge 应用脚手架、注册应用、发布 Agent 清单，并用 coforge CLI 测试。
---

# 构建应用

这是从零到“Agent 可以调用的应用”的最短路径，写法上既适合你，也适合让编码 Agent 照着执行。应用处于抢先体验阶段；
某一步在你的 CoForge 部署上尚不可用，说明它还没有在那里开启。

## 1. 创建脚手架

```bash
npm create coforge-app@latest my-app
# 或
bun create coforge-app my-app
```

选择一个模板（脚手架源码：[create-coforge-app](https://github.com/lrm-lab/create-coforge-app)）：

| 模板                         | 适用场景                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pure-sign-in-web-app`       | 用户通过 CoForge 登录的 Web 应用（授权码加 PKCE），需要客户端密钥。                                                      |
| `hosted-http-action-service` | 供 Agent 用 `coforge app invoke` 调用的 HTTP 服务。它发布 Agent 清单并校验 CoForge 签发的 Agent 令牌，不持有客户端密钥。 |

每个模板的 README 是它的环境变量和命令的权威说明。

## 2. 注册应用

在 CoForge 中打开**设置 → 应用**（所有者和管理员），注册一个应用。

- 只有**名称**是必填的。
- **主页**可选。使用约定路径的清单地址，以及校验操作的 `base_url` 来源时，需要它。
- **回调地址**可选；只给 Agent 使用的应用不需要。必须是 https（仅回环主机可用 http），不能带片段，最多 10 个，按完全相同的字符串比较。
- **客户端 ID** 就是应用的 key。
- **客户端密钥**只显示一次。请保存在密钥存储中，不要放进代码仓库。重新生成后，旧密钥立即失效。

## 3. 配置应用

设置模板的环境变量。`COFORGE_ISSUER` 是 `<你的 CoForge 地址>/oidc`（颁发者，issuer），末尾不带斜杠；`COFORGE_CLIENT_ID` 是客户端 ID。

- `pure-sign-in-web-app` 还需要 `COFORGE_CLIENT_SECRET`、`COFORGE_SCOPES`、`APP_ORIGIN` 和会话密钥。
- `hosted-http-action-service` 只需要 `COFORGE_ISSUER`、`COFORGE_CLIENT_ID`、`APP_ORIGIN` 和 `PORT`。

## 4. 发布 Agent 清单

在主页所在源的 `/.well-known/coforge-agent-manifest.json` 提供一份 JSON 文档，或者在注册时指定清单地址。
`hosted-http-action-service` 模板自带一份。格式和 JSON Schema 见 [Agent 清单](./agent-manifest.md)。

## 5. 测试

在工作区安装该应用后，以 Agent 的身份使用 Agent CLI：

```bash
coforge app invoke <app-key> --list-actions
coforge app invoke <app-key> <action> --param key=value
coforge app invoke <app-key> <action> --data-json '{"key":"value"}' --preflight
```

第一条命令读取你的清单并列出操作，加 `--json` 可得到机器可读的输出；第二条用 `--param`（可重复）或一个 JSON 对象
（`--data-json`）作为输入调用操作；`--preflight` 只校验输入并打印请求和作用域，不真正发送。清单只要有任何问题就会
整份被拒绝，最多报告 50 个问题，每个问题包含一个 JSON Pointer 路径和一条消息。详见
[调用操作](https://github.com/lrm-lab/coforge/blob/main/docs/agent-cli/app-invoke.md)（英文）。

## 6. 分享

在申请应用市场审核或创建私有分享链接之前，应用保持私有；见[应用概览](./apps/index.md#应用市场与私有分享)。
