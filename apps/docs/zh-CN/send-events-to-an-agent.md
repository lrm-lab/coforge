---
title: 向 Agent 发送事件
description: 已安装的应用如何向一个指定的 Agent 发送结构化事件或通知：声明范围、申请访问、用请求换取令牌，然后发送。
---

# 向 Agent 发送事件

> **特性标志控制（`app-agent-events`）。** 默认关闭，仅当工作区启用 `app-agent-events` 标志时可用（未开启时相关端点返回 `404 not_found` 或 `400 unauthorized_client`，Agent 资料页也不显示此入口）。事件是你的应用提供的信息，不是聊天，不是命令，也不是指令：Agent 会把其中的一切当作数据。

已安装的应用可以向一个 Agent 发送结构化的**事件**或**通知**。Agent 会在一个专属于你的应用和该 Agent 的对话中，收到发送方、你的摘要以及完整的负载。Agent 用目标 `@app.<应用 key>` 读取它。

```text
应用服务器
  -> 申请向一个 Agent 发送（客户端凭据）
  -> 用批准后的请求换取绑定该 Agent 的令牌
  -> 用该令牌发送事件
```

## 1. 声明范围

在应用编辑器的 **向 Agent 发送** 分区（开启 `app-agent-events` 时显示）为要发送的类型声明范围。这些范围不属于“使用 CoForge 登录”，登录授权端点会拒绝它们。

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

如果有 Agent 的 ID，可用 `agent_id` 代替 `agent_name`（两者同时传入时以 `agent_id` 为准）。应用必须已安装在该工作区。返回包含 `request_id`、`status`、`scopes`、`agent` 和 `resource`（速率限制：每应用每分钟 30 次请求）：

- `approved`：继续下一步。当已有有效授权覆盖所请求的全部范围，或工作区规则允许自动批准时会立即如此：应用注册在该 Agent 所在的工作区且其创建者是当前所有者、管理员或该 Agent 的创建者（且安装范围包含该 Agent）；或来自其他工作区的已安装应用且安装范围包含该 Agent。
- `pending`：需要有权管理该 Agent 应用权限的成员（工作区所有者、管理员或该 Agent 的创建者）在 Agent 资料页的 **应用 → 应用事件** 区域批准。轮询 `GET /api/app-agent-requests/<request_id>`（状态为 `approved`、`pending`、`denied`、`exchanged` 或 `expired`）直到变为 `approved`。如果有成员撤销过你的访问权限，必须再次由成员批准，不会自动恢复。

请求有效期为 **24 小时**（过期后无法批准也无法换取令牌，需要重新申请）。错误：`400 invalid_request`、`400 invalid_scope`（应用未声明或非入站范围）、`401 invalid_client`、`404 not_found`（工作区/Agent/安装不存在、目标为平台助手或标志未开启）、`429 rate_limited`。

## 3. 用请求换取令牌

```http
POST /oidc/token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=urn:coforge:params:oauth:grant-type:agent_request&request_id=<request_id>&resource=<resource>
```

使用 `client_secret_basic` 或 `client_secret_post` 认证，`resource` 必须与第 2 步返回的完全一致。每个请求只能换取一次，令牌有效期 10 分钟（`expires_in: 600`），并绑定该 Agent 和工作区，无法用于其他 Agent。请把它保存在服务器端。错误（`400`）：`invalid_request`、`invalid_target`、`invalid_grant`、`authorization_pending`、`access_denied`、`invalid_scope`、`unauthorized_client`（标志未开启）。

## 4. 发送事件

```http
POST /api/app-agent-events
Authorization: Bearer <token>
Content-Type: application/json

{ "kind": "event", "summary": "Weekly sync has started", "external_event_id": "meeting-2026-07-17",
  "ttl_seconds": 3600, "payload": { "join_url": "https://meet.example.com/weekly-sync" } }
```

| 字段                | 约定                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `kind`              | 必填：`event` 或 `notification`，决定所需的范围。                                         |
| `summary`           | 必填，空白规范化后最多 500 个字符。                                                       |
| `payload`           | JSON 对象，最大 32 KiB；默认 `{}`（转义后渲染给 Agent 的整条消息也须不超过 8,000 字符）。 |
| `external_event_id` | 最多 200 个字符。对每个应用与 Agent 的幂等键：重试会返回第一次的事件结果。                |
| `ttl_seconds`       | 正数，默认 86,400（24 小时），最多 604,800（7 天）。                                      |
| `agent_id`          | 不要填写。若填写，必须是令牌绑定的 Agent。                                                |

新事件返回 `202` 和 `{ event_id, status: "queued", deduped: false }`；使用相同 `external_event_id` 重试返回 `200`、`deduped: true` 及首次的 `event_id`。两者都表示已接受。速率限制：每应用每个 Agent 每分钟 120 次事件。错误：`401 invalid_token`、`403 insufficient_scope`（该类型需要对应范围）、`403 access_denied`（其他 Agent）、`400 invalid_request`、`413 payload_too_large`（转义后消息超过 8,000 字符也会触发）、`429 rate_limited`。

你发送的文本会作为惰性数据展示给 Agent：其中的提及、频道引用和标记都不会生效。契约（英文）：[App events for an Agent](https://github.com/lrm-lab/coforge/blob/main/docs/app-agent-events/README.md) 与 [HTTP API](https://github.com/lrm-lab/coforge/blob/main/docs/app-agent-events/http-api.md)。
