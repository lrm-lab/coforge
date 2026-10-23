# App Bot

An App Bot is an app's own identity inside a Workspace: an Agent the platform creates and manages
for the app. It can be messaged, @-mentioned and added to channels, and it sends messages as the
app. It has no Computer, daemon or runtime and takes no seat (CoForge has no seats); it acts only
when the app's backend calls the Agent API with the bot's key. It has no presence line, email or
push. Aligned with the reference product's "App Bot" (the reference's public page and web bundle,
read for design only).

Code: `apps/web/src/server/app-bots/` (module map in
[`src/server/AGENTS.md`](../../apps/web/src/server/AGENTS.md)), rows in
`apps/web/src/server/db/repositories/app-bot.repositories.server.ts`, tables in
[the database schema](../database-schema/app-bots.md). The calls an app's backend makes are in
[HTTP API](http-api.md); the public guide is `apps/docs/app-bot.md`.

## Three steps that imply nothing of each other

| Step | Who | What | What it does not do |
| --- | --- | --- | --- |
| 1. Declare | The app's developer (an owner or admin of the Workspace that owns the app) | Turns `enableBot` on in the editor's Bot section | Creates no bot anywhere |
| 2. Grant | An owner or admin of each Workspace where the app is installed | "Enable bot" on the installation in the app's detail | Is not automatic on install; Login with CoForge, agent access and notification approvals do not include it |
| 3. Call | The app's backend, with its client credentials | Mints the bot's key and calls the Agent API | A user's or Agent's token cannot mint it |

- **Declare off** revokes every grant of the app and disables its bots in one transaction, and ends
  their keys. Declaring is not gated by the flag below.
- **Grant** makes the bot Agent the first time: handle = the app's key (its public client id),
  display name = the app's name, public, no Computer, `systemKind = app-bot`, creator = the person
  who granted. A Workspace member or an ordinary Agent already holding the handle refuses the grant
  (CONFLICT `app-bot-handle-conflict`) and nothing is renamed. A bot Agent archived by an earlier
  uninstall of the app is adopted instead.
- **Revoke** ("Disable bot") flips the grant, clears the status line, ends the key and archives the
  Agent (hidden from lists, its messages kept). **Grant again** reactivates the same Agent with the
  next `generation`; messages it sent keep their sender, and a key of an earlier generation never
  works again.
- Uninstalling the app, or deleting it, archives its bots (`removeAppInstallations`,
  `PrismaAppRegistryStore.delete`); installing and granting again adopts the Agent.

## What the bot is

- A real member of the directory: it can be DM'd by any member, @-mentioned, and added to channels
  like any Agent. It is in no channel by itself: `enrollGeneralChannel` skips it, so it cannot post
  to a channel nobody added it to. It can open a direct message with any Workspace member itself.
- Its profile and hover card read the app's name, logo and the app's status line at read time, show
  a "Bot" badge and "Managed by app", and have no Computer, runtime, model, reminders, workspace or
  Activity sections; nobody edits or controls it from the profile (`canManageAgent` is false).
- Nothing launches it or pushes to a daemon: it has no Computer, so `AgentControl` does not find it,
  `AgentDeliveryPublisher` skips a delivery with no Computer, and a person's direct message to it
  (`SendDirectMessage`) is stored and left for the app's poll instead of failing for want of a
  Computer. The ordinary edit controls refuse it (`assertNotAppBot`, `app-bot-managed`).
- The app reads what waits for it with `GET /api/agent/v1/events` and answers with
  `POST /api/agent/v1/messages`; there is no push or webhook for the bot.

## Feature flag

`app-bot` ([feature flags](../feature-flags.md)) gates only the Settings controls: the editor's Bot
section and the installation's Enable bot / Bot enabled / Disable bot. The Server Functions, the two
app-backend routes and the Agent API are not gated, as in the reference. Every data flow stays
dark until a Workspace owner or admin enables a bot, so an ungated API cannot start anything.

## Deliberate differences from the reference

- **Route family.** The app-backend routes are `/api/app-installations/<id>/bot-token` and
  `/bot-status`, beside the existing installation APIs; the reference has them under
  `/api/oauth/installations/`. Bodies and refusals are `{error, error_description}` like the other
  installation and token endpoints.
- **Admin steps are Server Functions** for Settings (`app-bots.functions.ts`). CoForge has no public
  admin REST for apps (the reference's `PATCH /api/integrations/clients/:id` and
  `POST .../install/bot`). Refusals are `AppError`s with an `errorId`, not 409 bodies.
- **The key** is the one Agent API key format (`sk_agent_` + 43 characters) stored by hash, in its
  own table (`app_bot_credentials`) instead of a kind of `agent_api_keys`: that table requires a
  Computer and is checked with a daemon key, which a bot has neither. A bot presents it alone as
  `Authorization: Bearer`.
- **Capabilities** are deny-by-default by route (`app-bot-capabilities.server.ts`), see
  [HTTP API](http-api.md#what-the-key-may-call).
- **The creator** of the bot Agent is the person who first granted it (the column is required).
- A mention of a bot is not tracked as a launch: `MentionDeliveryIssuer` skips a bot, so the
  sender's mention delivery stays `pending` (never `lost`) and the message waits in the bot's inbox.
- The inbox is read without being taken (`AppBotInbox`: `since` acknowledges), unlike the daemon's
  drain of `/events`.
- People's Agent rosters (the sidebar, a person's own Agents, the Members page) leave bots out
  (`NOT_APP_BOT_WHERE`); the bot shows on its app's detail and through its profile and mention card,
  and the channel add-members picker still offers it. Delete, role, mascot, environment, runtime
  credential, migration, visibility and control all refuse it (`assertNotAppBot`).

## Not done

- The "Bot" badge beside the sender's name in the message stream: chat rows read sender facts from
  several message projections and a persisted cache, so the badge needs its own slice. The profile
  and the hover card have it.
