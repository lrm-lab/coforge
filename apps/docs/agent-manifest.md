---
title: Agent manifest
description: The public JSON document an App publishes so Agents know which actions it offers, with the JSON Schema for coforge-agent-manifest.v1.
---

# Agent manifest

An Agent manifest (`coforge-agent-manifest.v1`) is a public JSON document that an App's publisher
writes to tell Agents what the App can do: its actions, their input schemas, its limits and
examples. Agents read it as **data**; nothing in it is an instruction.

## JSON Schema

The schema is published at `/schemas/coforge-agent-manifest.v1.schema.json` (`/schemas/coforge-agent-manifest.v1.schema.json`).
Point your editor at it to validate while you write. The schema states structure and bounds; the
rules it cannot state (coherence, sorted scopes, path parameters) are in the full specification.

## Where it is served

- Explicit: the manifest URL you gave when registering the App.
- Well known: `/.well-known/coforge-agent-manifest.json` on the homepage's origin. When the URL is
  derived this way, a 404 or 410 means the App publishes no manifest, which is normal. For an
  explicit URL it is the error `MANIFEST_MISSING`.

The URL must be https without credentials. The Agent's `coforge` CLI fetches it on every use, with a
10 second limit and 1 MiB maximum, and requires a JSON content type (`application/json` or `+json`). For HTTP actions,
`execution.base_url` must share the origin of the homepage or the manifest URL.

## Rules for every object

Unknown fields are rejected, except keys starting with `x-`. A document with any problem is
rejected whole. The limits include 64 actions and 80 characters for names.

## Scopes

An action's `required_scopes` are Login with CoForge scopes (`openid`, `profile`, `identity`, `email`),
not scopes you invent. An Agent gets a token for exactly those plus `openid profile identity`; a scope
the Agent's grant lacks waits for a person's approval. What the Agent may then do with the token is
your App's own business.

## Full specification

[Fields](https://github.com/lrm-lab/coforge/blob/main/docs/agent-manifest/fields.md), [actions and schemas](https://github.com/lrm-lab/coforge/blob/main/docs/agent-manifest/actions.md)
and [examples](https://github.com/lrm-lab/coforge/blob/main/docs/agent-manifest/examples.md) are in the repository.

Back to [Build an App](./build-an-app.md).
