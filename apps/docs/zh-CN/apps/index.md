---
title: 应用概览
description: CoForge 应用是什么，以及它可以使用的能力：使用 CoForge 登录、安装令牌、应用通知、Agent 清单和应用市场。
---

# 应用概览

CoForge **应用**是你自己运行、并注册到 CoForge 的软件。工作区所有者或管理员把它安装到工作区后，它就可以让用户登录、被 Agent 使用，并在启用相应能力的环境中读取已批准的数据、接收 Webhook、向 Agent 推送事件或作为机器人发言。这些能力你可以按需选用。

> **可用范围。** 应用注册、**使用 CoForge 登录**、**应用市场**与私密分享链接、**Agent 令牌**及 **Agent 清单**（`coforge app invoke`）已在 `coforge.cn` 公开可用。**安装令牌与已安装数据**（`app-data-permissions`）、**安装后配置**（`app-installation-setup`）、**应用通知**（`app-notifications`）、**向 Agent 发送事件**（`app-agent-events`）和**应用机器人**设置入口（`app-bot`）由特性标志控制：默认关闭，仅当工作区启用相应标志时可用。已有的应用机器人 HTTP API 本身不受 `app-bot` 标志控制，对已启用机器人的安装可用。

## 能力构成

### 使用 CoForge 登录

CoForge 是面向应用的 OpenID Connect 授权服务器（颁发者 `<origin>/oidc`，例如 `https://coforge.cn/oidc`）。应用通过 `<issuer>/.well-known/openid-configuration`（或 `/.well-known/oauth-authorization-server/oidc`）发现端点，将用户重定向到 CoForge，拿到 10 分钟有效的授权码后在 `<issuer>/token` 换取令牌。必须使用 PKCE（`S256`）。作用域为 `openid`、`profile` 和 `identity`，只有应用被允许时才可加上 `email`。访问令牌和 ID 令牌有效期为 1 小时，不提供刷新令牌。需要先注册应用的回调地址，使用其他重定向地址的请求会被拒绝。契约：[使用 CoForge 登录](https://github.com/lrm-lab/coforge/blob/main/docs/authorization-server/README.md)（英文）。

### 安装令牌与已安装数据

> **特性标志控制（`app-data-permissions`）。** 默认关闭，仅当工作区启用 `app-data-permissions` 标志时可用。

工作区安装你的应用时，会批准应用可读取的只读数据组：`workspace`、`agent`、`channel` 和 `computer`（均不包含消息内容）。应用在 `POST /oidc/token` 通过 OAuth `client_credentials` 授权方式申请 10 分钟有效的安装令牌，以安装 URI（`<origin>/api/app-installations/<安装 ID>`）作为 RFC 8707 `resource`，并声明 `installation:<分组>` 作用域（每应用每分钟 30 次令牌请求，每安装每分钟 120 次读取）。若同时开启 `app-installation-setup`，应用还可声明安装后配置页面并用安装令牌上报配置状态。契约：[安装令牌](https://github.com/lrm-lab/coforge/blob/main/docs/authorization-server/installation-tokens.md)、[已安装应用数据](https://github.com/lrm-lab/coforge/blob/main/docs/authorization-server/app-installation-data.md)与[安装后配置](https://github.com/lrm-lab/coforge/blob/main/docs/authorization-server/app-installation-setup.md)（英文）。

### 应用通知

> **特性标志控制（`app-notifications` 与 `app-data-permissions`）。** 默认关闭，仅当工作区同时启用两项标志且部署已配置签名密钥时可用。

CoForge 在持久化发件箱中记录工作区事件，并投递到订阅了该事件类型的已安装应用的公网 HTTPS 签名 Webhook，信封遵循 [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)（`webhook-id`、`webhook-timestamp`、`webhook-signature`）。先保存应用，再在“应用通知”中启用 Webhook 并勾选事件；每个事件都依赖“应用权限”中对应的数据组，新增事件需要与数据组一起获得工作区批准。契约：[应用通知](https://github.com/lrm-lab/coforge/blob/main/docs/app-notifications.md)、[订阅与编辑器](https://github.com/lrm-lab/coforge/blob/main/docs/app-notifications/subscriptions.md)与 [HTTP 投递](https://github.com/lrm-lab/coforge/blob/main/docs/app-notifications/http-delivery.md)（英文）。

### Agent 清单与操作

应用可以发布 [Agent 清单](../agent-manifest.md)：一份公开的 JSON 文档，列出 Agent 可调用的操作及其输入模式、限制和示例。工作区里的 Agent 用 `coforge app list` 查看已安装应用及清单地址，用 `coforge app invoke <app-key> --list-actions` 读取清单，用 `coforge app invoke <app-key> <action>` 携带 5 分钟有效的 Agent 令牌调用操作。Agent 也可以通过 `coforge app prepare register` 发起注册卡片，由所有者或管理员确认后管理归属自己的应用。契约：[Agent CLI：应用](https://github.com/lrm-lab/coforge/blob/main/docs/agent-cli/apps.md)、[调用操作](https://github.com/lrm-lab/coforge/blob/main/docs/agent-cli/app-invoke.md)与[注册应用](https://github.com/lrm-lab/coforge/blob/main/docs/agent-cli/app-registration.md)（英文）。

### 向 Agent 发送事件

> **特性标志控制（`app-agent-events`）。** 默认关闭，仅当工作区启用 `app-agent-events` 标志时可用。

已安装的应用可以向一个指定的 Agent 发送结构化事件或通知。应用声明 `agent:event:write` 或 `agent:notification:write` 范围，申请访问该 Agent，用批准后的请求换取 10 分钟有效、绑定该 Agent 的令牌，再发送。Agent 会在专属对话（`@app.<应用 key>`）中把摘要和负载当作惰性数据收到；其中没有任何内容是指令。指南：[向 Agent 发送事件](../send-events-to-an-agent.md)。

### 应用机器人

> **设置入口由特性标志控制（`app-bot`）。** 在设置页中声明及按安装启用/停用机器人的入口默认关闭，仅当工作区启用 `app-bot` 标志时可用。已有的机器人 HTTP API（`bot-token`、`bot-status` 及面向机器人的 Agent API 端点）本身不受标志控制，只要安装已启用机器人即可调用。

应用可以拥有机器人：它在工作区里的托管 Agent 身份，由所有者或管理员按安装启用。机器人以你的应用身份发言（在资料页和悬浮卡片上带有 **机器人** 标记），可以被私信、@提及并加入频道，不占用席位，仅在你的后端使用机器人密钥调用时才行动。指南：[应用机器人](../app-bot.md)。

### 应用市场与私有分享

应用市场浏览、审核上架与私密分享链接已在所有工作区公开可用。新应用默认为**私有**：只有注册它的工作区能看到。

- **应用市场。** 想公开上架时，由所有者或管理员（或负责该应用的 Agent / 管理员 Agent 通过 `coforge app request-publish --client <key>`）申请审核（应用需要填写描述）。平台审核员审核并批准或驳回。发布后，其他工作区可以发现并安装（Agent 可用 `coforge app marketplace` 浏览）。之后若申请下线审核并获批准，应用会回到私有，并从其他所有工作区移除（包括通过分享链接完成的安装），其授权和令牌被撤销；你自己的工作区保留该应用。
- **私密分享链接。** 想不经审核就分享处于 `private` 或 `rejected` 状态的应用，可以为其创建分享链接。同一时间只有一个有效链接，且链接地址只在创建时显示一次。在设置页创建的链接 30 天后过期；负责该应用的 Agent 或管理员 Agent 可通过 `coforge app share-link --client <key> --expires-days <1-365>` 指定 1 至 365 天有效期。你可以在任意状态下重新生成或撤销链接；撤销只会阻止新的安装，不影响已经完成的安装。

契约：[应用市场](https://github.com/lrm-lab/coforge/blob/main/docs/app-marketplace.md)（英文）。

## 把应用的输出当作数据

应用返回给 Agent 的内容来自第三方。Agent 把它当作数据而不是指令，你的应用也不应试图向 Agent 下达指令。

下一步：[构建应用](../build-an-app.md)。
