---
title: Build an App
description: Scaffold a CoForge App, register it, publish an Agent manifest, and test it with the coforge CLI.
---

# Build an App

This is the shortest path from nothing to an App an Agent can call. It is written so that a coding
Agent can follow it as well as you. Apps are in early access; where a step is not available on your
CoForge deployment yet, it is not enabled there.

## 1. Scaffold

```bash
npm create coforge-app@latest my-app
# or
bun create coforge-app my-app
```

Pick a template (the scaffolder's source is [create-coforge-app](https://github.com/lrm-lab/create-coforge-app)):

| Template                     | Use it for                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pure-sign-in-web-app`       | A web App where people sign in with CoForge (authorization code with PKCE). It needs a client secret.                                                               |
| `hosted-http-action-service` | An HTTP service that Agents call with `coforge app invoke`. It publishes an Agent manifest and verifies the Agent tokens CoForge issues; it holds no client secret. |

Each template's README is the source of truth for its environment variables and commands.

## 2. Register the App

In CoForge open **Settings → Applications** (owners and admins) and register an App.

- Only the **name** is required.
- The **homepage** is optional. You need it for the well-known manifest address and for the origin
  check on an action's `base_url`.
- **Callback URLs** are optional; an App used only by Agents needs none. They must be https (http
  only for a loopback host), have no fragment, number at most 10, and are compared as exact strings.
- The **client ID** is the App key.
- The **client secret** is shown once. Store it in your secret store, never in source control.
  Regenerating it stops the old one at once.

## 3. Configure the App

Set the template's environment variables. `COFORGE_ISSUER` is `<your CoForge origin>/oidc` with no
trailing slash, and `COFORGE_CLIENT_ID` is the client ID.

- `pure-sign-in-web-app` also takes `COFORGE_CLIENT_SECRET`, `COFORGE_SCOPES`, `APP_ORIGIN` and a
  session secret.
- `hosted-http-action-service` takes only `COFORGE_ISSUER`, `COFORGE_CLIENT_ID`, `APP_ORIGIN` and
  `PORT`.

## 4. Publish an Agent manifest

Serve a JSON document at `/.well-known/coforge-agent-manifest.json` on your homepage's origin, or
register an explicit manifest URL. The `hosted-http-action-service` template ships one. See
[Agent manifest](./agent-manifest.md) for the format and the JSON Schema.

## 5. Test it

Install the App in a Workspace, then, as an Agent with the Agent CLI:

```bash
coforge app invoke <app-key> --list-actions
coforge app invoke <app-key> <action> --param key=value
coforge app invoke <app-key> <action> --data-json '{"key":"value"}' --preflight
```

The first command reads your manifest and prints the actions; add `--json` for machine-readable
output. The second calls an action with input from `--param` (repeatable) or one JSON object from
`--data-json`. `--preflight` validates the input and prints the request and scopes without sending
it. A manifest with any problem is rejected whole, with up to 50 problems, each a JSON Pointer path
and a message. Details: [calling actions](https://github.com/lrm-lab/coforge/blob/main/docs/agent-cli/app-invoke.md).

## 6. Share it

An App is private until you request Marketplace review or create a private share link; see
[Apps overview](./apps/index.md#marketplace-and-private-sharing).
