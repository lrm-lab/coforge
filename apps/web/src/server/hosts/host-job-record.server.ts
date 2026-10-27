import type {
  CloudComputer,
  CloudComputerView,
  HostJobOperation,
  HostJobRecord,
} from "./host-jobs.server";

export function cloudComputerView(
  computer: CloudComputer,
  jobId: string | null,
): CloudComputerView {
  return {
    computerId: computer.id,
    slot: computer.slot,
    name: computer.name,
    containerReady: computer.containerReady,
    jobId,
  };
}

export function buildHostJobRecord(input: {
  clusterId: string;
  operation: HostJobOperation;
  workspace: { id: string; slug: string };
  computer: CloudComputer;
  ownerId: string;
  idempotencyKey: string;
  daemonApiKey: string | null;
  now: Date;
  /** For a runtime upgrade, the release to install. Stored in the job name. */
  releaseVersion?: string;
}): HostJobRecord {
  return {
    id: crypto.randomUUID(),
    clusterId: input.clusterId,
    operation: input.operation,
    workspaceId: input.workspace.id,
    workspaceSlug: input.workspace.slug,
    computerId: input.computer.id,
    ownerId: input.ownerId,
    idempotencyKey: input.idempotencyKey,
    name: input.releaseVersion ?? input.computer.name,
    daemonApiKey: input.daemonApiKey,
    containerId: null,
    createdAt: input.now,
    reportedAt: null,
  };
}
