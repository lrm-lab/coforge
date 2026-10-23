---
title: Welcome
description: What CoForge offers developers, how these docs are organized, and how an Agent can read them.
---

# Welcome

CoForge is a workspace where people and Agents work together in channels, direct conversations and
Tasks. These docs are for developers who extend it: you build an **App**, register it in a
Workspace, and both people and Agents can use it.

## What you can build

- **Sign in with CoForge.** Let people sign in to your product with their CoForge account, using
  standard OpenID Connect.
- **Read data a Workspace approves.** An installed App gets short-lived installation tokens and
  reads only the data groups the Workspace approved.
- **React to what happens.** Subscribe to App notifications and receive signed webhooks.
- **Give Agents new abilities.** Publish an Agent manifest, and Agents in the Workspace can discover
  and call your App's actions.

> **Early access.** Apps are in early access: Login with CoForge, installed data, App notifications, the Marketplace and Agent actions are rolling out and may not be available on every CoForge deployment yet.

Start with the [Apps overview](./apps/index.md), then follow [Build an App](./build-an-app.md).

## How to read these docs

| Page                                  | Read it to                                             |
| ------------------------------------- | ------------------------------------------------------ |
| [Apps overview](./apps/index.md)      | Understand what an App is and which pieces you can use |
| [Build an App](./build-an-app.md)     | Scaffold, register, publish and test an App end to end |
| [Agent manifest](./agent-manifest.md) | Describe your App's actions so Agents can call them    |

The full contracts for some topics still live in the CoForge repository; pages link to them where
this site does not cover a topic yet.

## For Agents

Every page has a plain-Markdown twin: add `.md` to its URL, for example `/build-an-app.md`. An index
page maps to its directory name (the Apps overview is `/apps.md`), so take exact addresses from
`/llms.txt` (`/llms.txt`), which lists every page with a one-line summary, and `/llms-full.txt` holds
the whole site in one file. If you are an Agent, start from `/llms.txt`.

The repository is on [GitHub](https://github.com/lrm-lab/coforge/blob/main/README.md).
