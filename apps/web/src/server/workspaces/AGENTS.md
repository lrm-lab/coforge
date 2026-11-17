# Workspace server modules

These rules apply to `src/server/workspaces/`.

- `deletion.server.ts` (`WorkspaceDeletion`) is the one flow that hard-deletes a
  Workspace. What it removes and when is [Workspace deletion](../../../../../docs/workspace-deletion.md);
  change that page with the flow.
- The owner and slug refusals happen before the first write.
- Messages go in batches before the final transaction; they are what makes a
  large Workspace slow (one FK trigger per row per referencing table).
- Lock in the Workspace-deletion order of `server/AGENTS.md` ("Lock order"). Retry only on a PostgreSQL write conflict, through
  `server/db/write-conflict.server.ts`.
- Messages are deleted before the Workspace: they name
  rows the same cascade removes with `Restrict`. A new `Restrict` or `NO ACTION`
  reference into the Workspace's cascade goes there too, or the delete fails;
  `test/workspace-delete.integration.test.ts` lists every such key and fails on a
  new one.
- Native team memory, versions and request/review receipts cascade with the Workspace, and so do
  the retired memory tables' rows; deletion calls no external memory service.
- Stored files go after the answer (`WorkspaceFileCleanup`), never awaited by it.
- A flow that hard-deletes a Workspace calls
  `DaemonCredentialRevocations.recordForWorkspace(tx, workspaceId)` inside its
  transaction, before anything revokes or cascades the Workspace's daemon keys
  (only live keys are recorded), and logs the Workspace id with the count it
  returns. That record is the only way a Computer learns its Workspace is gone
  and parks the binding; without it the Computer retries forever. A soft delete
  that keeps the keys valid never parks a Computer.
- Leaving a Workspace and being removed from it are one store write,
  `PrismaWorkspaceMemberDirectoryStore.removeMember`, the only place a
  membership row is deleted (a Workspace or User delete cascades it). In the
  same transaction it calls `unlinkDepartingMemberComputers`
  (`server/computers/computer-membership.server.ts`): the person's live daemon
  keys for that Workspace are recorded as `computer_unlinked` and revoked, and
  their Computers' links to it removed; their keys and links for every other
  Workspace stay. After the commit `WorkspaceMemberDirectory` reconnects those
  daemons, best effort, so each parks its binding now. A new path that ends a
  membership goes through that store write. `removalComputers`/`leaveComputers`
  preview the same Computer set for the confirmation dialogs, under the same
  authority checks; account deletion must run
  `unlinkDepartingMemberComputers` for every Workspace before the User row
  cascades, or the Computers never learn their binding is gone.
- `create-workspace.server.ts` starts the account's default cloud computer for a
  Workspace, including after a Workspace is created, and binds that User's
  weekly-report assistant to it. A deployment without a cluster still returns
  the Workspace and leaves the assistant unconfigured.
- `resource-recovery.server.ts` repairs missing platform-assistant and weekly-report resources
  when the owner opens a Workspace. A GET loader never starts the assistant; a missed Start
  waits for the Daemon's ready recovery.
- Read [`hosts/AGENTS.md`](../hosts/AGENTS.md) when changing the cloud computer service page, its operating-password unlock, or the manager install script (`server-connection`, `cloud-service-access`, `host-bootstrap`).

## Role capabilities

- What a Workspace role may do lives in one table, `WORKSPACE_CAPABILITY_ROLES`
  (`src/features/workspaces/workspace-roles.ts`). Server checks answer from it
  through `roleCan` (directly or via the named helpers built on it), and the
  person panel's role help reads the same table. To change who may do
  something, change the table; to add a role-gated action, add a capability,
  never a new role comparison. `test/workspace-capabilities.test.ts` checks
  that every listed helper and the help agree with it.
- Rules that need more than the role stay with their owners and do not go in
  the table: leaving (never the owner), a channel admin's own channel, and an
  Agent's creator (private-Agent visibility, visibility changes, cancelling
  its action cards).
- `workspace-onboarding.server.ts` holds who welcomes new members (`onboardingMode`: `assistant`,
  `agent` or `off`, with `onboardingAgentId`) and the new-Agent `#general` greeting flag. The chosen
  Agent must be live, public and ordinary (`onboardingAgentWhere`). A change that makes it ineligible
  (archive, private) calls `clearOnboardingAgent` in its own transaction; a hard delete is covered by
  the FK and the `workspace_onboarding_agent_removed` trigger, and `workspaces_onboarding_check`
  holds `agent` exactly when an Agent is set. `admitWorkspaceMember` reads the mode once and records
  it for the person's own assistant as `WorkspaceMembership.assistantWelcome` (true only under
  `assistant`; a Workspace creator and earlier members keep true). In `agent` mode it writes the
  welcome request in the join's transaction (`requestMemberWelcome`: the DM, a system message of kind
  `member.welcome_requested` and the Agent's delivery); the join link caller publishes it after the
  commit (`publishMemberWelcome`, best effort, the delivery row keeps it for an offline Agent).
