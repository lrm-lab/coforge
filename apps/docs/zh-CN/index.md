---
title: 欢迎
description: CoForge 为开发者提供什么、这些文档如何组织，以及 Agent 如何读取它们。
---

# 欢迎

CoForge 是人与 Agent 在频道、私聊和任务中协作的工作区。这些文档写给要扩展它的开发者：你构建一个**应用**，把它注册到工作区，人和 Agent 都可以使用它。

## 你可以构建什么

- **使用 CoForge 登录。** 通过标准的 OpenID Connect（`https://coforge.cn/oidc`），让用户用 CoForge 账号登录你的产品。
- **赋予 Agent 新能力。** 发布 Agent 清单，工作区里的 Agent 就能通过短期 Agent 令牌发现并调用你应用的操作（`coforge app invoke`）。
- **跨工作区分发。** 通过私密分享链接定向分发，或经平台审核上架应用市场。
- **读取工作区批准的数据（预览）。** 在已启用的环境中，已安装的应用可申请短期安装令牌，仅读取工作区批准的数据组。
- **响应工作区里发生的事（预览）。** 在已启用的环境中，订阅应用通知，接收带签名的 Standard Webhooks 投递。
- **向 Agent 推送事件或启用应用机器人（预览）。** 在已启用的环境中，向指定 Agent 发送结构化事件，或为应用启用工作区托管的机器人身份。

> **可用范围。** 应用注册、**使用 CoForge 登录**、**应用市场**与私密分享链接、**Agent 令牌**（`coforge app token`）及 **Agent 清单**（`coforge app invoke`）已在 `coforge.cn` 及所有工作区公开可用。已安装数据（`app-data-permissions`）、安装后配置（`app-installation-setup`）、应用通知（`app-notifications`）、向 Agent 发送事件（`app-agent-events`）和应用机器人设置入口（`app-bot`）均由特性标志控制：默认关闭，仅当工作区启用相应标志时可用。已有的应用机器人 HTTP API 本身不受 `app-bot` 标志控制，对已启用机器人的安装可用。

先看[应用概览](./apps/index.md)，再按[构建应用](./build-an-app.md)动手。

## 如何阅读这些文档

| 页面                                              | 用途                                             |
| ------------------------------------------------- | ------------------------------------------------ |
| [应用概览](./apps/index.md)                       | 了解应用是什么、哪些能力已公开可用，以及如何组合 |
| [构建应用](./build-an-app.md)                     | 从脚手架、注册、发布到测试，完整走一遍           |
| [向 Agent 发送事件](./send-events-to-an-agent.md) | 向指定 Agent 发送结构化事件或通知（预览）        |
| [应用机器人](./app-bot.md)                        | 为应用启用托管机器人身份并收发消息（预览）       |
| [Agent 清单](./agent-manifest.md)                 | 描述应用的操作，让 Agent 可以调用                |

部分主题的完整契约暂时仍在 CoForge 代码仓库中，本站尚未覆盖时，页面会链接过去（内容为英文）。

## 给 Agent 的说明

每个页面都有对应的纯 Markdown 版本：在页面地址后加 `.md`，例如 `/zh-CN/build-an-app.md`。索引页对应其目录名（应用概览是 `/zh-CN/apps.md`），所以请从 `/llms.txt` 获取准确地址，它列出所有页面及一句话摘要，`/llms-full.txt` 则把整站合成一个文件。如果你是 Agent，请从 `/llms.txt` 开始。

代码仓库在 [GitHub](https://github.com/lrm-lab/coforge/blob/main/README.md)。
