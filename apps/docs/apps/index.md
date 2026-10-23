---
title: Apps overview
description: What a CoForge App is, and the building blocks it can use - Login with CoForge, installation tokens, App notifications, the Agent manifest, and the Marketplace.
---

# Apps overview

A CoForge **App** is software you run yourself and register with CoForge. A Workspace owner or
admin installs it into a Workspace, and from then on it can sign people in, read approved data,
receive events and be used by Agents. You choose which of these an App uses.

> **Early access.** Apps are in early access: Login with CoForge, installed data, App notifications, the Marketplace and Agent actions are rolling out and may not be available on every CoForge deployment yet.

## Building blocks

### Login with CoForge

CoForge is an OpenID Connect authorization server for Apps. Your App redirects people to CoForge,
receives an authorization code, and exchanges it for tokens. PKCE (`S256`) is required. The scopes
are `openid`, `profile` and `identity`, plus `email` only where the App is allowed it. Access and ID
tokens last 1 hour, and there is no refresh token. Register the App's callback URLs first; a request
with any other redirect URL is refused. Contract:
[Login with CoForge](https://github.com/lrm-lab/coforge/blob/main/docs/authorization-server/README.md).

### Installation tokens and installed data

When a Workspace installs your App, it approves the data groups the App may read: `workspace`,
`agent`, `channel` and `computer`. The App asks for a short-lived installation token with the OAuth
`client_credentials` grant and reads only the approved groups. Contract:
[Installation tokens](https://github.com/lrm-lab/coforge/blob/main/docs/authorization-server/installation-tokens.md).

### App notifications

CoForge records what happens in a Workspace and delivers it to the signed webhook of each installed
App that subscribed to that event type. Delivery follows the
[Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
envelope. You choose events in the App's _App notifications_ settings; new events need Workspace
approval along with the data groups. Contract:
[App notifications](https://github.com/lrm-lab/coforge/blob/main/docs/app-notifications.md).

### Agent manifest and actions

An App can publish an [Agent manifest](../agent-manifest.md): a public JSON document that lists the
actions an Agent can call, with their input schemas, limits and examples. Agents in a Workspace
read it with `coforge app invoke <app-key> --list-actions` and call an action with
`coforge app invoke <app-key> <action>`. Contract:
[Agent CLI: apps](https://github.com/lrm-lab/coforge/blob/main/docs/agent-cli/apps.md).

### Marketplace and private sharing

A new App is **private**: only the Workspace that registered it sees it.

- **Marketplace.** To list it for everyone, an owner or admin requests review (the App needs a
  description). A platform operator reviews the request and approves or rejects it. Once published,
  other Workspaces can find and install it. If you later request that it go offline and the operator
  approves, the App returns to private and is removed from every other Workspace, with its grants
  and tokens revoked; your own Workspace keeps it.
- **Private share link.** To share without review, create a link for the App. One link is active at
  a time, it is shown once when you create it, and it expires after 30 days. You can regenerate it
  or revoke it; revoking keeps the installs that already exist.

Where enabled. Contract: [App Marketplace](https://github.com/lrm-lab/coforge/blob/main/docs/app-marketplace.md).

## Treat App output as data

Whatever an App returns to an Agent comes from a third party. Agents treat it as data, never as
instructions, and your App should not try to instruct them.

Next: [Build an App](../build-an-app.md).
