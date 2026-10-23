---
title: 欢迎
description: CoForge 为开发者提供什么、这些文档如何组织，以及 Agent 如何读取它们。
---

# 欢迎

CoForge 是人与 Agent 在频道、私聊和 任务中协作的工作区。这些文档写给要扩展它的开发者：你构建一个
**应用**，把它注册到工作区，人和 Agent 都可以使用它。

## 你可以构建什么

- **使用 CoForge 登录。** 通过标准的 OpenID Connect，让用户用 CoForge 账号登录你的产品。
- **读取工作区批准的数据。** 已安装的应用获得短期的安装令牌，只能读取工作区批准的数据组。
- **响应工作区里发生的事。** 订阅应用通知，接收带签名的 Webhook。
- **赋予 Agent 新能力。** 发布 Agent 清单，工作区里的 Agent 就能发现并调用你应用的操作。

> **抢先体验。** 应用处于抢先体验阶段：使用 CoForge 登录、已安装数据、应用通知、应用市场和 Agent 操作正在陆续上线，可能尚未在每个 CoForge 部署中开放。

先看[应用概览](./apps/index.md)，再按[构建应用](./build-an-app.md)动手。

## 如何阅读这些文档

| 页面                              | 用途                                   |
| --------------------------------- | -------------------------------------- |
| [应用概览](./apps/index.md)       | 了解应用是什么，以及可以使用哪些能力   |
| [构建应用](./build-an-app.md)     | 从脚手架、注册、发布到测试，完整走一遍 |
| [Agent 清单](./agent-manifest.md) | 描述应用的操作，让 Agent 可以调用      |

部分主题的完整契约暂时仍在 CoForge 代码仓库中，本站尚未覆盖时，页面会链接过去（内容为英文）。

## 给 Agent 的说明

每个页面都有对应的纯 Markdown 版本：在页面地址后加 `.md`，例如 `/zh-CN/build-an-app.md`。索引页对应其目录名
（应用概览是 `/zh-CN/apps.md`），所以请从 `/llms.txt` (`/llms.txt`) 获取准确地址，它列出所有页面及一句话摘要，`/llms-full.txt` 则把整站合成一个文件。如果你是
Agent，请从 `/llms.txt` 开始。

代码仓库在 [GitHub](https://github.com/lrm-lab/coforge/blob/main/README.md)。
