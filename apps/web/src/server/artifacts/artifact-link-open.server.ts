import { AppError } from "#src/lib/app-error";
import type { ArtifactPathKind } from "#src/features/artifacts/artifact-path-kind";
import type { PublicArtifactMissGuard } from "./artifact-public-miss-guard.server";
import type { LinkLookup } from "./artifact-public-page.server";
import { artifactPageOrigin } from "./artifact-sandbox-config.server";

export type LinkOpened = { title: string; kind: ArtifactPathKind; url: string };

export class ArtifactLinkOpen {
  constructor(
    private readonly deps: {
      lookup(artifactId: string): Promise<LinkLookup>;
      guard: PublicArtifactMissGuard;
      origin: string | null;
    },
  ) {}

  async open(input: { artifactId: string; client: string | undefined }): Promise<LinkOpened> {
    const { origin, guard, lookup } = this.deps;
    if (!origin) throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "artifact-sandbox-off" });
    const refusal = await guard.refusal(input.client);
    if (refusal)
      throw new AppError("RATE_LIMITED", {
        hint: `try again in ${refusal.retryAfterSeconds} seconds`,
      });
    const { shared, page } = await lookup(input.artifactId);
    if (!shared) await guard.miss(input.client);
    if (!page) throw new AppError("NOT_FOUND");
    return {
      title: page.title,
      kind: page.kind,
      url: `${artifactPageOrigin(origin, input.artifactId)}/l`,
    };
  }
}
