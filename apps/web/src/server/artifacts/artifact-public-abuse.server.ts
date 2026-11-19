import { AppError } from "#src/lib/app-error";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import type { LinkLookup } from "./artifact-public-page.server";

export const ARTIFACT_ABUSE_REASONS = [
  "spam",
  "phishing",
  "harassment",
  "copyright",
  "other",
] as const;

export type ArtifactAbuseReason = (typeof ARTIFACT_ABUSE_REASONS)[number];

export type ArtifactAbuseLog = {
  event: "artifacts:abuse_report";
  artifactId: string;
  workspaceId: string;
  reason: ArtifactAbuseReason;
  details: string;
};

export class ArtifactAbuseReporter {
  constructor(
    private readonly deps: {
      perClient: AppRateLimit;
      lookup(artifactId: string): Promise<LinkLookup>;
      onReport?: (entry: ArtifactAbuseLog) => void;
    },
  ) {}

  async submit(input: {
    artifactId: string;
    reason: ArtifactAbuseReason;
    details?: string | undefined;
    client: string | undefined;
  }): Promise<{ ok: true }> {
    const admitted = await this.deps.perClient.admit(input.client ?? "unknown");
    if (!admitted.allowed) {
      throw new AppError("RATE_LIMITED", {
        hint: `try again in ${admitted.retryAfterSeconds} seconds`,
      });
    }
    const { page } = await this.deps.lookup(input.artifactId);
    if (!page) throw new AppError("NOT_FOUND");
    const entry: ArtifactAbuseLog = {
      event: "artifacts:abuse_report",
      artifactId: page.artifactId,
      workspaceId: page.workspaceId,
      reason: input.reason,
      details: (input.details ?? "").trim().slice(0, 1000),
    };
    if (this.deps.onReport) this.deps.onReport(entry);
    else console.warn(JSON.stringify(entry));
    return { ok: true };
  }
}
