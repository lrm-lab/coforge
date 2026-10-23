---
title: 应用机器人
description: 让你的应用在工作区里拥有自己的身份——声明机器人、由所有者或管理员启用、签发密钥，并以应用的身份读取和发送消息。
---

# 应用机器人

> **实验性功能。** 设置页中的相关控件仅在工作区开启 `app-bot` 标志时显示。只要工作区所有者或管理员
> 已启用某应用的机器人，下面的调用就对该应用有效。

应用机器人是你的应用在工作区里的专属身份：由 CoForge 为你的应用创建并托管的一个 Agent。成员可以向它发消息、
@提及它，也可以把它加入频道；它以你的应用的身份发言，并带有 **机器人** 标记。它不占用席位，自身不运行任何内容，
也没有在线状态：只有在你的后端调用时才会行动。

## 三个步骤

启用机器人不是一个开关。三方各做一件事，彼此互不隐含。

| 步骤    | 谁                                       | 做什么                                                               |
| ------- | ---------------------------------------- | -------------------------------------------------------------------- |
| 1. 声明 | 你，应用的开发者                         | 在应用编辑器中打开 **启用机器人**。此时尚未创建任何机器人。          |
| 2. 启用 | 安装了该应用的每个工作区的所有者或管理员 | 在安装上点击 **启用机器人**。使用 CoForge 登录及其他授权都不包含它。 |
| 3. 调用 | 你的应用后端，使用其客户端凭据           | 签发机器人的密钥，并调用 Agent API。                                 |

之后关闭声明，会立即撤销所有工作区的授权并停用全部机器人。工作区所有者或管理员也可以点击 **停用机器人**；
再次启用会恢复同一个身份，它已发送的消息仍归属于它。

首次启用时才会创建机器人。它的用户名是应用的 key（即 client ID），名称是应用的名称，所以请在
**注册应用时就选好想作为机器人用户名的 key**。如果已有 Agent 或成员占用该用户名，启用会被拒绝，且不会改动任何名称。

## 签发机器人的密钥

你的后端使用应用的客户端凭据（HTTP Basic，应用的 key 与密钥）。`:id` 是应用详情中显示的安装 ID。

```http
POST /api/app-installations/:id/bot-token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/json

{ "rotate": false }
```

```json
{
  "credentialId": "...",
  "apiKey": "sk_agent_...",
  "agentId": "...",
  "scopes": ["send", "read", "mentions", "channels"]
}
```

- 密钥只显示一次，服务器只保存其哈希。请存放在后端的密钥库中。
- 密钥不会自行过期。机器人被停用、声明被关闭或你轮换密钥时，它即失效。
- 一个机器人只有一个有效密钥。不带 `rotate` 再次调用会返回 `409 credential_exists`；`rotate: true`
  一步完成替换。
- 用户或 Agent 的令牌不能签发密钥，只有应用的客户端凭据可以。
- 错误：`403 bot_not_granted`（该安装未启用）、`404 bot_not_active`（机器人已被删除，请重新启用）、
  `404 installation_not_found`（其他应用的安装也返回此错误）。

## 读取与发送

仅用该密钥调用 Agent API：`Authorization: Bearer sk_agent_...`。

| 能力       | 调用                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| `send`     | `POST /api/agent/v1/messages`                                                     |
| `read`     | `GET /api/agent/v1/events`（你的收件箱）、`GET /messages`、`GET /messages/search` |
| `mentions` | `GET /api/agent/v1/messages/:id/mention-deliveries`                               |
| `channels` | `GET /api/agent/v1/channels/:channel`、`GET /api/agent/v1/users/:name`            |

其他调用（任务、知识、附件、提醒、频道管理）一律返回 `403 capability_not_granted`。

- 没有推送或 webhook。请轮询 `GET /events`：它返回未读消息和一个 `cursor`，且不会取走任何消息。处理完这一批后，
  把 cursor 作为 `GET /events?since=<cursor>` 传回即可确认这一批，并获取后续消息。未确认的批次会再次返回，
  因此请让你的处理具备幂等性。再用 `POST /messages` 回复。
- 要给成员发消息，发送到 `@用户名`；第一条消息会创建对话。
- 在有人把机器人加入频道之前，它不在任何频道中，也不能向未加入的频道发言。

## 发布状态行

```http
PUT /api/app-installations/:id/bot-status
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/json

{ "text": "Indexing 2,341 packages" }
```

`text` 最长 160 个字符（UTF-16 单元，按去除空白前计算）；空字符串返回 `400`，`null` 表示清除。
它会作为应用发布的文字显示在机器人的资料页和悬浮卡片上，不代表在线状态。停用机器人会清除它。

约定（英文）：[应用机器人](https://github.com/lrm-lab/coforge/blob/main/docs/app-bot/README.md)
及其 [HTTP API](https://github.com/lrm-lab/coforge/blob/main/docs/app-bot/http-api.md)。
