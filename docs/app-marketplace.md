# App Marketplace review

How an app registered in one Workspace asks to be listed in the Marketplace, how a platform
operator decides, and how another Workspace finds a listed app and installs it. Private share links
come later. The code is `apps/web/src/server/app-marketplace/` (`AppPublishing`, `AppInstallations`);
everything is behind the
`app-marketplace` [feature flag](feature-flags.md), checked for the Workspace a request comes from,
and refused with `ACCESS_DENIED` (`app-marketplace-off`) where it is off. The design follows Raft
(its publish documentation and the app editor's Distribution section); the reviewer being a
platform operator, not a Workspace role, is the approved decision of 2026-10-21.

## Status

`apps.publishStatus` is `private` (the default), `publish_requested`, `published`, `rejected` or
`unpublish_requested` (`apps_publish_status_check`); `publishedAt` is set when a publication is
approved and kept afterwards.

| From | Action | To |
| --- | --- | --- |
| `private`, `rejected` | request publish | `publish_requested` |
| `publish_requested` | withdraw | `private` (the request is deleted) |
| `publish_requested` | reviewer approves / rejects | `published` / `rejected` |
| `published` | request unpublish | `unpublish_requested` |
| `unpublish_requested` | reviewer approves / rejects | `private` / `published` |

- Owners and admins of the app's Workspace request and withdraw. A repeat request answers the
  status the first reached; a publish request for an app with no description is `INVALID_INPUT`
  (`app-description-required`); a request that the status does not allow is `CONFLICT`
  (`app-publish-status-conflict`).
- `app_review_requests` holds one row per request. A partial unique index
  (`app_review_requests_one_pending`, `outcome IS NULL`) allows one pending request per app, and
  the status change and the request row are written in one transaction.
- A reviewer's reason is stored on the request and shown to reviewers only; the developer's editor
  and the app summaries never carry it (Raft does not show it either).
- A published app, or one with an unpublish request pending, cannot be deleted
  (`CONFLICT`, `app-published-undeletable`); the editor hides Delete while an unpublish request
  is pending (Edit stays, so the "Offline pending" hint is reachable).
- Approving an unpublish request makes the app `private` and, in the same transaction, removes every
  other Workspace's installation and revokes what it had granted (see Installing). A rejection
  returns the app to `published` and changes nothing for installs.

## Installing

Every member of a Workspace where the flag is on browses the Marketplace (`AppInstallations.listings`):
the apps whose status is `published` or `unpublish_requested` (Raft keeps an app listed and
installable while its removal waits) that the Workspace does not own. Owners and admins (who manage
apps) install and uninstall. A private, requested or rejected app, and the Workspace's own, is
`NOT_FOUND` to another Workspace; with the flag off every read and write is `ACCESS_DENIED`
(`app-marketplace-off`).

- An install writes the same `app_installations` row registering an app does (Agent access `all`,
  setup `pending`), and, where `app-data-permissions` is on, approves the declaration the installer
  was shown through `AppPermissions.approve`, in one transaction (Raft: "Install records exactly
  these"). The install names the `permissionRevision` it was shown; a declaration that moved on is
  `CONFLICT` (`app-permissions-changed`), nothing is installed and the tab reloads. Installing an app
  already installed changes nothing.
- The registering Workspace's installation is made at registration and stays; it is never listed in
  its own Marketplace.
- Uninstall (owners and admins, from the installed app's detail, for an app another Workspace owns;
  the Workspace's own app is deleted in its editor) and an approved offline request share
  `removeAppInstallations`: the people's consents are revoked, the authorization codes deleted (so a
  later consent cannot revive an old grant), the Agents' grants revoked and their pending requests
  denied, and the installation deleted, which ends installation tokens and Login with CoForge
  sessions at once. Revoked grant rows stay, so after a reinstall an Agent needs a person's approval.
- An approved offline request does this in every Workspace but the app's owner. Deviation from
  Raft's publish page ("your own included"): the app's UI says offline approval "preserves the
  source Server's installation and access", and removing the owner's installation would leave the
  app invisible and unmanageable in its own Workspace, so the owner keeps its own.
- Login with CoForge offers a person only the Workspaces where they are a member and the app is
  installed (`listOfferedWorkspaces`), so it follows installs and uninstalls with no further rule.
- A listed app's logo is readable by any signed-in person (the Marketplace shows it before an
  install); a private app's only by members of a Workspace where it is installed or, while pending,
  by an operator.

## Platform operators

`platform_operators` (`userId` primary key, cascade delete with the user; `role`, today only
`app_reviewer`, `platform_operators_role_check`; `grantedAt`; `grantedByUserId`) is the first
platform-level permission: it belongs to a person, not to a Workspace membership. Only an operator
sees the review queue and decides. The check is `AppPublishing.canReviewMarketplaceApps`.

The first operator is granted from a shell on the server:

```sh
cd apps/web
DATABASE_URL=... bun run scripts/grant-platform-operator.ts person@example.com
```

It matches the person's sign-in email (case-insensitive), is repeatable, and grants nothing when the
email matches no person or more than one (`grantPlatformOperator`). There is no environment variable
and no operator-grants-operator path yet.

## Pages

- Settings -> Applications, app editor, Distribution section (editing only): status badge; while
  `publish_requested` a hint and "Withdraw request"; while `private` or `rejected` "Request publish",
  which saves the editor first; a note once `published`. "Request offline review" is a row of the
  Danger zone (Raft's "Marketplace lifecycle"), shown only while `published`.
- Settings -> Applications has the tab Marketplace (only where the flag is on; the URL value
  `appsTab=marketplace`): search, category filter and grid/list as on the other tabs; each card shows
  name, logo, category, developer (the owner Workspace's name), install count and Installed. The
  detail shows description, homepage and callback domains, the Login with CoForge scopes, data groups
  and notification events, and, for an owner or admin, "Install to this Workspace". Installed lists
  every app installed here (a Marketplace app marked "From Marketplace", with Uninstall in its
  detail); My apps lists only the Workspace's own.
- `/w/<slug>/app-review` lists the pending requests for an operator (name, publisher Workspace,
  category, homepage, login scopes, data groups, notification events, logo, request time) with
  Approve and Reject (with a reason). Anyone else gets a 404. Settings -> Applications links to it
  for an operator. A pending app's logo is readable by operators through the logo route.
