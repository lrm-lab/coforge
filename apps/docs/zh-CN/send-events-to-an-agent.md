---
title: 向 Agent 发送事件
description: 已安装的应用如何向一个指定的 Agent 发送结构化事件或通知：声明范围、申请访问、用请求换取令牌，然后发送。
---

# 向 Agent 发送事件

> **实验性功能。** 仅在已启用的工作区中可用。事件是你的应用提供的信息，不是聊天，不是命令，也不是指令：Agent 会把其中的一切当作数据。

已安装的应用可以向一个 Agent 发送结构化的**事件**或**通知**。Agent 会在一个专属于你的应用和该 Agent 的对话中，收到发送方、你的摘要以及完整的负载。Agent 用目标 `@app.<应用 key>` 读取它。

```text
应用服务器
  -> 申请向一个 Agent 发送（客户端凭据）
  -> 用批准后的请求换取绑定该 Agent 的令牌
  -> 用该令牌发送事件
```

## 1. 声明范围

注册应用时，为它要发送的类型声明范围。这些范围不属于 Login with CoForge，登录时也不会请求。

| 类型           | 范围                       | 用途                           |
| -------------- | -------------------------- | ------------------------------ |
| `event`        | `agent:event:write`        | 结构化事实，例如一次构建完成。 |
| `notification` | `agent:notification:write` | 给 Agent 的提示性通知。        |

`action_request` 为保留类型，不被接受。不要把行动请求编码进 `summary` 或 `payload`。

## 2. 申请向一个 Agent 发送

```http
POST /api/app-agent-requests
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/json

{ "workspace_slug": "acme", "agent_name": "research-assistant", "scopes": ["agent:event:write"] }
```

如果有 Agent 的 id，可用 `agent_id` 代替 `agent_name`。应用必须已安装在该工作区。返回里有 `request_id` 和 `status`：

- `approved`：继续下一步。当工作区的规则直接批准时会立即如此：应用注册在该 Agent 所在的工作区，且创建者是所有者、管理员或该 Agent 的创建者；或者是已安装的应用，且安装范围包含这个 Agent。
- `pending`：需要有权限的成员在该 Agent 的资料页中批准。用 `GET /api/app-agent-requests/<request_id>` 重复读取，直到变为 `approved`。如果有成员撤销过你的访问权限，必须再次由成员批准，不会自动恢复。

## 3. 用请求换取令牌

```http
POST /oidc/token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=urn:coforge:params:oauth:grant-type:agent_request&request_id=<request_id>&resource=<resource>
```

`resource` 必须与第 2 步返回的完全一致。每个请求只能换取一次，令牌有效期十分钟，并绑定该 Agent 和工作区，无法用于其他 Agent。请把它保存在服务器端。

## 4. 发送事件

```http
POST /api/app-agent-events
Authorization: Bearer <token>
Content-Type: application/json

{ "kind": "event", "summary": "Weekly sync has started", "external_event_id": "meeting-2026-07-17",
  "payload": { "join_url": "https://meet.example.com/weekly-sync" } }
```

| 字段                | 约定                                                             |
| ------------------- | ---------------------------------------------------------------- |
| `kind`              | `event` 或 `notification`，决定所需的范围。                      |
| `summary`           | 必填，最多 500 个字符。                                          |
| `payload`           | JSON 对象，最大 32 KiB；默认 `{}`。                              |
| `external_event_id` | 最多 200 个字符。对每个 Agent 的幂等键：重试会返回第一次的结果。 |
| `ttl_seconds`       | 正数，默认 24 小时，最多 7 天。                                  |
| `agent_id`          | 不要填写。若填写，必须是令牌绑定的 Agent。                       |

新事件返回 `202` 和 `status: "queued"`；使用相同 `external_event_id` 重试返回 `200` 和 `deduped: true`。两者都表示已接受。错误：`401 invalid_token`、`403 insufficient_scope`（该类型需要对应范围）、`403 access_denied`（其他 Agent）、`400 invalid_request`、`413 payload_too_large`、`429 rate_limited`。

你发送的文本会作为惰性数据展示给 Agent：其中的提及、频道引用和标记都不会生效。合约：[App events for an Agent](https://github.com/lrm-lab/coforge/blob/main/docs/app-agent-events/README.md)。
