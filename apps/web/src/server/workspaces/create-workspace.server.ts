import { HostDirectoryError } from "#src/server/hosts/host-directory.server";
import type { WorkspaceRecord } from "#src/server/workspaces/catalog.server";

/** The default cloud computer id in a start result. Anything else, including an
 * extra computer, is not a default to bind. */
export function defaultCloudComputerId(started: unknown): string | undefined {
  if (!started || typeof started !== "object") return undefined;
  if (!("slot" in started) || !("computerId" in started)) return undefined;
  const { slot, computerId } = started;
  if (slot !== "default" || typeof computerId !== "string" || computerId.length === 0)
    return undefined;
  return computerId;
}

/** Starts the account's default cloud computer for a Workspace. A deployment
 * without a cluster does nothing and returns undefined. */
export async function startDefaultCloudComputer(
  start: (input: { userId: string; workspaceId: string; now: Date }) => Promise<unknown>,
  input: { userId: string; workspaceId: string; now: Date },
): Promise<unknown> {
  try {
    return await start(input);
  } catch (error) {
    if (error instanceof HostDirectoryError && error.status === 503) return undefined;
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
    bindWeeklyReportAssistant?: (input: {
      userId: string;
      workspaceId: string;
      computerId: string;
    }) => Promise<unknown>;
  },
  input: { userId: string; name: string; slug: string; now: Date },
): Promise<WorkspaceRecord> {
  const workspace = await deps.createWorkspace(input.userId, {
    name: input.name,
    slug: input.slug,
  });
  const started = await startDefaultCloudComputer(deps.startCloudComputer, {
    userId: input.userId,
    workspaceId: workspace.id,
    now: input.now,
  });
  const computerId = defaultCloudComputerId(started);
  if (computerId)
    await deps.bindWeeklyReportAssistant?.({
      userId: input.userId,
      workspaceId: workspace.id,
      computerId,
    });
  return workspace;
}
