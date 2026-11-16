import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { PAGE_ASSET_MAX_BYTES } from "#src/features/artifacts/artifact-page-limits";
import { pageAccess, type PageReads, type PageViewerInput } from "./artifact-page-access.server";
import { sniffPageAsset } from "./artifact-page-asset-types.server";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";

export const PAGE_ASSET_MAX_COUNT = 200;
export const PAGE_ASSETS_MAX_BYTES = 256 * 1024 * 1024;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export type PageAssetView = { name: string; sizeBytes: number; contentType: string };

const invalid = (errorId: string): never => {
  throw new AppError("INVALID_INPUT", { errorId });
};

export const pageAssetName = (value: unknown): string =>
  typeof value === "string" && NAME.test(value) ? value : invalid("artifact-asset-name");

export class ArtifactPageAssets {
  constructor(
    private readonly db: PrismaClient,
    private readonly reads: PageReads,
    private readonly blobs: Pick<StoredArtifactBlobs, "put" | "use">,
  ) {}

  async list(input: PageViewerInput): Promise<PageAssetView[]> {
    await pageAccess(this.reads, input, "view");
    return this.db.artifactPageAsset.findMany({
      where: { artifactId: input.artifactId },
      select: { name: true, sizeBytes: true, contentType: true },
      orderBy: { name: "asc" },
    });
  }

  async upload(
    input: PageViewerInput & { name: unknown; bytes: Uint8Array<ArrayBuffer> },
  ): Promise<PageAssetView> {
    const name = pageAssetName(input.name);
    if (input.bytes.byteLength === 0) return invalid("artifact-asset-empty");
    if (input.bytes.byteLength > PAGE_ASSET_MAX_BYTES) return invalid("artifact-asset-too-large");
    const contentType = sniffPageAsset(input.bytes, name);
    if (!contentType) return invalid("artifact-asset-type");
    await pageAccess(this.reads, input, "interact");
    const blob = await this.blobs.put(input.workspaceId, input.bytes);
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`artifact-page-assets:${input.artifactId}`}, 0))`;
      const others = await tx.artifactPageAsset.aggregate({
        where: { artifactId: input.artifactId, name: { not: name } },
        _sum: { sizeBytes: true },
        _count: { _all: true },
      });
      if (
        others._count._all >= PAGE_ASSET_MAX_COUNT ||
        (others._sum.sizeBytes ?? 0) + blob.sizeBytes > PAGE_ASSETS_MAX_BYTES
      )
        return invalid("artifact-asset-full");
      if ((await this.blobs.use(tx, input.workspaceId, [blob.sha256])).length > 0)
        throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "artifact-asset-retry" });
      const row = {
        sha256: blob.sha256,
        sizeBytes: blob.sizeBytes,
        contentType,
        uploadedByUserId: input.userId,
      };
      await tx.artifactPageAsset.upsert({
        where: { artifactId_name: { artifactId: input.artifactId, name } },
        create: { artifactId: input.artifactId, name, ...row },
        update: { ...row, createdAt: new Date() },
      });
      return { name, sizeBytes: blob.sizeBytes, contentType };
    });
  }

  async delete(input: PageViewerInput & { name: unknown }): Promise<{ deleted: boolean }> {
    const name = pageAssetName(input.name);
    await pageAccess(this.reads, input, "admin");
    const { count } = await this.db.artifactPageAsset.deleteMany({
      where: { artifactId: input.artifactId, name },
    });
    return { deleted: count > 0 };
  }

  lookupByFileToken(artifactId: string, name: string) {
    return this.db.artifactPageAsset.findUnique({
      where: { artifactId_name: { artifactId, name } },
      select: { sha256: true, contentType: true },
    });
  }
}
