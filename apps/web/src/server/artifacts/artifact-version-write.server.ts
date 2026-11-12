import type { Prisma } from "#src/generated/prisma/client";
import type { ArtifactActor } from "./artifact-access.server";
import type { ArtifactFileInput, ArtifactFileRow } from "./artifact-files.server";
import type { ArtifactSettingName, ArtifactSettings } from "./artifact-merge.server";

/**
 * Stores a push's new version in the caller's transaction: the version row with what it changed
 * and merged, the full file list it holds, and the artifact's current version, entry and settings
 * moved to it. The caller has decided everything (`Artifacts.push`) and holds the artifact's row.
 */
export async function writeVersion(
  tx: Prisma.TransactionClient,
  input: {
    artifactId: string;
    number: number;
    publisher: ArtifactActor;
    note?: string;
    label?: string;
    settings: ArtifactSettings;
    added: readonly ArtifactFileInput[];
    deleted: readonly string[];
    /** What came from others: files (by path) and settings (by name), for the history. */
    merged: { files: readonly string[]; settings: readonly ArtifactSettingName[] };
    idempotencyKey: string;
    revertedFrom?: number;
    files: Iterable<ArtifactFileRow>;
  },
) {
  const { artifactId, settings } = input;
  const { entryPath, title, description } = settings;
  const version = await tx.artifactVersion.create({
    data: {
      artifactId,
      number: input.number,
      ...(input.publisher.agentId
        ? { publisherAgentId: input.publisher.agentId, publisherUserId: null }
        : { publisherUserId: input.publisher.userId ?? null, publisherAgentId: null }),
      note: input.note ?? "",
      label: input.label ?? "",
      entryPath,
      title,
      description,
      changedPaths: {
        added: input.added.map((file) => file.path),
        deleted: [...input.deleted],
      } satisfies Prisma.InputJsonObject,
      ...((input.merged.files.length || input.merged.settings.length) && {
        merged: {
          files: [...input.merged.files],
          settings: [...input.merged.settings],
        } satisfies Prisma.InputJsonObject,
      }),
      idempotencyKey: input.idempotencyKey,
      revertedFrom: input.revertedFrom ?? null,
    },
    select: { id: true, number: true },
  });
  await tx.artifactFile.createMany({
    data: [...input.files].map((file) => ({
      versionId: version.id,
      artifactId,
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      kind: file.kind,
    })),
  });
  await tx.artifact.update({
    where: { id: artifactId },
    data: { currentVersion: version.number, entryPath, title, description },
  });
  return version;
}
