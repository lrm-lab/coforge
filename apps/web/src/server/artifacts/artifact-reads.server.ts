import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  artifactsDisabled,
  requireArtifactHome,
  type ArtifactActor,
} from "./artifact-access.server";

/** Versions one history page lists by default, and at most. */
const HISTORY_PAGE = 50;

/**
 * Reading artifacts (task #385): one version with its files, and the history, newest first. Both
 * ask the experiment, then the reader's access to the artifact's home, as every operation does.
 */
export class ArtifactReads {
  constructor(
    private readonly db: PrismaClient,
    private readonly enabled: (workspaceId: string) => Promise<boolean>,
  ) {}

  /** A live artifact the reader may read, with what a read shows of it. */
  async artifact(workspaceId: string, artifactId: string, reader: ArtifactActor) {
    if (!(await this.enabled(workspaceId))) throw artifactsDisabled();
    const artifact = await this.db.artifact.findFirst({
      where: { id: artifactId, workspaceId, deletedAt: null },
      select: {
        id: true,
        name: true,
        title: true,
        description: true,
        kind: true,
        entryPath: true,
        homeKey: true,
        currentVersion: true,
      },
    });
    if (!artifact) throw new AppError("NOT_FOUND");
    await requireArtifactHome(this.db, workspaceId, reader, artifact.homeKey, "read");
    return artifact;
  }

  /** The artifact and one version (its current one by default) with that version's files. */
  async read(input: {
    workspaceId: string;
    artifactId: string;
    reader: ArtifactActor;
    version?: number;
  }) {
    const artifact = await this.artifact(input.workspaceId, input.artifactId, input.reader);
    const number = input.version ?? artifact.currentVersion;
    if (number <= 0) return { artifact, version: null, files: [] };
    const version = await this.db.artifactVersion.findUnique({
      where: { artifactId_number: { artifactId: artifact.id, number } },
      select: {
        id: true,
        number: true,
        note: true,
        label: true,
        entryPath: true,
        title: true,
        description: true,
        merged: true,
        revertedFrom: true,
        createdAt: true,
      },
    });
    if (!version) throw new AppError("NOT_FOUND");
    const files = await this.db.artifactFile.findMany({
      where: { versionId: version.id },
      select: { path: true, sha256: true, sizeBytes: true, kind: true },
      orderBy: { path: "asc" },
    });
    return { artifact, version, files };
  }

  /**
   * The artifact's versions, newest first, `limit` (at most 50) at a time: `before` is the
   * previous page's `nextBefore`, and a null `nextBefore` is the last page.
   */
  async history(input: {
    workspaceId: string;
    artifactId: string;
    reader: ArtifactActor;
    limit?: number;
    before?: number;
  }) {
    const artifact = await this.artifact(input.workspaceId, input.artifactId, input.reader);
    const whole = (value: number | undefined) => value === undefined || Number.isSafeInteger(value);
    if (!whole(input.limit) || !whole(input.before))
      throw new AppError("INVALID_INPUT", { errorId: "artifact-history-page" });
    const limit = Math.min(Math.max(1, input.limit ?? HISTORY_PAGE), HISTORY_PAGE);
    const rows = await this.db.artifactVersion.findMany({
      where: {
        artifactId: artifact.id,
        ...(input.before !== undefined && { number: { lt: input.before } }),
      },
      orderBy: { number: "desc" },
      take: limit + 1,
      select: {
        number: true,
        publisherUserId: true,
        publisherAgentId: true,
        note: true,
        label: true,
        title: true,
        merged: true,
        revertedFrom: true,
        createdAt: true,
      },
    });
    const page = rows.slice(0, limit);
    return {
      versions: page.map(({ publisherUserId, publisherAgentId, ...version }) => ({
        ...version,
        publisher: publisherAgentId
          ? { agentId: publisherAgentId }
          : publisherUserId
            ? { userId: publisherUserId }
            : null,
      })),
      nextBefore: rows.length > limit ? page.at(-1)!.number : null,
    };
  }
}
