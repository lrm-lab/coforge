import type { AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";

import {
  ARTIFACT_AGENT_UPLOAD_LIMIT_PER_MINUTE as ARTIFACT_UPLOADS_PER_MINUTE,
  ARTIFACT_AGENT_WRITE_LIMIT_PER_MINUTE as ARTIFACT_WRITES_PER_MINUTE,
} from "#src/server/app-rate-limits/app-rate-limits-composition.server";
import { artifactRateLimitedResponse } from "./artifact-rate-limited-response.server";

const WINDOW_SECONDS = 60;

const WRITE_OPERATIONS: ReadonlySet<AgentArtifactRequest["operation"]> = new Set([
  "push",
  "comment",
  "review",
  "resolve",
  "reopen",
  "move",
  "delete",
  "save",
]);

export class ArtifactRateLimited extends Error {
  constructor(
    readonly operation: string,
    readonly retryAfterSeconds: number,
    readonly limit: number = ARTIFACT_WRITES_PER_MINUTE,
    readonly unit: string = "artifact writes",
  ) {
    super(`${unit} are rate limited`);
  }

  response(): Response {
    return artifactRateLimitedResponse({
      retryAfterSeconds: this.retryAfterSeconds,
      error: `rate limited (artifact-rate-limited): at most ${this.limit} ${this.unit} a minute per Agent; try again in ${this.retryAfterSeconds} seconds`,
      details: {
        operation: this.operation,
        limit: this.limit,
        windowSeconds: WINDOW_SECONDS,
      },
    });
  }
}

export async function admitArtifactWrite(
  limit: AppRateLimit | undefined,
  agentId: string,
  operation: AgentArtifactRequest["operation"],
): Promise<void> {
  if (!limit || !WRITE_OPERATIONS.has(operation)) return;
  const decision = await limit.admit(agentId);
  if (!decision.allowed) throw new ArtifactRateLimited(operation, decision.retryAfterSeconds);
}

export async function admitArtifactUpload(
  limit: AppRateLimit | undefined,
  agentId: string,
): Promise<void> {
  if (!limit) return;
  const decision = await limit.admit(agentId);
  if (!decision.allowed)
    throw new ArtifactRateLimited(
      "upload",
      decision.retryAfterSeconds,
      ARTIFACT_UPLOADS_PER_MINUTE,
      "artifact uploads",
    );
}
