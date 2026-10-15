import type { AgentMigrationBundleManifest } from "./bundle-writer";

/**
 * The two remote parties a migration's transfer talks to, as ports. The server
 * (`connection/agent-migration-http-client.ts`, over the Web route `/api/daemon/agent-migrations`)
 * reports this Computer's view of the migration, rules on its steps and failures, and signs a URL
 * per chunk. The bucket (`connection/agent-migration-bucket-client.ts`) moves a chunk's bytes by
 * that URL; bytes never go through the server. Both report a failure as an
 * `AgentMigrationRemoteError` that says whether asking again may succeed.
 */

export type AgentMigrationState =
  | "requested"
  | "source_stopped"
  | "uploaded"
  | "placing"
  | "switched"
  | "completed"
  | "canceled"
  | "failed";

export type AgentMigrationStep = "source_stopped" | "placement_started" | "switch" | "arrived";

export type AgentMigrationView = {
  migration: {
    id: string;
    agentId: string;
    role: "source" | "target";
    state: AgentMigrationState;
    generation: number;
    revision: number;
    sourceComputerId: string;
    targetComputerId: string;
  };
  manifest: AgentMigrationBundleManifest | null;
};

/** A step the server applied, or one that had already landed (a retry whose reply was lost). */
export type AgentMigrationStepResult = {
  status: "advanced" | "already_applied" | "failed";
  migration: { id: string; state: AgentMigrationState; generation: number; revision: number };
};

type Attempt = { migrationId: string; generation: number };

export type AgentMigrationChunkEntry = AgentMigrationBundleManifest["chunks"][number];

/** A presigned request: its URL and the exact headers it was signed with. */
export type AgentMigrationSignedUrl = { url: string; headers: Record<string, string> };

export interface AgentMigrationServer {
  view(migrationId: string, signal?: AbortSignal): Promise<AgentMigrationView>;
  step(
    input: Attempt & { expectedRevision: number; step: AgentMigrationStep },
  ): Promise<AgentMigrationStepResult>;
  uploadUrl(
    input: Attempt & { chunk: AgentMigrationChunkEntry },
    signal?: AbortSignal,
  ): Promise<AgentMigrationSignedUrl>;
  downloadUrl(input: Attempt & { index: number }, signal?: AbortSignal): Promise<{ url: string }>;
  completeUpload(
    input: Attempt & { expectedRevision: number; manifest: AgentMigrationBundleManifest },
  ): Promise<AgentMigrationStepResult>;
  /** `errorCode` is a short snake_case code; a longer `errorDetail` is cut to fit the route. */
  fail(
    input: Attempt & { errorCode: string; errorDetail?: string },
  ): Promise<AgentMigrationStepResult>;
}

export interface AgentMigrationBucket {
  /** Stores one chunk; a bucket that already holds it (overwrite refused) has it, which is done. */
  put(signed: AgentMigrationSignedUrl, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /** Fetches one chunk, refusing an answer that is not `sizeBytes` long before reading it. */
  get(url: string, sizeBytes: number, signal: AbortSignal): Promise<Uint8Array>;
}

/**
 * A remote party refused or could not be reached. `code` names why (`stale_revision`,
 * `unavailable`, `bucket_refused`, `size_mismatch`, `network`); a transfer asks again only when
 * `retryable`. An abort is not one of these: it surfaces as the abort itself.
 */
export class AgentMigrationRemoteError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    detail = "",
  ) {
    super(
      `Agent migration ${retryable ? "transient failure" : "refusal"}: ${code}${detail ? ` (${detail})` : ""}`,
    );
    this.name = "AgentMigrationRemoteError";
  }
}
