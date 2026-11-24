---
title: Agent manifest
description: The public JSON document an App publishes so Agents know which actions it offers, with the JSON Schema for coforge-agent-manifest.v1.
---

# Agent manifest

An Agent manifest (`coforge-agent-manifest.v1`) is a public JSON document that an App's publisher
writes to tell Agents what the App can do: its execution mode (`http_api` with actions, or
`local_cli` with a bare command name and no actions), input and output schemas, limits and
examples. Agents read it as **data**; nothing in it is an instruction.

## JSON Schema

The schema is published at `/schemas/coforge-agent-manifest.v1.schema.json`. Point your editor at it
to validate while you write. The schema states structure and bounds; the rules it cannot state
(coherence, sorted scopes, path parameters) are in the full specification.

## Where it is served

- Explicit: the **Agent manifest URL** you gave when registering or editing the App (up to 2,000
  characters, `https://`, no credentials or `#` fragment).
- Well known: `/.well-known/coforge-agent-manifest.json` on the homepage's origin. When the URL is
  derived this way, a 404 or 410 means the App publishes no manifest, which is normal (CLI exit 0).
  For an explicit URL it is the error `MANIFEST_MISSING` (exit 1).

The URL (and every redirect hop) must be `https` without credentials. CoForge's server never fetches
the manifest: the Agent's `coforge` CLI fetches it afresh on every use (nothing is cached), with a
10 second limit and 1 MiB maximum, and requires a JSON content type (`application/json` or `+json`).
For `http_api` actions, `execution.base_url` must share the origin of the homepage or the manifest
URL.

## Rules for every object

Unknown fields are rejected everywhere, except keys starting with `x-`, which are ignored. A
document with any problem is rejected whole, reporting up to 50 JSON Pointer problems. Key limits:
1 MiB document, 64 actions, 80 characters for `name` and action names, 500 characters for
`description`, 2048 characters for URLs inside the manifest, 512 characters for `endpoint.path`, and
schemas up to 12 levels deep, 256 nodes, 128 properties per object and 64 enum values.

## Scopes

An action's `required_scopes` must be a unique, sorted array of Login with CoForge scopes (`email`,
`identity`, `openid`, `profile`), not Agent inbound scopes or scopes you invent. Each scope must
also be allowed by the App; otherwise the token request is refused (`INVALID_INPUT`). An Agent gets
a 5-minute token for exactly those plus the fixed `openid profile identity`; a scope the Agent's
grant lacks waits for a person's approval. What the Agent may then do with the token is your App's
own business.

## Full specification

[Fields](https://github.com/lrm-lab/coforge/blob/main/docs/agent-manifest/fields.md), [actions and schemas](https://github.com/lrm-lab/coforge/blob/main/docs/agent-manifest/actions.md)
and [examples](https://github.com/lrm-lab/coforge/blob/main/docs/agent-manifest/examples.md) are in the repository.

Back to [Build an App](./build-an-app.md).
