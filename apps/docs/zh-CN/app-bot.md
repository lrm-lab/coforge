---
title: 应用机器人
description: 让你的应用在工作区里拥有自己的身份——声明机器人、由所有者或管理员启用、签发密钥，并以应用的身份读取和发送消息。
---

# 应用机器人

> **设置入口由特性标志控制（`app-bot`）与已有机器人 HTTP API。** 在设置页中声明机器人以及按安装启用/停用机器人的控件由 `app-bot` 标志控制：默认关闭，仅当工作区启用 `app-bot` 标志时可用。下方已有的机器人 HTTP API（`POST /api/app-installations/:id/bot-token`、`PUT /api/app-installations/:id/bot-status` 以及面向机器人的 `/api/agent/v1` 端点）本身不受 `app-bot` 标志控制，只要工作区所有者或管理员已为某次安装启用机器人，即可直接调用。

应用机器人是你的应用在工作区里的专属身份：由 CoForge 为你的应用创建并托管的一个 Agent。成员可以向它发消息、@提及它，也可以把它加入群聊；它以你的应用的身份发言，并在资料页与悬浮卡片上显示 **机器人** 标记和“由应用托管”。它不占用席位，自身不运行任何内容，也没有在线状态：只有在你的后端调用时才会行动。

## 三个步骤

启用机器人不是一个开关。三方各做一件事，彼此互不隐含。

| 步骤    | 谁                                       | 做什么                                                                                      |
| ------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1. 声明 | 你，应用的开发者                         | 先保存应用，再在应用编辑器的 **机器人** 分区中打开 **启用机器人**。此时尚未创建任何机器人。 |
| 2. 启用 | 安装了该应用的每个工作区的所有者或管理员 | 在安装上点击 **启用机器人**。使用 CoForge 登录及其他授权都不包含它。                        |
| 3. 调用 | 你的应用后端，使用其客户端凭据           | 签发机器人的密钥，并调用 Agent API。                                                        |

之后关闭声明，会立即撤销所有工作区的授权并停用全部机器人。工作区所有者或管理员也可以点击 **停用机器人**；再次启用会恢复同一个身份，它已发送的消息仍归属于它。

首次启用时才会创建机器人。它的用户名是应用的 key（即客户端 ID），名称是应用的名称，所以请在**注册应用时就选好想作为机器人用户名的 key**。如果已有 Agent 或成员占用该用户名，启用会被拒绝，且不会改动任何名称。

## 签发机器人的密钥

你的后端使用应用的客户端凭据（HTTP Basic，应用的 key 与密钥）。`:id` 是应用详情中显示的安装 ID（或在启用 `app-installation-setup` 时由 `POST /api/app-installations/lookup` 返回）。

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
- 一个机器人只有一个有效密钥。不带 `rotate` 再次调用会返回 `409 credential_exists`；`rotate: true` 一步完成替换。
- 用户或 Agent 的令牌不能签发密钥，只有应用的客户端凭据（`client_secret_basic`）可以（否则返回 `401 invalid_client`）。
- 速率限制：每应用每分钟 30 次请求（`429 rate_limited`，与令牌端点共享额度）。
- 错误：`400 invalid_request`（请求体格式错误或 `rotate` 非布尔值）、`403 bot_not_granted`（该安装未启用）、`404 bot_not_active`（机器人已停用，请重新启用）、`404 installation_not_found`（其他应用的安装也返回此错误）。

## 读取与发送

仅用该密钥调用 Agent API：`Authorization: Bearer sk_agent_...`。

| 能力       | 调用                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`     | `POST /api/agent/v1/messages`                                                                                                                         |
| `read`     | `GET /api/agent/v1/events`（你的收件箱）、`GET /api/agent/v1/messages`、`GET /api/agent/v1/messages/search`、`GET /api/agent/v1/messages/:id/resolve` |
| `mentions` | `GET /api/agent/v1/messages/:id/mention-deliveries`                                                                                                   |
| `channels` | `GET /api/agent/v1/channels/:channel`、`GET /api/agent/v1/users/:name`                                                                                |

其他调用（任务、知识、附件、提醒、应用、操作卡片、群聊管理）一律返回 `403 capability_not_granted`。

- 没有推送或 Webhook。请轮询 `GET /api/agent/v1/events`（可选 `?limit=`）：它返回未读消息、`hasMore` 和一个不透明的 `cursor`，且不会取走任何消息。处理完这一批后，把 cursor 作为 `GET /api/agent/v1/events?since=<cursor>` 传回即可确认这一批，并获取后续消息。未确认的批次会再次返回，因此请让你的处理具备幂等性。注意 `GET /api/agent/v1/messages` 会把返回的消息标为已读，请用 `/events` 轮询新消息，再用 `POST /api/agent/v1/messages` 回复。
- 要给成员发消息，发送到 `@用户名`；第一条消息会创建对话。
- 在有人把机器人加入群聊之前，它不在任何群聊中，也不能向未加入的群聊发言。

## 发布状态行

```http
PUT /api/app-installations/:id/bot-status
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/json

{ "text": "Indexing 2,341 packages" }
```

`text` 最长 160 个字符（UTF-16 单元，按去除空白前计算，存储时会去除首尾空白）；空字符串或纯空白返回 `400 invalid_request`，`null`（或省略 `text`）表示清除。它会作为应用发布的文字显示在机器人的资料页和悬浮卡片的“由应用托管”下方，不代表在线状态。停用机器人会清除它。速率限制：每应用每个安装每分钟 120 次请求（`429 rate_limited`）。错误：`404 installation_not_found`、`403 bot_not_granted`、`403 bot_not_active`。

契约（英文）：[应用机器人](https://github.com/lrm-lab/coforge/blob/main/docs/app-bot/README.md)及其 [HTTP API](https://github.com/lrm-lab/coforge/blob/main/docs/app-bot/http-api.md)。
