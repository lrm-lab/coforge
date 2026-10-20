# Workspace platform assistant

Every Workspace has one platform assistant configuration. Each member sees a private
“通用助手” in Direct messages. Behind that entry, the member has a dedicated Agent,
conversation, native runtime sessions, API credentials, working directory and delegated
message read cursors. Other members, including Workspace admins, cannot read that chat
or migrate its files. Ordinary Agents retain their existing shared-session behavior.

The assistant receives a maintained platform playbook in addition to normal Agent
instructions. It discovers current commands through the built-in Manual. It can assist
with channels, messages, Tasks, reminders, Projects, Records, Agents, Computers and
platform settings. Operations use the questioner's current permissions; it does not
grant members admin privileges. External chat operations are posted as the member.
Private assistant replies remain in that member's assistant DM.

## Provisioning and upgrades

Apply migrations with the normal deployment command from `apps/web`:

```sh
bun run db:migrate:deploy
bun run scripts/backfill-workspace-assistants.ts
```

The backfill is repeatable and provisions all existing memberships in bounded pages.
It does not start a model session or move existing runtime history. New Workspace
creators get an assistant immediately. Existing and newly joined members also get
one when loading a Workspace or its Direct messages, covering a missed backfill.

The assistant uses the member's own live Computer linked to the Workspace. If none
exists, its first browser message requests the normal default cloud Computer.
An installation without cloud provisioning must first attach the member's Computer.
The Computer needs a configured Pi runtime/model, as for an ordinary Pi Agent.
Deploy the updated Web and Daemon together so the trusted assistant marker reaches
the runtime and enables the platform playbook.

## Sessions and permissions

Members can use normal Agent session/reset controls on their own assistant. Resetting
one person's session cannot reset anyone else's. Changing a member's Workspace role
changes assistant authority on the next operation. Removing membership invalidates
its command credentials immediately. Rejoining resumes the member's previous private
assistant; it does not create a second assistant.

The platform-owned assistant cannot be made public or deleted through ordinary Agent
controls. Native runtime sessions still follow the normal Computer/runtime ownership
rules. Migrations may target only another Computer owned by the same member.

## Verification

The PostgreSQL regressions run with `CHANNEL_TEST_DATABASE_URL` pointing to a
disposable database:

```sh
mise run test:file -- ./apps/web/test/workspace-assistant.integration.ts
mise run test:file -- ./packages/daemon/test/workspace-assistant-native.e2e.ts
```

The native runtime harness uses a deterministic local model endpoint and checks
separate IDs, prompt injection and persisted transcript resume. With a rebuilt,
restarted local Web, `DATABASE_URL`, `REDIS_URL` and `COFORGE_E2E_WEB_URL`, run:

```sh
mise run test:file -- ./apps/web/test/workspace-assistant.e2e.ts
```

This HTTP harness checks real Agent authentication, delegated commands and
membership revocation. It does not drive the browser or an external model turn.
For browser verification, follow the [testing guidance](agents/testing.md). Use two
members in a disposable Workspace: confirm each sees only their own assistant, send
distinct private markers, reload and resume each native session, and reset one while
confirming the other retains its context. Verify current-role permissions, revoked
credentials after leaving, new Workspace provisioning and repeatable old-member backfill.
Exercise channel commands, attachments, Tasks, search/read-around and consecutive message
checks without advancing the human's unread state.
