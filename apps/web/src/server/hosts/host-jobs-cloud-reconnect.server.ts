import { CLOUD_RECONNECT_IDEMPOTENCY_PREFIX } from "./host-job-record.server";
import { HostJobError } from "./host-jobs.server";
import type {
  CloudComputerView,
  ClusterJobs,
  DaemonKeys,
  CloudFleet,
  WorkspaceAccess,
} from "./host-jobs.server";
import { buildHostJobRecord, cloudComputerView } from "./host-job-record.server";
import { findActiveCloudComputer, resolveHostJobWorkspace } from "./host-jobs-workspace.server";

/**
 * Queues a fresh attach for one linked, running cloud Computer whose binding the cloud refused.
 * Unlike ensureDefault this does not skip the home Workspace: the refused binding needs the new
 * credential regardless of which Workspace created the computer. The host's attach path writes
 * the credential and reconfigures the binding, which stops the parked child and starts a fresh
 * one that migrates to a computer key and connects.
 */
export async function reconnectCloudHostJob(
  deps: {
    workspaces: WorkspaceAccess;
    fleet: CloudFleet;
    jobs: ClusterJobs;
    cluster: { id(): Promise<string> };
    keys: DaemonKeys;
  },
  input: {
    userId: string;
    workspaceId: string;
    computerId: string;
    now: Date;
  },
): Promise<CloudComputerView> {
  const workspace = await resolveHostJobWorkspace(deps.workspaces, input.workspaceId, input.userId);
  const computer = await findActiveCloudComputer(deps.fleet, input.userId, input.computerId);
  if (!computer.containerReady)
    throw new HostJobError(409, "cloud computer has no running container");
  if (!(await deps.fleet.isLinked(computer.id, workspace.id)))
    throw new HostJobError(404, "cloud computer is not linked to this workspace");
  const open = await deps.jobs.findOpenAttach(computer.id, workspace.id);
  if (open) return cloudComputerView(computer, open.id);
  const daemonApiKey = await deps.keys.issue({
    userId: input.userId,
    workspaceId: workspace.id,
    computerId: computer.id,
  });
  const job = buildHostJobRecord({
    clusterId: await deps.cluster.id(),
    operation: "attach",
    workspace,
    computer,
    ownerId: input.userId,
    idempotencyKey: `${CLOUD_RECONNECT_IDEMPOTENCY_PREFIX}${computer.id}:${workspace.id}:${input.now.getTime()}`,
    daemonApiKey,
    now: input.now,
  });
  await deps.jobs.insert(job);
  return cloudComputerView(computer, job.id);
}
