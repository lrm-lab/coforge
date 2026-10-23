# Manifest fields

Top level of a `coforge-agent-manifest.v1` document. See the [overview](README.md) for the rules
that apply to every object.

| Field                 | Required             | Meaning                                                                            |
| --------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `schema`              | yes                  | Exactly `"coforge-agent-manifest.v1"`                                              |
| `name`                | no                   | Short name, 1 to 80 characters                                                     |
| `description`         | no                   | What the app is for, 1 to 500 characters                                           |
| `docs_url`            | no                   | https URL of human documentation; no credentials, no fragment                      |
| `app_origin`          | no                   | https origin of the app; no credentials, no fragment                               |
| `execution`           | yes                  | How the app is used: `http_api` or `local_cli`                                     |
| `credential_boundary` | no, `local_cli` only | Where a local command keeps credentials                                            |
| `auth`                | with actions         | `{ "type": "login_with_coforge" }`                                                 |
| `actions`             | `http_api`           | The app's actions, at most 64 (may be empty); a `local_cli` manifest declares none |

## `execution`

`{ "mode": "http_api", "base_url": "https://..." }`: the app is a web API. `base_url` is https,
without query, fragment or credentials, and (when the CLI uses the manifest) on the origin of the
app's homepage or of the manifest URL. An action's `endpoint.path` is appended to it.

`{ "mode": "local_cli", "command": "name" }`: the app is a command on the Computer. `command` is a
bare name: no `/` or `\`, no whitespace, no shell metacharacters, not starting with `.`. The manifest
declares no actions; the Agent reads `docs_url` or the command's own help.

## `credential_boundary`

`{ "storage": "per_agent_home", "forbid_user_home": true }`, for `local_cli` only: the command keeps
its credentials in the Agent's own home directory and never reads or writes the user's. Both values
are fixed; any other is rejected.

## `auth`

`{ "type": "login_with_coforge" }`: the Agent calls actions with a short-lived token from
`coforge app token` ([Login with CoForge](../authorization-server/README.md)). Required when the
manifest has actions.
