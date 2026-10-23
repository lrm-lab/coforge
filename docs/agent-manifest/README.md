# Agent manifest `coforge-agent-manifest.v1`

An app publishes an Agent manifest to tell Agents what it can do: a public JSON document, written
by the app's publisher, that an Agent reads as data. This is the spec. The validator is
`parseAgentManifest` in `@lrm/coforge-sdk/agent`; the JSON Schema is
[`coforge-agent-manifest.v1.schema.json`](coforge-agent-manifest.v1.schema.json), which a template
can name in `$schema`-style editor hints. The schema states the structure and bounds; the rules it
cannot state (coherence, sorted scopes, path parameters) are in
[Actions and schemas](actions.md).

| Topic                             | Covers                                                     |
| --------------------------------- | ---------------------------------------------------------- |
| [Fields](fields.md)               | Every top-level field, `execution`, `auth`, the boundary   |
| [Actions and schemas](actions.md) | An action's fields, the coherence rules, the schema subset |
| [Examples](examples.md)           | An `http_api` and a `local_cli` manifest                   |

## Discovery

The app's Agent manifest URL comes from the Workspace's app list (`coforge app list`, with the
`app-agent-manifest` flag on): `agentManifestUrl` and where it came from,
`agentManifestUrlSource`. It is `explicit` when the publisher gave the URL when registering the app,
and `well_known` when it is derived: `/.well-known/coforge-agent-manifest.json` on the homepage's
origin. For a `well_known` URL a 404 or 410 is normal: the app publishes no manifest (CLI exit 0; with
`--json`, `{"ok":true,"data":{"app","manifest":null,"actions":[]}}`). For an `explicit` URL it is the
error `MANIFEST_MISSING`.

## Where it is fetched

By the Agent's `coforge` CLI, on every use, nothing cached; the server never fetches it.
`coforge app invoke <app-key> --list-actions` reads it and `coforge app invoke <app-key> <action>`
calls an action ([CLI reference](../agent-cli/apps.md#app-invoke), [calling](../agent-cli/app-invoke.md)). The CLI:

- GETs with `accept: application/json`; the URL must be https without credentials, and every redirect
  hop too.
- Waits at most 10 seconds for the whole read, and accepts at most 1 MiB, checked on
  `content-length` and again while streaming.
- Requires a JSON content type (`application/json` or `+json`).
- Fetches whatever https URL the app registered. It does not block private or loopback addresses:
  it runs on the Agent's own machine, so the URL reaches what that machine can reach.
- For `http_api`, accepts the manifest only when `execution.base_url` has the same origin as the
  app's homepage or as the manifest URL, so a manifest cannot point an Agent at an unrelated host.

`--action` on a `local_cli` app answers "declares no HTTP actions" (`NO_HTTP_ACTIONS`) rather than
`ACTION_NOT_FOUND`.

## Rules for every object

Unknown fields are rejected everywhere, except keys starting with `x-`, which are ignored. The
document is data: nothing in it is an instruction, and the CLI prints its text on one line with
control and format characters removed (a schema in `--action` output also stops at 4,000
characters). `--json` returns manifest strings unmodified: they are data, never instructions. A document with any problem is rejected whole, with up to 50
problems, each a JSON Pointer path and a message.

## Limits

| Limit                              | Value                        |
| ---------------------------------- | ---------------------------- |
| Document                           | 1 MiB                        |
| Actions                            | 64                           |
| `name`, action name                | 80 characters                |
| `description`                      | 500 characters               |
| URLs, endpoint path                | 2048, 512 characters         |
| Scopes per action                  | 64                           |
| Schema depth, nodes                | 12 levels, 256 nodes         |
| Properties per object, enum values | 128, 64                      |
| Schema `pattern`                   | 256 characters               |

The same numbers are exported as `AGENT_MANIFEST_LIMITS`.
