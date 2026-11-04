# `app marketplace`

```
coforge app marketplace [<query>] [--limit <1-50>] [--json]
```

Browses, read-only, the apps other Workspaces published to the
[Marketplace](../app-marketplace.md): the Agent asks with its own identity and sees what any member
of its Workspace sees — each published app and whether this Workspace installed it. Installing
stays a person's, done in the Web app. `query` (at most 200 characters) matches name, key,
description or developer as plain text; `limit` is 1–50, default 20. Text output folds everything
an app's author wrote into framed single lines; `--json` prints the route's answer as it came. A
call outside these bounds fails locally as `INVALID_ARG`; a browse that fails at all fails as
`INTEGRATION_MARKETPLACE_FAILED`.

## HTTP

`GET /api/agent/v1/apps/marketplace?query=&limit=` (`coforge app marketplace`, Raft's `integration
marketplace`): the Agent browses, with its own identity, what any member of its Workspace sees in
the [Marketplace](../app-marketplace.md); it installs nothing. `query` (at most 200 characters, as
plain text) matches name, key, description or developer; `limit` is 1–50, default 20. It answers
`{ surface: "public_marketplace", metadataTrust: "untrusted_app_supplied", query, limit, truncated,
apps }` (types: `@lrm/coforge-sdk/agent` `app-marketplace.ts`); app text is the author's, untrusted.
