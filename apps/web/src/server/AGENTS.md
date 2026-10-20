# Server modules

The module map of `src/server/`, split out of [`apps/web/AGENTS.md`](../../AGENTS.md#module-map). Each line names a directory under `src/` and its single responsibility. Update it before adding or reorganizing a module.

- `server/agent-migrations/` — moving an Agent and its workspace files to another Computer: state machine, step roles, fencing, stopping and starting the Agent around the transfer, the leases and cancels pushed to each Computer, and the daemons' HTTPS steps with presigned chunk URLs (`/api/daemon/agent-migrations`).
- `server/agent-app-configs/` — each Agent App's config for an Agent (the keys it overrode; defaults at revision 0 when unstored), the Agent's own read and revision-checked change of it (`coforge app config`), the daemon's snapshot, and pushing a change to a daemon that advertises `app-config:v1`.
- `server/agents/` — Agent lifecycle, control, sessions, a new Agent's introduction to its creator, display reduction,
  Activity (Computer lifecycle rows included), visibility, deletion, and the
  Agent HTTPS API, and platform assistants with private execution per member.
- `server/apps/` — the app registry: the apps a Workspace registers (OIDC clients) and their client secrets; built-in Agent Apps are the SDK's `BUILT_IN_APPS`, and one Agent's config of an App is `server/agent-app-configs/`.
- `server/attachments/` — attachment upload sessions, claiming a sender's uploads for a new message, and delivery.
- `server/auth/` — login, sessions, username allocation, the first-sign-in name step, device auth, API keys, and auth guards.
- `server/authorization-server/` — Login with CoForge: the OpenID Connect authorization server for third-party apps (issuer `<origin>/oidc`), its own signing keyset, discovery, JWKS, and the authorization endpoint (request checks, Workspace offering, remembered consent, authorization codes). The Computer device flow stays in `server/auth/`.
- `server/centrifugo/` — Centrifugo proxies, RPC receivers, and short-lived result caches.
- `server/computers/` — Computer registration, metadata, restart and upgrade
  operations, runtime visibility, explicit model catalog refresh, and what the server remembers across a
  daemon's shutdown and return.
- `server/hosts/` — host-node enrollment, registration, heartbeat, the global online list, and container-computer jobs.
- `server/conversations/` — public channels, channel authority, stopping and resuming a channel's Agents, direct messages, history, message search, action cards, reactions, tracked @mention delivery outcomes (`mention-deliveries`), and conversation realtime.
- `server/db/` — the Prisma client, repositories (a DM's list preferences apart from its messages; the Agent attention rule in `agent-attention`), and the shared unique-violation check.
- `server/errors/` — public error mapping and request error handling.
- `server/files/` — file storage (per object, and bulk removal by keys or prefix), delivery, and uploaded-image validation.
- `server/http/`, `server/install/`, `server/observability/` — public origin,
  response types and request timeouts, install scripts, tracing, and Server-Timing.
- `server/inbox/` — the Activity inbox read model and its Done and read-all writes.
- `server/integrations/` — GitHub connection, configuration, and webhooks.
- `server/notifications/` — Web Push and in-page notification delivery.
- `server/profiles/` — user avatars.
- `server/projects/` — project settings, images, and repository file download.
- `server/records/` — Workspace Records (see the last section).
- `server/release-catalog/` — each app release's notes (en, zh-CN): the self-contained release catalog, its PostgreSQL store, and its REST contract (`/api/release-catalog/v1`), split-ready for its own service.
- `server/reminders/` — cloud Agent Reminders.
- `server/tasks/` — the message-backed TaskBoard, the shape a Task command must have, the Tasks page's overview reads, its Task view, history records, and notice wording.
- `server/workspace-memory/` — memory profiles, grounded offers, explicit task-requested four-role diagnosis, target-only Hint receipts and source ACL checks.
- `server/workspaces/` — Workspace catalog (name, icon and URL, with the former slugs that keep naming a Workspace), selection, enrollment, member roles, member directory, join links, admitting a member (`admitWorkspaceMember`, the one step a join link takes), one submitted server connection per Workspace, deleting a Workspace, removing its memory first and its stored files after, and going out of a Workspace (leaving or deleting it) to the next one.
