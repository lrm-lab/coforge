---
title: 构建应用
description: 搭建 CoForge 应用脚手架、注册应用、发布 Agent 清单，并用 coforge CLI 测试。
---

# 构建应用

这是从零到“Agent 可以调用的应用”的最短路径，写法上既适合你，也适合让编码 Agent 照着执行。本文的 6 个步骤（注册应用、使用 CoForge 登录、Agent 清单、`coforge app invoke`、应用市场与私密分享链接）均已在 `coforge.cn` 公开可用；已安装数据、应用通知、向 Agent 发送事件、应用机器人设置入口等由特性标志控制的预览能力另见对应页面，默认关闭，仅当工作区启用相应标志时可用。

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

在 CoForge 中打开**设置 → 应用**（所有者和管理员），注册一个应用。Agent 也可以运行 `coforge app prepare register --target <target> --name <name>` 发起注册卡片，由所有者或管理员确认提交（见[注册应用](https://github.com/lrm-lab/coforge/blob/main/docs/agent-cli/app-registration.md)（英文））。

- 只有**应用名称**（最多 80 个字符）是必填的。
- **客户端 ID** 就是应用的 key（3 至 64 个小写字母、数字或连字符，且以字母开头）。留空时根据应用名称生成；注册后不能修改。
- **主页地址**可选（须为 `https://`）。使用约定路径的清单地址，以及校验操作的 `base_url` 来源时，需要它。
- **回调地址**可选；只给 Agent 使用的应用不需要。必须是 `https`（仅回环主机 `localhost`、`127.0.0.1` 或 `[::1]` 可用 `http`），不能带 `#` 片段，最多 10 个，按完全相同的字符串比较。
- **客户端密钥**只显示一次。请保存在密钥存储中，不要放进代码仓库。重新生成后，旧密钥立即失效。

## 3. 配置应用

设置模板的环境变量。`COFORGE_ISSUER` 是 `<你的 CoForge 地址>/oidc`（颁发者，issuer），末尾不带斜杠（例如 `https://coforge.cn/oidc`）；`COFORGE_CLIENT_ID` 是客户端 ID。

- `pure-sign-in-web-app` 还需要 `COFORGE_CLIENT_SECRET`、`COFORGE_SCOPES`、`APP_ORIGIN`、`PORT` 和 `SESSION_SECRET`。
- `hosted-http-action-service` 需要 `COFORGE_ISSUER`、`COFORGE_CLIENT_ID`、`APP_ORIGIN` 和 `PORT`。

## 4. 发布 Agent 清单

在主页所在源的 `/.well-known/coforge-agent-manifest.json` 提供一份 JSON 文档，或者在注册时指定**Agent 清单地址**（最长 2,000 个字符，`https://`，不含凭据和 `#` 片段）。`hosted-http-action-service` 模板自带一份。格式和 JSON Schema 见 [Agent 清单](./agent-manifest.md)。

## 5. 测试

在工作区安装该应用（本工作区注册的应用会自动安装在本工作区），然后以 Agent 的身份使用 `coforge` CLI：

```bash
coforge app list
coforge app invoke <app-key> --list-actions
coforge app invoke <app-key> <action> --param key=value
coforge app invoke <app-key> <action> --data-json '{"key":"value"}' --preflight
```

`coforge app list` 可确认应用已安装并查看其清单地址；`--list-actions` 会重新拉取并校验清单、列出所有操作（加 `--action <name>` 查看单个操作的完整模式，加 `--json` 得到机器可读输出）。调用操作可用 `--param`（可重复）或单个 JSON 对象（`--data-json` / `--data-file <path|->`）传参；`--preflight` 只校验输入并打印请求与作用域，不会申请令牌也不会真正发送。需要幂等键的操作（`key_required`）可用 `--idempotency-key <key>`，需要人审批时加 `--target <target>`（返回退出码 2），超时用 `--timeout <seconds>`（1 至 300，默认 60）。清单只要有任何问题就会整份被拒绝，最多报告 50 个问题，每个问题包含一个 JSON Pointer 路径和一条消息。如果应用没有清单，可直接用 `coforge app token --app <key> --exec <program>` 获取令牌调用。详见[Agent CLI：应用](https://github.com/lrm-lab/coforge/blob/main/docs/agent-cli/apps.md)与[调用操作](https://github.com/lrm-lab/coforge/blob/main/docs/agent-cli/app-invoke.md)（英文）。

## 6. 分享

在申请应用市场审核或创建私密分享链接（在设置页操作，或通过 `coforge app request-publish --client <key>` / `coforge app share-link --client <key>`）之前，应用保持私有；见[应用概览](./apps/index.md#应用市场与私有分享)与[管理应用](https://github.com/lrm-lab/coforge/blob/main/docs/agent-cli/app-management.md)（英文）。
