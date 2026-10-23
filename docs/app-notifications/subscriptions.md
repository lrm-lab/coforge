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

The catalog is the types an app may subscribe to. **Emitted today:** every event above except the
three whose state lives only in Redis leases (`agent.status_changed`, `computer.online`,
`computer.offline`, [below](#events-not-emitted)). `APP_NOTIFICATION_EMITTED_EVENTS` lists them; a
compile-time assertion in `app-notification-event.ts` keeps it equal to the recorded types, and the
editor offers only emitted events. Raft's `server.plan_changed` and `thread.resolved` have no
CoForge counterpart and are not in the catalog.

## Event data

Each event is recorded by the domain write itself, in its transaction, so it exists only if the
write commits. `data` holds ids and the changed fields, never message content, an email or a
secret. Its keys are snake_case in the stored event and on the wire alike
([HTTP delivery](http-delivery.md)), and so are the names in `fields`. Emit sites are the module helpers in `server/app-notifications/`
(`workspace-events`, `channel-events`, `agent-events`, `computer-events`), called from:

| Event | `data` | Recorded by |
| --- | --- | --- |
| `workspace.member_added` | `user_id`, `role` | `admitWorkspaceMember` (a join link) |
| `workspace.member_removed` | `user_id` | `removeMember` of the member directory store (removal and leaving) |
| `workspace.member_role_changed` | `user_id`, `previous_role`, `role` | `updateRole` of the member directory store |
| `workspace.config_updated` | `fields` (`name`, `slug`, `icon`), `name`, `slug` for those changed | catalog `rename`, `moveWorkspaceSlug`, `WorkspaceImages.store` |
| `workspace.public_channel_created` | `channel_id`, `name` | `createChannel` (a person's and an Agent's creation), `enrollGeneralChannel` and `createOwnedWorkspace` (`#general` coming to exist) |
| `workspace.public_channel_archived`, `channel.archived` | `channel_id` | `setChannelArchived` (archiving; unarchiving records nothing) |
| `channel.member_added` | `channel_id`, and `user_id` or `agent_id` | channel creation (its creator), `join`, `addMembers` (`upsertChannelMembers`), an Agent's `join` (`joinChannelAsAgent`), `#general` enrollment (`enrollGeneralChannel`, `joinGeneralChannel`), the Workspace Memory Agent joining a channel (`addUnmutedMember`) |
| `channel.member_removed` | `channel_id`, and `user_id` or `agent_id` | `softLeaveMember` in `channel-changes.server.ts` (leave, removal, the Agent CLI), a Workspace member leaving or removed (each channel), an Agent made private or deleted (each channel) |
| `channel.config_updated` | `channel_id`, `fields` (`name`, `description`), `name` when renamed | `updateChannelInfo` (only a value that differs) |
| `thread.created` | `channel_id`, `thread_root_id`, `message_id` | the first reply to a message in a channel: `PublicChannels.send`, `sendAgentMessage` |
| `agent.profile_updated` | `agent_id`, `fields` (`display_name`, `description`, `avatar`) | `AgentRepository.update`, `resolveAgentProfileUpdate`, `AgentAvatars` (upload and removal), the weekly-report assistant's rename (`WorkspaceMembers`) |
| `agent.runtime_changed` | `agent_id`, `previous_runtime`, `runtime` | `AgentRepository.update` (runtime config diff) |
| `agent.model_changed` | `agent_id`, `fields` (`model`, `model_provider`, `reasoning`, `fast_mode`), `previous_model`, `model` | `AgentRepository.update` (runtime config diff) |
| `computer.version_changed` | `computer_id`, `previous_version`, `version` | `recordComputerObservation`, once per Workspace the Computer is linked to |
| `computer.agent_started`, `computer.agent_stopped` | `computer_id`, `agent_id` | `PrismaAgentControlStore.replace`, when the Computer's answer to a Start or Stop is stored (a restart is a stop, then a start) |

A no-op records nothing: a repeat join, add or archive, an edit that changes no field, a first
version report (no earlier version), an API key or environment change alone. `thread.created` is
for channels only. Not emitted: channel deletion, unarchiving, a channel coordinator or role change,
an Agent's visibility or role, because the catalog has no event for them.

## Cost and safety of emitting

Integrations never block or slow a core operation. `appNotificationsPossible()` (the flag file defines
`app-notifications`, a lookup of the loaded definitions, no query) gates every emitter: while it is
false (production's default) each write is the single statement it always was, with no savepoint, row
lock, extra read or interactive transaction, and an emitter returns before it builds anything
(`app-notification-emitters-cost.integration.test.ts` counts the statements). While it is true, the
Workspace's slug is read once per operation (one `recordAppNotifications` call per operation lists all
its events), a Workspace the flag is off for is dropped before any query when the slug is known, and
everything an emitter does besides the domain write (that read, a previous-value read, a first-reply
check, building the events) runs in a SAVEPOINT (`attemptAppNotification`), so a failing emitter query
rolls back to it and the write commits (`app-notification-emitters-resilience.integration.test.ts`).

## Events not emitted

`agent.status_changed`, `computer.online` and `computer.offline` come from Redis leases (the 90 s
status keys written by `RedisAgentStatusCache.put` and `RedisComputerStatusCache.put`) with no
PostgreSQL write, so there is no transaction to join. They would be best effort, recorded outside a
transaction, like Agent Activity; they are not built yet.

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
