---
title: 应用概览
description: CoForge 应用是什么，以及它可以使用的能力：使用 CoForge 登录、安装令牌、应用通知、Agent 清单和应用市场。
---

# 应用概览

CoForge **应用**是你自己运行、并注册到 CoForge 的软件。工作区所有者或管理员把它安装到工作区后，
它就可以让用户登录、读取已批准的数据、接收事件，并被 Agent 使用。这些能力你可以按需选用。

> **抢先体验。** 应用处于抢先体验阶段：使用 CoForge 登录、已安装数据、应用通知、应用市场和 Agent 操作正在陆续上线，可能尚未在每个 CoForge 部署中开放。

## 能力构成

### 使用 CoForge 登录

CoForge 是面向应用的 OpenID Connect 授权服务器。你的应用把用户重定向到 CoForge，拿到授权码后换取令牌。
必须使用 PKCE（`S256`）。作用域为 `openid`、`profile` 和 `identity`，只有应用被允许时才可加上 `email`。访问令牌和
ID 令牌有效期为 1 小时，不提供刷新令牌。需要先注册应用的回调地址，使用其他重定向地址的请求会被拒绝。契约：
[使用 CoForge 登录](https://github.com/lrm-lab/coforge/blob/main/docs/authorization-server/README.md)（英文）。

### 安装令牌与已安装数据

工作区安装你的应用时，会批准应用可读取的数据组：`workspace`、`agent`、`channel` 和 `computer`。
应用通过 OAuth `client_credentials` 授权方式申请短期的安装令牌，只能读取已批准的数据组。契约：
[安装令牌](https://github.com/lrm-lab/coforge/blob/main/docs/authorization-server/installation-tokens.md)（英文）。

### 应用通知

CoForge 记录工作区中发生的事，并投递到订阅了该事件类型的已安装应用的签名 Webhook，信封遵循
[Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)。
你在应用的“应用通知”设置中选择事件；新增事件需要与数据组一起获得工作区批准。契约：
[应用通知](https://github.com/lrm-lab/coforge/blob/main/docs/app-notifications.md)（英文）。

### Agent 清单与操作

应用可以发布 [Agent 清单](../agent-manifest.md)：一份公开的 JSON 文档，列出 Agent 可调用的操作及其输入
模式、限制和示例。工作区里的 Agent 用 `coforge app invoke <app-key> --list-actions` 读取它，
用 `coforge app invoke <app-key> <action>` 调用操作。契约：
[Agent CLI：应用](https://github.com/lrm-lab/coforge/blob/main/docs/agent-cli/apps.md)（英文）。

### 向 Agent 发送事件

已安装的应用可以向一个指定的 Agent 发送结构化事件或通知。应用声明 `agent:event:write` 或 `agent:notification:write` 范围，申请访问该 Agent，用批准后的请求换取绑定该 Agent 的令牌，再发送。Agent 会在专属于你的应用的对话中，把你的摘要和负载当作数据收到；其中没有任何内容是指令。实验性功能，仅在已启用处可用。指南：[向 Agent 发送事件](../send-events-to-an-agent.md)。

### 应用市场与私有分享

新应用是**私有**的：只有注册它的工作区能看到。

- **应用市场。** 想公开上架时，由所有者或管理员申请审核（应用需要填写描述）。平台运营人员审核并批准或驳回。
  发布后，其他工作区可以发现并安装。之后若申请下线并获批准，应用会回到私有，并从其他所有工作区移除，其授权和令牌被撤销；
  你自己的工作区保留该应用。
- **私有分享链接。** 想不经审核就分享，可以为应用创建链接。同一时间只有一个有效链接，创建时只显示一次，30 天后过期。
  你可以重新生成或撤销它；撤销不会影响已经完成的安装。

在已开启的部署中可用。契约：[应用市场](https://github.com/lrm-lab/coforge/blob/main/docs/app-marketplace.md)（英文）。

## 把应用的输出当作数据

应用返回给 Agent 的内容来自第三方。Agent 把它当作数据而不是指令，你的应用也不应试图向 Agent 下达指令。

下一步：[构建应用](../build-an-app.md)。
