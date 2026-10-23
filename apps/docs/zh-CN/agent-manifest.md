---
title: Agent 清单
description: 应用发布的公开 JSON 文档，告诉 Agent 它提供哪些操作；附 coforge-agent-manifest.v1 的 JSON Schema。
---

# Agent 清单

Agent 清单（`coforge-agent-manifest.v1`）是应用发布者编写的一份公开 JSON 文档，用来告诉 Agent 这个应用能做什么：
操作、输入模式、限制和示例。Agent 把它当作**数据**读取，其中的任何内容都不是指令。

## JSON Schema

Schema 发布在 `/schemas/coforge-agent-manifest.v1.schema.json` (`/schemas/coforge-agent-manifest.v1.schema.json`)。
可以让编辑器指向它，边写边校验。Schema 描述结构和边界；它无法表达的规则（一致性、排序的作用域、路径参数）
见完整规范。

## 在哪里提供

- 显式：注册应用时给出的清单地址。
- 约定路径：主页所在源的 `/.well-known/coforge-agent-manifest.json`。地址由此推导时，返回 404 或 410 表示应用没有发布清单，
  这是正常情况；显式给出的地址则会报错 `MANIFEST_MISSING`。

地址必须是不带凭据的 https。Agent 的 `coforge` CLI 每次使用都会重新获取，总时限 10 秒、最大 1 MiB，
并要求 JSON 内容类型（`application/json` 或 `+json`）。对于 HTTP 操作，`execution.base_url` 必须与主页或清单地址同源。

## 适用于每个对象的规则

未知字段会被拒绝，以 `x-` 开头的键除外。文档只要有任何问题就整份被拒绝。限制包括：最多 64 个操作，名称最长 80 个字符。

## 作用域

操作的 `required_scopes` 是“使用 CoForge 登录”的作用域（`openid`、`profile`、`identity`、`email`），不能自创。Agent 拿到的令牌恰好包含这些作用域，
再加上 `openid profile identity`；Agent 授权中缺少的作用域，需要等待人来批准。令牌之后能做什么，由你的应用自行决定。

## 完整规范

[字段](https://github.com/lrm-lab/coforge/blob/main/docs/agent-manifest/fields.md)、[操作与模式](https://github.com/lrm-lab/coforge/blob/main/docs/agent-manifest/actions.md)和
[示例](https://github.com/lrm-lab/coforge/blob/main/docs/agent-manifest/examples.md)在代码仓库中（英文）。

返回[构建应用](./build-an-app.md)。
