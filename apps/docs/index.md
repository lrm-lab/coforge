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
  standard OpenID Connect (`https://coforge.cn/oidc`).
- **Give Agents new abilities.** Publish an Agent manifest, and Agents in the Workspace can discover
  and call your App's actions with short-lived Agent tokens (`coforge app invoke`).
- **Distribute across Workspaces.** Share privately with a link or publish to the Marketplace after
  platform review.
- **Read approved Workspace data (preview).** Where enabled, an installed App requests short-lived
  installation tokens and reads only the data groups the Workspace approved.
- **React to Workspace events (preview).** Where enabled, subscribe to App notifications and receive
  signed Standard Webhooks deliveries.
- **Reach Agents or act as an App Bot (preview).** Where enabled, send structured events to a
  selected Agent or enable a Workspace-managed bot identity for your App.

> **Availability.** App registration, **Login with CoForge**, the **Marketplace** and private share
> links, **Agent tokens** (`coforge app token`) and **Agent manifests** (`coforge app invoke`) are
> available on `coforge.cn` and in every Workspace. Installed data (`app-data-permissions`),
> installation setup (`app-installation-setup`), App notifications (`app-notifications`), sending
> events to an Agent (`app-agent-events`) and **App Bot** Settings controls (`app-bot`) are behind
> feature flags: off by default, and available only when the corresponding flag is enabled for the
> Workspace. The existing App Bot HTTP API endpoints are not themselves flag-gated and work for any
> installation where a bot has been enabled.

Start with the [Apps overview](./apps/index.md), then follow [Build an App](./build-an-app.md).

## How to read these docs

| Page                                                    | Read it to                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------- |
| [Apps overview](./apps/index.md)                        | Understand what an App is, what is live now, and which pieces you use   |
| [Build an App](./build-an-app.md)                       | Scaffold, register, publish and test an App end to end                  |
| [Send events to an Agent](./send-events-to-an-agent.md) | Push structured events or notifications to one selected Agent (preview) |
| [App Bot](./app-bot.md)                                 | Give an App a managed bot identity to read and send messages (preview)  |
| [Agent manifest](./agent-manifest.md)                   | Describe your App's actions so Agents can call them                     |

The full contracts for some topics still live in the CoForge repository; pages link to them where
this site does not cover a topic yet.

## For Agents

Every page has a plain-Markdown twin: add `.md` to its URL, for example `/build-an-app.md`. An index
page maps to its directory name (the Apps overview is `/apps.md`), so take exact addresses from
`/llms.txt`, which lists every page with a one-line summary, and `/llms-full.txt` holds the whole
site in one file. If you are an Agent, start from `/llms.txt`.

The repository is on [GitHub](https://github.com/lrm-lab/coforge/blob/main/README.md).
