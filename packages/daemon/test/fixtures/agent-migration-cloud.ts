import {
  AgentMigrationRemoteError,
  type AgentMigrationBucket,
  type AgentMigrationServer,
  type AgentMigrationState,
  type AgentMigrationView,
} from "#src/agent-migration/transfer-ports";
import type { AgentMigrationBundleManifest } from "#src/agent-migration/bundle-writer";

/**
 * The server's side of one migration, shared by both Computers: the fenced state machine the
 * route enforces (each step from its role, at the revision it read) and the steps and failures
 * each Computer reported, in order. `faults` makes the next calls of an operation fail.
 */
export function cloud({
  migrationId = "migration-1",
  sourceComputerId = "computer-a",
  targetComputerId = "computer-b",
  urlPrefix = "chunk",
}: {
  migrationId?: string;
  sourceComputerId?: string;
  targetComputerId?: string;
  urlPrefix?: string;
} = {}) {
  const agentId = "agent-1";
  const record = {
    state: "requested" as AgentMigrationState,
    revision: 0,
    generation: 1,
    manifest: null as AgentMigrationBundleManifest | null,
  };
  const reports: string[] = [];
  const details: (string | undefined)[] = [];
  const objects = new Map<string, Uint8Array>();
  const faults: Record<string, AgentMigrationRemoteError[]> = {};
  const fault = (operation: string) => {
    const error = faults[operation]?.shift();
    if (error) throw error;
  };
  let failUploads = false;
  const advance = (
    expectedRevision: number,
    from: AgentMigrationState,
    to: AgentMigrationState,
  ) => {
    if (record.state === to) return { status: "already_applied" as const };
    if (record.state !== from || record.revision !== expectedRevision)
      throw new AgentMigrationRemoteError("invalid_transition", false);
    record.state = to;
    record.revision++;
    return { status: "advanced" as const };
  };
  const described = () => ({
    id: migrationId,
    state: record.state,
    generation: record.generation,
    revision: record.revision,
  });
  const serverFor = (role: "source" | "target"): AgentMigrationServer => ({
    view: async (): Promise<AgentMigrationView> => {
      fault("view");
      return {
        migration: {
          ...described(),
          agentId,
          role,
          sourceComputerId,
          targetComputerId,
        },
        manifest: record.manifest,
      };
    },
    step: async (input) => {
      reports.push(`${role}:${input.step}`);
      fault(input.step);
      const from: Record<string, AgentMigrationState> = {
        source_stopped: "requested",
        placement_started: "uploaded",
        switch: "placing",
        arrived: "switched",
      };
      const to: Record<string, AgentMigrationState> = {
        source_stopped: "source_stopped",
        placement_started: "placing",
        switch: "switched",
        arrived: "completed",
      };
      return {
        ...advance(input.expectedRevision, from[input.step]!, to[input.step]!),
        migration: described(),
      };
    },
    uploadUrl: async (input) => ({ url: `${urlPrefix}/${input.chunk.index}`, headers: {} }),
    downloadUrl: async (input) => ({ url: `${urlPrefix}/${input.index}` }),
    completeUpload: async (input) => {
      reports.push(`${role}:upload_complete`);
      const result = advance(input.expectedRevision, "source_stopped", "uploaded");
      record.manifest = input.manifest;
      return { ...result, migration: described() };
    },
    fail: async (input) => {
      reports.push(`${role}:fail:${input.errorCode}`);
      details.push(input.errorDetail);
      record.state = "failed";
      record.revision++;
      return { status: "failed", migration: described() };
    },
  });
  const bucket: AgentMigrationBucket = {
    put: async (signed, bytes) => {
      if (failUploads) throw new AgentMigrationRemoteError("bucket_refused", false, "403");
      objects.set(signed.url, bytes);
    },
    get: async (url) => {
      const object = objects.get(url);
      if (!object) throw new AgentMigrationRemoteError("bucket_unavailable", true, "404");
      return object;
    },
  };
  return {
    record,
    reports,
    details,
    faults,
    serverFor,
    bucket,
    refuseUploads: () => {
      failUploads = true;
    },
  };
}
