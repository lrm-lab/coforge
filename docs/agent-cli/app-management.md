# Managing an app as an Agent

After an app is [registered](app-registration.md), its owner Agent, and any admin-role Agent of the
app's Workspace, manages it from the CLI. This is Raft's `integration app` command set (update,
logo, owner transfer and recovery, delete, share links, publish requests); the Agent's right is the
registration doc's `canManage`, read afresh on every call.

**Who may.** The app's owner Agent, or an Agent whose server role is `admin` in the app's
Workspace, and only while it is not archived. Anyone else, an unknown key, and another Workspace's
app are all `NOT_FOUND`, so an app is not confirmed to exist. Every command takes `--client <key>`
and (except `prepare`) `--json`. No person approves any of them; the exception is
`prepare recover-owner`, which is a card.

## `app update`

```
coforge app update --client <key> [--name <n>] [--description <t>] [--when-to-use <t>]
  [--category <c>] [--homepage-url <u> | --clear-homepage-url]
  [--redirect-url <u>]... | [--add-redirect-url <u>]...
  [--agent-manifest-url <u> | --clear-agent-manifest-url]
  [--scope <scope>]... | [--clear-scopes] [--json]
```

Changes the fields named; the rest stay. The server checks every value with the app registry's own
rules (the same as Settings → Applications): `INVALID_INPUT` names the field (`app-name-invalid`,
`app-redirect-uris-invalid`, ...). The client key, the secret and the Workspace never change.

- `--redirect-url` replaces the list, `--add-redirect-url` appends (duplicates dropped); the two do
  not combine. **A redirect URL cannot be cleared** (Raft refuses it): an empty list is refused.
- `--scope` replaces the Login scopes beyond the fixed ones (`openid`, `profile`, `identity`), as
  at registration; `--clear-scopes` leaves only the fixed ones.
- Setting `--agent-manifest-url` needs `app-agent-manifest` on for the Workspace
  (`app-agent-manifest-off`, `access_denied`), as in Settings.
- Data permissions and notification events are not changed here; installed Workspaces re-approve
  those through the installation's own mechanism, which an update never touches.

It prints the app afterwards (`{ "app": {...} }` with `--json`, never a secret).

## `app logo` and `app clear-logo`

```
coforge app logo --client <key> --file <path> [--json]
coforge app clear-logo --client <key> [--json]
```

`--file` is a PNG, JPEG, GIF or WebP of at most 5 MB (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`);
the CLI names the type from the extension and checks the size, and the server checks the bytes with
the editor's own upload rule (`INVALID_INPUT`). The old logo's object is removed.

## `app transfer-owner`

```
coforge app transfer-owner --client <key> --to-agent <name> [--json]
```

Makes another **live, public Agent of the same Workspace** (`name`, `@name` or id) the owner Agent.
The current owner Agent or an admin-role Agent may. Naming the owner Agent already there is a no-op
(`changed: false`). The receipt is `{ clientKey, changed, ownerAgent, previousOwnerAgent, at }`.
An archived, private, system or other Workspace's Agent is `INVALID_INPUT`
(`app-owner-agent-invalid`). After a transfer the former owner Agent has no right unless it is an
admin. The new owner receives no secret; it rotates one if it needs it.

## `app prepare recover-owner`

```
coforge app prepare recover-owner --client <key> --to-agent <name> --target <target>
  [--draft-hint <text>]
```

Posts an `app:recover_owner` [action card](action-cards.md) into `<target>`. Only an admin-role
Agent can prepare it (a dead owner Agent has no right), and only while the app has **no live owner
Agent** (the owner was archived or deleted): with a live one it fails `APP_OWNER_ACTIVE` (409). The
Agent named must be a live public Agent of the Workspace (`INVALID_HANDLE`, `--to-agent`).

A **Workspace owner or admin** commits the card in the web app; a member is refused and sees why.
Committing re-checks both conditions in one transaction with settling the card, so a card prepared
earlier is `CONFLICT` (`app-owner-active`) once an owner is live again, and commits once.

## `app delete`

```
coforge app delete --client <key> [--json]
```

Deletes an app that is not published: the app, its installations and its logo go, and its secret
stops verifying. A `published` or `unpublish_requested` app is refused (`conflict`,
`app-published-undeletable`); ask for its removal first (`request-unpublish`) and delete it once a
reviewer has made it private. Deleting is not undone and has no card.

## Share links

```
coforge app share-link --client <key> [--expires-days <1-365>] [--json]
coforge app share-link-status --client <key> [--json]
coforge app revoke-share-link --client <key> [--json]
```

A [private share link](../app-marketplace.md#private-share-links) lets an owner or admin of another
Workspace install the app without Marketplace review. `share-link` makes one (30 days by default,
1 to 365 as in Raft's agent CLI), revokes the previous one, and **prints the URL once**; nothing
stores it (only its hash), so `share-link-status` shows only whether a link is active and when it
was made and ends. `revoke-share-link` ends it, in any publish status; Workspaces that installed
keep the app. Only a `private` or `rejected` app is shared (`app-share-status-conflict`). All three
are `access_denied` (`app-marketplace-off`) where `app-marketplace` is off for the Workspace.

## Publish requests

```
coforge app request-publish --client <key> [--json]
coforge app request-unpublish --client <key> [--json]
```

Files the [Marketplace review](../app-marketplace.md) request a platform reviewer decides and
prints the app's publish status (`publish_requested`, `unpublish_requested`). A publish request
needs a description (`app-description-required`; set one with `app update --description`) and an
app that is `private` or `rejected`; an unpublish request needs a `published` app
(`app-publish-status-conflict` otherwise). Repeating a request answers the state it reached. Behind
`app-marketplace` like share links. Rows these Agent requests write record no requesting user.

## HTTP

The CLI posts `{ operation, clientKey, ... }` to the daemon's `POST /api/agent/v1/app-registrations`
(the same route and vocabulary as [registration](app-registration.md#http); the route accepts a body
of up to 8 MB for a logo's base64). The daemon forwards each with the Agent's key:

| Operation                               | Cloud route                                              |
| --------------------------------------- | -------------------------------------------------------- |
| `update` (body: the changed fields)     | `PATCH /api/agent/v1/apps/owned/{key}`                   |
| `delete`                                | `DELETE /api/agent/v1/apps/owned/{key}`                  |
| `logo_set` (`contentType`, `dataBase64`)| `PUT /api/agent/v1/apps/owned/{key}/logo`                |
| `logo_clear`                            | `DELETE /api/agent/v1/apps/owned/{key}/logo`             |
| `transfer_owner` (`toAgent`)            | `POST /api/agent/v1/apps/owned/{key}/transfer-owner`     |
| `share_link_create` (`expiresDays`)     | `POST /api/agent/v1/apps/owned/{key}/share-link`         |
| `share_link_status`                     | `GET /api/agent/v1/apps/owned/{key}/share-link`          |
| `share_link_revoke`                     | `DELETE /api/agent/v1/apps/owned/{key}/share-link`       |
| `request_publish`                       | `POST /api/agent/v1/apps/owned/{key}/publish-request`    |
| `request_unpublish`                     | `POST /api/agent/v1/apps/owned/{key}/unpublish-request`  |

Answers are `{ ok: true, ... }` with `cache-control: no-store`; errors are `{ ok: false, errorCode,
error }` as for `app token` (`not_found`, `conflict`, `invalid_input`, `access_denied`,
`request_invalid`). The recovery card goes through `POST /api/agent/v1/actions/prepare`.

## Differences from Raft

- **Update is not approved by a person**, as in Raft; installed Workspaces still re-approve
  data-permission changes.
- **`--clear-homepage-url`, `--clear-agent-manifest-url` and `--add-redirect-url`** are CoForge's
  additions for the optional URLs and for extending the redirect list; Raft's redirect URLs cannot
  be cleared either.
- **An Agent's ownership is one Agent per app**, as for registration; transfer is limited to public
  Agents so a private Agent's name does not appear in Settings or on a card.
- **Agent-made rows have no user**: a share link or review request an Agent files records no
  creator (the columns are nullable), unlike the editor's.
