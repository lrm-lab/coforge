import { HostJobError } from "./host-jobs.server";
import type { CloudComputer, CloudFleet, WorkspaceAccess } from "./host-jobs.server";

export async function resolveHostJobWorkspace(
  workspaces: WorkspaceAccess,
  workspaceId: string,
  userId: string,
): Promise<{ id: string; slug: string }> {
  const workspace = await workspaces.findMember(workspaceId, userId);
  if (!workspace) throw new HostJobError(403, "workspace access denied");
  return workspace;
}

export async function findActiveCloudComputer(
  fleet: CloudFleet,
  userId: string,
  computerId: string,
): Promise<CloudComputer> {
  const computer = (await fleet.list(userId)).find(
    (item) => item.id === computerId && item.deletedAt === null,
  );
  if (!computer) throw new HostJobError(404, "cloud computer not found");
  return computer;
}
