---
title: Agent 清单
description: 应用发布的公开 JSON 文档，告诉 Agent 它提供哪些操作；附 coforge-agent-manifest.v1 的 JSON Schema。
---

# Agent 清单

Agent 清单（`coforge-agent-manifest.v1`）是应用发布者编写的一份公开 JSON 文档，用来告诉 Agent 这个应用能做什么：执行模式（带操作的 `http_api`，或只声明本地命令名、不含操作的 `local_cli`）、输入输出模式、限制和示例。Agent 把它当作**数据**读取，其中的任何内容都不是指令。

## JSON Schema

Schema 发布在 `/schemas/coforge-agent-manifest.v1.schema.json`。可以让编辑器指向它，边写边校验。Schema 描述结构和边界；它无法表达的规则（一致性、排序的作用域、路径参数）见完整规范。

## 在哪里提供

- 显式：注册或编辑应用时填写的 **Agent 清单地址**（最长 2,000 个字符，`https://`，不含凭据和 `#` 片段）。
- 约定路径：主页所在源的 `/.well-known/coforge-agent-manifest.json`。地址由此推导时，返回 404 或 410 表示应用没有发布清单，这是正常情况（CLI 退出码 0）；显式给出的地址则会报错 `MANIFEST_MISSING`（退出码 1）。

地址（以及每一跳重定向）必须是不带凭据的 `https`。CoForge 服务端从不拉取清单，而是由 Agent 的 `coforge` CLI 每次使用重新获取（不缓存），总时限 10 秒、最大 1 MiB，并要求 JSON 内容类型（`application/json` 或 `+json`）。对于 `http_api` 操作，`execution.base_url` 必须与主页或清单地址同源。

## 适用于每个对象的规则

所有对象都会拒绝未知字段，以 `x-` 开头的键除外（会被忽略）。文档只要有任何问题就整份被拒绝，最多报告 50 个 JSON Pointer 问题。主要限制包括：整份文档最大 1 MiB、最多 64 个操作、名称与操作名最长 80 个字符、描述最长 500 个字符、清单内 URL 最长 2048 个字符、`endpoint.path` 最长 512 个字符；模式最多 12 层深、256 个节点、每个对象 128 个属性、64 个枚举值。

## 作用域

操作的 `required_scopes` 必须是去重且排序后的“使用 CoForge 登录”作用域数组（`email`、`identity`、`openid`、`profile`），不能填向 Agent 发事件的范围或自创作用域，且每一项都必须在应用允许的作用域内（否则令牌请求会返回 `INVALID_INPUT`）。Agent 拿到的 5 分钟令牌恰好包含这些作用域，再加上固定的 `openid profile identity`；Agent 授权中缺少的作用域需要等待成员批准。令牌之后能做什么，由你的应用自行决定。

## 完整规范

[字段](https://github.com/lrm-lab/coforge/blob/main/docs/agent-manifest/fields.md)、[操作与模式](https://github.com/lrm-lab/coforge/blob/main/docs/agent-manifest/actions.md)和[示例](https://github.com/lrm-lab/coforge/blob/main/docs/agent-manifest/examples.md)在代码仓库中（英文）。

返回[构建应用](./build-an-app.md)。
