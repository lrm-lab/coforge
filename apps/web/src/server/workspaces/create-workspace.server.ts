import { HostDirectoryError } from "#src/server/hosts/host-directory.server";
import type { WorkspaceRecord } from "#src/server/workspaces/catalog.server";

/** Starts the account's default cloud computer for a Workspace. A deployment
 * without a cluster does nothing. */
export async function startDefaultCloudComputer(
  start: (input: { userId: string; workspaceId: string; now: Date }) => Promise<unknown>,
  input: { userId: string; workspaceId: string; now: Date },
): Promise<void> {
  try {
    await start(input);
  } catch (error) {
    if (error instanceof HostDirectoryError && error.status === 503) return;
    throw error;
  }
}

/** Creates the Workspace, then starts its default cloud computer. A deployment
 * without a cluster still returns the Workspace. */
export async function createWorkspaceAndStartCloudComputer(
  deps: {
    createWorkspace: (
      userId: string,
      input: { name: string; slug: string },
    ) => Promise<WorkspaceRecord>;
    startCloudComputer: (input: {
      userId: string;
      workspaceId: string;
      now: Date;
    }) => Promise<unknown>;
  },
  input: { userId: string; name: string; slug: string; now: Date },
): Promise<WorkspaceRecord> {
  const workspace = await deps.createWorkspace(input.userId, {
    name: input.name,
    slug: input.slug,
  });
  await startDefaultCloudComputer(deps.startCloudComputer, {
    userId: input.userId,
    workspaceId: workspace.id,
    now: input.now,
  });
  return workspace;
}
