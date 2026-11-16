import { AppError } from "#src/lib/app-error";
import { artifactKindOfPath } from "#src/features/artifacts/artifact-path-kind";
import { levelReaches, type PageLevel } from "#src/features/artifacts/artifact-page-levels";
import type { ArtifactReads } from "./artifact-reads.server";

export type PageViewerInput = { workspaceId: string; artifactId: string; userId: string };

export type PageReads = Pick<ArtifactReads, "artifact">;

export type PageAccess = {
  level: PageLevel;
  homeKey: string | null;
  authorAgentOwnerId: string | null;
};

export const pageLevelOf = (
  artifact: { canChange: boolean; authorAgentOwnerId: string | null },
  userId: string,
): PageLevel =>
  artifact.authorAgentOwnerId === userId ? "owner" : artifact.canChange ? "admin" : "interact";

export async function pageAccess(
  reads: PageReads,
  input: PageViewerInput,
  need: PageLevel,
): Promise<PageAccess> {
  const artifact = await reads.artifact(input.workspaceId, input.artifactId, {
    userId: input.userId,
  });
  if (artifactKindOfPath(artifact.entryPath) !== "html") throw new AppError("NOT_FOUND");
  const level = pageLevelOf(artifact, input.userId);
  if (!levelReaches(level, need))
    throw new AppError("ACCESS_DENIED", { errorId: "artifact-page-level" });
  return { level, homeKey: artifact.homeKey, authorAgentOwnerId: artifact.authorAgentOwnerId };
}
