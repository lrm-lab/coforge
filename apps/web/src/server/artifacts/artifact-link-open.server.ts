import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import { AppError } from "#src/lib/app-error";
import type { ArtifactPathKind } from "#src/features/artifacts/artifact-path-kind";
import type { PublicArtifactMissGuard } from "./artifact-public-miss-guard.server";
import type { LinkLookup } from "./artifact-public-page.server";
import { artifactPageOrigin } from "./artifact-sandbox-config.server";

export type LinkOpened = {
  title: string;
  kind: ArtifactPathKind;
  url: string;
  version: number;
  updatedAt?: string;
};

export class ArtifactLinkOpen {
  constructor(
    private readonly deps: {
      perClient: AppRateLimit;
      perArtifact: AppRateLimit;
      lookup(artifactId: string): Promise<LinkLookup>;
      guard: PublicArtifactMissGuard;
      origin: string | null;
    },
  ) {}

  async open(input: { artifactId: string; client: string | undefined }): Promise<LinkOpened> {
    const { origin, guard, lookup, perClient, perArtifact } = this.deps;
    if (!origin) throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "artifact-sandbox-off" });
    const total = await perClient.admit(input.client ?? "unknown");
    if (!total.allowed) throw rateLimited(total.retryAfterSeconds);
    const refusal = await guard.refusal(input.client);
    if (refusal) throw rateLimited(refusal.retryAfterSeconds);
    const { shared, page } = await lookup(input.artifactId);
    if (!shared) await guard.miss(input.client);
    if (!page) throw new AppError("NOT_FOUND");
    const crowd = await perArtifact.admit(input.artifactId);
    if (!crowd.allowed) throw rateLimited(crowd.retryAfterSeconds);
    return {
      title: page.title,
      kind: page.kind,
      url: `${artifactPageOrigin(origin, input.artifactId)}/l`,
      version: page.version,
      ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}),
    };
  }
}

const rateLimited = (retryAfterSeconds: number) =>
  new AppError("RATE_LIMITED", { hint: `try again in ${retryAfterSeconds} seconds` });
