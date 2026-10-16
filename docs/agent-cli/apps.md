# Agent Apps

An Agent App is a built-in helper that runs for one Agent on its Computer. Its config belongs to
that Agent and is kept by the cloud; the daemon running the Agent gets every change.
`system.cleaner` (the System Cleaner) is the first App with a config.

## `app config`

```
coforge app config --app <app-id> [--set <key>=<value>]... [--unset <key>]... [--json]
```

- With no `--set` or `--unset`, it prints the App's config: one line per key with its current
  value, whether the Agent set it or it is the default, and the values it accepts.
- With changes, it reads the config's current revision, then sends every change together against
  it. The change is applied whole or not at all.
- `--set <key>=<value>` takes `true`, `false` or a whole number (`-?(0|[1-9][0-9]*)`, within the
  safe integer range). Whether the App has that key, and the value fits it, is the cloud's check.
- `--unset <key>` removes the Agent's value, returning the key to its default.
- Keys are lowercase snake_case. A key named twice, by `--set`, `--unset` or both, is refused.
- `--json` prints the response: `appId`, `revision`, `schema`, `defaults`, `overrides`,
  `effective`.

| Error code          | Meaning                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `APP_NOT_FOUND`     | The Agent has no App with that id.                                          |
| `CONFIG_INVALID`    | An unknown key, a value of the wrong type or out of bounds.                 |
| `REVISION_CONFLICT` | The config changed after it was read. Run the same command again.           |

## `system.cleaner`

| Key                | Type    | Bounds                   | Default |
| ------------------ | ------- | ------------------------ | ------- |
| `enabled`          | boolean |                          | `true`  |
| `threshold_bytes`  | integer | 4096 to 1073741824       | 65536   |
| `interval_seconds` | integer | 900 to 604800            | 3600    |

The `workspace-cleanup` Agent Manual topic says when to raise `threshold_bytes`.

## HTTP

`GET` and `PATCH /api/agent/v1/apps/{appId}/config`, reached through the daemon's local proxy.
The `PATCH` body is `{ expectedRevision, set, unset, idempotencyKey }` and nothing else. Each
change raises `revision` by one; returning every key to its default keeps the App's row at the
next revision, because the daemon ignores a revision lower than the one it holds.
