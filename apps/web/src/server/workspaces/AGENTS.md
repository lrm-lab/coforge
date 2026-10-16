# Workspace server modules

These rules apply to `src/server/workspaces/`.

- `deletion.server.ts` (`WorkspaceDeletion`) is the one flow that hard-deletes a
  Workspace. What it removes and when is [Workspace deletion](../../../../../docs/workspace-deletion.md);
  change that page with the flow.
- The owner and slug refusals happen before the first write. Removing the
  Workspace's memory (below) is the one step before the message batches, so a
  refused memory removal leaves every row of the Workspace as it was, though its
  OpenViking account may already be gone.
- Messages go in batches before the final transaction; they are what makes a
  large Workspace slow (one FK trigger per row per referencing table).
- Lock conversations first, then the Workspace row, then the conversations again:
  the order every writer takes (conversation lock, then a key naming the
  Workspace). Retry only on a PostgreSQL write conflict, through
  `server/db/write-conflict.server.ts`.
- Memory Offer citations and messages are deleted before the Workspace: they name
  rows the same cascade removes with `Restrict`. A new `Restrict` or `NO ACTION`
  reference into the Workspace's cascade goes there too, or the delete fails;
  `test/workspace-delete.integration.test.ts` lists every such key and fails on a
  new one.
- A Workspace with an OpenViking binding, or cleanup left unfinished, has its
  memory removed first (`WorkspaceMemoryRemoval`, production:
  `workspaceMemoryRemoval(db)`): the OpenViking account, then the binding, as the
  one cleanup operation `workspace-deletion`. A failed or already-leased removal
  refuses the delete with `TEMPORARILY_UNAVAILABLE` and error id
  `workspace-memory-removal-failed`; a binding found again under the locks does
  too. The cleanup rows go with the Workspace, settled or not.
- Stored files go after the answer (`WorkspaceFileCleanup`), never awaited by it.
- A flow that hard-deletes a Workspace calls
  `DaemonCredentialRevocations.recordForWorkspace(tx, workspaceId)` inside its
  transaction, before anything revokes or cascades the Workspace's daemon keys
  (only live keys are recorded), and logs the Workspace id with the count it
  returns. That record is the only way a Computer learns its Workspace is gone
  and parks the binding; without it the Computer retries forever. A soft delete
  that keeps the keys valid never parks a Computer.
- `create-workspace.server.ts` starts the account's default cloud computer for a
  Workspace, including after a Workspace is created, and binds that User's
  weekly-report assistant to it. A deployment without a cluster still returns
  the Workspace and leaves the assistant unconfigured.
- `server-connection.server.ts` stores one submitted connection per Workspace
  and builds the cloud computer service page: the install command and the
  system unit, neither of which carries a secret. The light is on only while
  that host's heartbeat is under 90 seconds old.
- `cloud-service-access.server.ts` checks the deployment operating password
  (`COFORGE_CLOUD_SERVICE_PASSWORD`) and seals a short-lived unlock cookie.
  The settings page withholds the install script until that cookie is valid.
- `host-bootstrap.server.ts` builds the manager install script. The cluster
  token is inside the file and is not shown on the page.

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
