# App Marketplace review

How an app registered in one Workspace asks to be listed in the Marketplace, and how a platform
operator decides. This is the first slice of the Marketplace: publish review only. Private share
links, installing a listed app in another Workspace and the Marketplace tab come later. The code is
`apps/web/src/server/app-marketplace/` (`AppPublishing`); everything is behind the
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
- Approving an unpublish request only makes the app `private` here. Removing the other Workspaces'
  installations is the install slice's, which hooks into `AppPublishing.decide`.

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
- `/w/<slug>/app-review` lists the pending requests for an operator (name, publisher Workspace,
  category, homepage, login scopes, data groups, notification events, logo, request time) with
  Approve and Reject (with a reason). Anyone else gets a 404. Settings -> Applications links to it
  for an operator. A pending app's logo is readable by operators through the logo route.
