import { HostJobError } from "./host-jobs.server";
import type { CloudComputerView, ClusterJobs } from "./host-jobs.server";
import { buildHostJobRecord, cloudComputerView } from "./host-job-record.server";
import { findActiveCloudComputer, resolveHostJobWorkspace } from "./host-jobs-workspace.server";
import type { CloudFleet, WorkspaceAccess } from "./host-jobs.server";

function requireRuntimeVersion(value: string): string {
  const text = value.trim();
  if (!text || text.length > 200 || /[\r\n]/.test(text))
    throw new HostJobError(422, "invalid runtime version");
  return text;
}

/** Installs a published coforge-computer onto the computer's volume, then restarts it. */
export async function requestCloudRuntimeHostJob(
  deps: {
    workspaces: WorkspaceAccess;
    fleet: CloudFleet;
    jobs: ClusterJobs;
    cluster: { id(): Promise<string> };
  },
  input: {
    userId: string;
    workspaceId: string;
    computerId: string;
    version: string;
    now: Date;
  },
): Promise<CloudComputerView> {
  const workspace = await resolveHostJobWorkspace(deps.workspaces, input.workspaceId, input.userId);
  const computer = await findActiveCloudComputer(deps.fleet, input.userId, input.computerId);
  const version = requireRuntimeVersion(input.version);
  const key = `cloud-runtime:${computer.id}:${version}`;
  const existing = await deps.jobs.findByIdempotency(input.userId, key);
  if (existing) return cloudComputerView(computer, existing.id);
  const clusterId = await deps.cluster.id();
  const job = buildHostJobRecord({
    clusterId,
    operation: "runtime",
    workspace,
    computer,
    ownerId: input.userId,
    idempotencyKey: key,
    daemonApiKey: null,
    now: input.now,
    releaseVersion: version,
  });
  await deps.jobs.insert(job);
  return cloudComputerView(computer, job.id);
}
