# Installation setup

Some apps need configuring after they are installed: connecting an external account, say. An app
declares the page for that in its editor (Settings → Applications, "Installation setup"), and reports
back, per installation, when the setup is done. The data model and status rules are in
[the app registry](../database-schema/apps.md#installation-setup); the code is
`apps/web/src/server/app-installation-setup/` and, for the HTTP side,
`authorization-server/setup-endpoint.server.ts`. The shape follows Raft's `setupUrl`,
`setupDescription` and setup status.

Everything here is behind the `app-installation-setup` flag ([feature flags](../feature-flags.md)),
evaluated for the installation's Workspace. With the flag off, an installation token is
`invalid_token` (401) on the setup API (the answer any installation API gives for a flag that went
off) and the lookup answers 404, as for a Workspace the app is not installed in: the feature does not
exist there. Without a configured issuer both routes answer 404.

## What the app declares

| Field | Rule |
| --- | --- |
| Setup page URL | https, or http on `localhost`, `127.0.0.1` or `[::1]`; at most 2000 characters; canonical (`new URL(s).href === s`); no user info; no fragment. Empty: no setup is required |
| Configuration instructions | One line of at most 500 characters |

Opening the page appends `installation_id`, `workspace_id` and `setup_revision` to its query,
replacing a parameter of the same name. Those ids only tell the app which installation to look up; it
trusts nothing in the URL and authenticates with a token. Only a Workspace's owners and admins get the
link ("Continue setup" until it is configured, then "Manage configuration"); a member sees the status
and is told to ask an owner or admin.

Deliberate departure from Raft: Raft's app reports setup with the client secret in the request body; CoForge authenticates the setup API with a short-lived [installation token](installation-tokens.md) (and the lookup with HTTP Basic), so the long-lived secret never travels with a per-installation request and a leaked setup call exposes only one installation for ten minutes.

Deliberate departures from Raft: `workspace_id` replaces `server_id` in the setup URL, and status labels and button text use CoForge's sentence-case wording. Members see the status on the app card.

## Status

`not_required` (no page), `pending` or `complete` for an installation, derived from the app's
`setupRevision` and what the installation completed. A reinstall, or any new installation, starts
`pending`.

## Finding the installation

`POST /api/app-installations/lookup`, JSON `{"workspace_id": "<uuid>"}`, authenticated with the app's
client credentials by HTTP Basic (`client_secret_basic`, RFC 6749 §2.3.1); a secret in the body is not
read. Answers, all `no-store`:

| Status | When |
| --- | --- |
| 200 | `{installation_id, workspace_id, setup}` |
| 400 | `workspace_id` is not a UUID, or the body is not a JSON object (`invalid_request`) |
| 401 | The credentials are missing or wrong (`invalid_client`, `WWW-Authenticate: Basic`) |
| 404 | The app is not installed in that Workspace, or the flag is off there |

## Reading and reporting

`GET` and `PUT /api/app-installations/<installation id>/setup`, authenticated with an
[installation token](installation-tokens.md) of any scope, an empty one included, in the
`Authorization: Bearer` header (RFC 6750 §2.1; no form or query token). The secret never travels
with a setup request. `PUT` takes JSON `{"revision": <integer>, "status": "pending" | "complete"}`.

The setup object, in every 200:

```json
{ "status": "pending", "url": "https://acme.example/setup?installation_id=…&workspace_id=…&setup_revision=3",
  "description": "Connect your Acme account", "revision": 3, "completed_at": null }
```

`url` is the page with its three parameters, `null` when no setup is required; `completed_at` is when
the installation first reported the revision complete, `null` unless `complete`.

| Status | When |
| --- | --- |
| 200 | The setup object (for `PUT`, as it then is) |
| 400 | `PUT` with a `revision` that is not a non-negative integer or a `status` that is neither value (`invalid_request`); a malformed `Authorization` header |
| 401 | No token (bare `WWW-Authenticate: Bearer` challenge), or `invalid_token`: the token does not verify, names another installation, the installation is gone, or the flag is off |
| 403 | `insufficient_scope`: a data group of the token is no longer effective; request a new token |
| 409 | `stale_revision`: the app declared a newer revision than the one reported; `setup_not_required`: the app has no setup page |

Reporting `complete` records the revision and the time; repeating it keeps the first time. `pending`
clears the completion. Both are idempotent. Changing the page, or turning setup on and off, raises the
revision, so every installation is `pending` again; changing only the instructions does not.
