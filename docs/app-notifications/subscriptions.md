# App notifications: subscriptions and the editor

Which events an installation is delivered, and the editor section where an app subscribes. Part of
[app notifications](../app-notifications.md); delivery is in [HTTP delivery](http-delivery.md);
columns: [app registry](../database-schema/apps.md). The catalog and the rule are client-safe
(`apps/web/src/features/apps/app-notification-events.ts`), the fan-out is `subscribersOf`.

## Event catalog

Raft's catalog with the Workspace as `workspace.*` (Raft: `server.*`). Each event names the data
groups it needs (`APP_NOTIFICATION_EVENT_GROUPS`); the editor lists it under the first.

| Events | Needs |
| --- | --- |
| `workspace.member_added`, `member_removed`, `member_role_changed`, `config_updated` | workspace |
| `workspace.public_channel_created`, `public_channel_archived` | workspace, channel |
| `channel.member_added`, `member_removed`, `config_updated`, `archived`, `thread.created` | channel |
| `agent.status_changed`, `profile_updated`, `runtime_changed`, `model_changed` | agent |
| `computer.online`, `offline`, `version_changed` | computer |
| `computer.agent_started`, `agent_stopped` | computer, agent |

The catalog is the types an app may subscribe to (`thread.created` is the proposal's implicit event,
emitted when a thread's first reply is made, later). **Emitted today:** only `workspace.member_added`
(`APP_NOTIFICATION_EMITTED_EVENTS`; a compile-time assertion in `app-notification-event.ts` keeps it
equal to the recorded types), and the editor offers only emitted events. Raft's `server.plan_changed`
and `thread.resolved` have no CoForge counterpart and are not in the catalog.

## Subscribing and approving

`apps.notificationEvents` is declared with `permissionGroups` (`AppPermissions.declare(actor, key,
groups, events)`, the editor's Save): one compare-and-set on `permissionRevision`, which moves when
either set changes, so **an approval covers events and groups together** and the existing guard
(`app-permissions-changed`) protects both. An installation's approval records `approvedEvents` with
`approvedGroups`; "Approve update" approves every group and event shown.

- An event needing a group the app does not declare, or a name outside the catalog, is refused
  (`INVALID_INPUT`, `app-notification-events-invalid`). Events are refused with `ACCESS_DENIED`
  (`app-notifications-off`) where `app-notifications` is off; the events are shown only there.
- Removals are immediate: dropping an event removes it from every `approvedEvents`; dropping a group
  also removes the events that need it from the subscription and the approvals, in the same
  transaction. Adding an event, like adding a group, is pending until approved.
- A dedicated revision was not added: events and groups are approved in one act, and a second counter
  would need a second guard on the same button.

## Effective events

An installation is delivered an event when its type is in
`effectiveNotificationEvents`: the app's subscribed events, the installation approved, whose
required groups are all in the installation's approved groups that the app still declares
(`effectivePermissionGroups`). `subscribersOf` applies it per event, after the `app-notifications`
flag and, because the group check reads approved groups, the `app-data-permissions` flag: fan-out
requires both, and with the latter off nothing is delivered. The webhook must also have an endpoint:
a Setup webhook (enabled, no endpoint) is skipped.

## App notifications section

Behind `app-notifications` (and `app-data-permissions`), after App permissions in the editor, with
an Experimental badge and the status Off, Setup or Enabled (`WebhookStatus`).

- The "Enable webhook" `Toggle` applies at once both ways (design rule) and is disabled while
  registering ("Save the app before enabling its webhook"). On calls `enableAppWebhook`: the webhook
  is **Setup** (enabled, `endpointUrl` null, `app_webhooks_enabled_endpoint_check`), which delivers
  nothing; the generation moves on at enabling and the secret is shown by the first **Save
  endpoint** (its own button, acting at once), when the receiver is being configured. Off calls
  `disableAppWebhook` and deletes the endpoint at once. The status (Off, Setup, Enabled) is the
  server's (`WebhookStatus`).
- Enabled shows "Enabled · revision N", **Rotate secret**, and the "Signing secret · shown once"
  alert (the call that made it returns it once) with a copy button. Enter in the field saves the
  endpoint, not the form.
- "Webhook events" is the checklist of emitted events, listed only under the data groups the form
  selects in App permissions (none selected: a hint); an event needing another unselected group is
  disabled and says which to select. The choice
  is saved with the form's Save (`AppEditorSave`), atomically with the groups.
- The installation card and the app detail list, beside "Reads now" (the approved data), the
  developer's subscriptions (declared events) and the active events (effective); a pending update
  lists the pending groups and events together under "Approving the update approves all of these",
  also when only events are pending. An owner or admin sees the installation's
  delivery status (last delivery, last error, failures in a row, why it stopped) in the section and
  the app detail. Only owners and admins get the server state (`workspaceStatuses`); their app card shows
  a Webhook badge: Enabled, Setup or Off. Members get none.

## Tests

`app-notification-subscriptions.integration.test.ts` (real PostgreSQL, both flags; needs
`APP_NOTIFICATIONS_TEST_DATABASE_URL` and `DATABASE_URL`) covers declaring, refusals, approval,
immediate removals, `subscribersOf` and the CHECK constraints; `app-notification-events.test.ts`
the pure rule. Tests that expect a delivery subscribe the installation first
(`test/helpers/app-notification-subscription.ts`).
`app-webhook-setup.integration.test.ts` covers Setup (enable, first endpoint and its secret, disable, rotate, and who sees the statuses).
